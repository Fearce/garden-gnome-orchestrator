// One-shot post-bounce / nightly quality probe for garden-gnome orchestrator.
// Read-only. Safe while prod is up (WAL + busy_timeout). Does NOT restart anything.
//
//   npm run health --prefix server
//   node scripts/nightly-health.cjs
//   node scripts/nightly-health.cjs --base http://127.0.0.1:4317
//
// What a resume-after-orchestrator-bounce agent needs in one command:
//   • /api/health up?
//   • restart coordinator reachable, and is it idle / draining / retrying?
//   • is the running process on the code in dist? Compared by BUILD COMMIT, the
//     process reports which build it loaded (`build` on /api/health), and, when
//     that differs from dist, by whether any server/src content actually changed
//     between the two (see scripts/process-vs-dist.cjs). A process too old to
//     carry the stamp falls back to the dist-mtime-vs-listener-start heuristic,
//     which only warns when RUNTIME server/src mtimes ALSO moved after start
//     (src/tests + src/tools excluded, see scripts/src-mtime.cjs).
//     BUT that heuristic, and dist itself, only mean something when the process
//     actually LOADS dist (see scripts/listener-shape.cjs). A process running
//     TypeScript source directly under tsx (`npm run serve` -> supervise.cjs,
//     CLAUDE.md's "supervisor" deployment shape) is also unstamped, and for
//     that shape dist is irrelevant: the check instead compares server/src
//     mtimes directly against the process start.
//   • reliability symbols still present in dist (office/Grok QA path)?
//   • git dirty files (concurrent teammate WIP — leave alone unless yours)
//   • thread/run health from SQLite (caps, parks, stuck runs)
//
// Exit: 0 = service healthy + required dist symbols present.
//       1 = hard fail (unreachable, or a required symbol missing from dist).
// Dirty tree / review backlog are reported but do NOT fail the exit code.

const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const Database = require("better-sqlite3");
const { classifyProcessBuild } = require("./process-vs-dist.cjs");
const { classifyDistVsHead } = require("./dist-vs-head.cjs");
const { classifyListenerShape } = require("./listener-shape.cjs");
const { newestSrcMtimeMs, srcFilesNewerThan } = require("./src-mtime.cjs");
const { serverRuntimeDiff, readWebStamp, webDistState } = require("./compiled-diff.cjs");
const { classifyRun, CLASSES: RUN_CLASSES } = require("./probe-run-errors.cjs");
const { classifyPark, classifyAbandoned, recoveryLineFor, lastRun, isDeadEndLine } = require("./probe-parks.cjs");
const { scanCrashLog } = require("./crashlog-scan.cjs");
const { inspectAccountUsage } = require("./account-usage-health.cjs");
const { inspectRestartCoordinator } = require("./restart-coordinator-health.cjs");
const { checkHubStopReach, unreachableRemedy, commandLineOf } = require("./hub-stop-reach.cjs");

const args = process.argv.slice(2);
function flag(name) {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

const BASE = (flag("--base") || "http://127.0.0.1:4317").replace(/\/$/, "");
const ROOT = path.resolve(__dirname, "..", "..");
const SERVER = path.resolve(__dirname, "..");
const DIST = path.join(SERVER, "dist");
const DB_PATH = path.join(SERVER, "data", "orchestrator.sqlite");

/** Symbols that must exist in built dist after the 2026-07-20 Grok office/QA hardening. */
const REQUIRED_SYMBOLS = [
  { file: "agents/officeBridge.js", re: /isJunkOfficeBody|endsWithOpenOfficeMarker/ },
  { file: "agents/grokRunner.js", re: /emitInitIfNeeded|openEnded/ },
  { file: "orchestrator/threadManager.js", re: /latestQaRun|markRunning/ },
];

let hardFail = false;
const notes = [];

function section(title) {
  console.log(`\n=== ${title} ===`);
}

function ok(msg) {
  console.log(`  ✓ ${msg}`);
}

function warn(msg) {
  console.log(`  ⚠ ${msg}`);
  notes.push(msg);
}

function fail(msg) {
  console.log(`  ✗ ${msg}`);
  hardFail = true;
}

function winListener(port) {
  try {
    const out = execFileSync("netstat", ["-ano"], { encoding: "utf8", windowsHide: true });
    const re = new RegExp(`TCP\\s+\\S+:${port}\\s+\\S+\\s+LISTENING\\s+(\\d+)`, "i");
    const m = out.match(re);
    return m ? Number(m[1]) : null;
  } catch {
    return null;
  }
}

/**
 * Whether `dist` was built from current HEAD's server code — the gap the process-vs-dist check cannot see.
 * Both of those can agree perfectly while `dist` ITSELF predates HEAD, which is how a feature shipped its
 * web half and sat in prod for a day with its server half unbuilt (the director Stop button, 2026-07-29:
 * the button rendered, and the WS command it sent wasn't in the server's union).
 *
 * The pure classification lives in `dist-vs-head.cjs` (gated by `test:dist-vs-head`) so its wording
 * contract — the "stale" detail states only the fact THIS check owns, never a liveness verdict about the
 * running process, which it never even reads — can be pinned. See that module's header for why: on
 * 2026-09-11 the old inline version baked "that committed change is NOT live, however fresh the process
 * looks" into this detail unconditionally, which a source-run process (tsx under `npm run serve`, no dist
 * at all) inherited anyway, misreporting a live commit (`b26fdaa`) as undeployed. The liveness clause is
 * now composed by the caller below, gated on the listener's confirmed shape.
 *
 * Returns { state, detail } where state is "current" | "stale" | "unknown" | "dirty-build".
 */
function distVsHead() {
  const stampFile = path.join(DIST, ".build-info.json");
  let stamp = null;
  try {
    stamp = JSON.parse(fs.readFileSync(stampFile, "utf8"));
  } catch {
    stamp = null;
  }
  // Two-dot, direction-agnostic, tests/tools excluded — see `scripts/compiled-diff.cjs`, which is the
  // single implementation this and `deploy.cjs --verify` both read.
  const changedFiles = stamp && stamp.commit ? serverRuntimeDiff(stamp.commit, "HEAD") : null;
  return classifyDistVsHead({ distStamp: stamp, changedFiles });
}

/** `server/src` files whose content differs between two commits, or null if git cannot compare them.
 *  Tests and tools are excluded for the same reason `distVsHead` excludes them: they never run in the
 *  server, so a committed test would report a perfectly deployed process as drifted.
 *
 *  Shared with `deploy.cjs --verify`, which asks the identical question and used to answer it by
 *  comparing raw commit ids — calling a docs-only commit "NOT running" and inviting a restart that
 *  tree-kills every in-flight agent. One implementation, one gate (`test:compiled-diff`). */
const serverSrcDiff = serverRuntimeDiff;

/** Whether the live process is running the code now in `dist` — see scripts/process-vs-dist.cjs. */
function processVsDist(runningBuild) {
  let dist = null;
  try {
    dist = JSON.parse(fs.readFileSync(path.join(DIST, ".build-info.json"), "utf8"));
  } catch {
    /* classifyProcessBuild reports the missing stamp */
  }
  const comparable = runningBuild && runningBuild.commit && dist && dist.commit && runningBuild.commit !== dist.commit;
  return classifyProcessBuild({
    running: runningBuild,
    dist,
    changedFiles: comparable ? serverSrcDiff(runningBuild.commit, dist.commit) : null,
  });
}

/**
 * A staged build the restart coordinator is already holding is NOT an operator action item.
 *
 * `classifyProcessBuild` only compares the running build to `dist`, so a drain-waiting deploy looks
 * identical to a forgotten one. A stale-build warning must not send an operator around the coordinator:
 * that bypass tree-kills every live agent — the exact interruption the coordinator exists to prevent, and
 * the reflex `deploy.cjs`/AGENTS.md warn against. So ask the coordinator before advising.
 *
 * Returns the public status response, or an error string. Callers must never treat an unreadable
 * coordinator as proof that no restart is staged.
 */
async function readRestartCoordinator() {
  try {
    const res = await fetch(`${BASE}/api/deploy/status`, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return { status: null, error: `HTTP ${res.status}` };
    return { status: await res.json(), error: null };
  } catch (error) {
    return { status: null, error: error && error.message ? error.message : String(error) };
  }
}

function processStartMs(pid) {
  if (!pid) return null;
  try {
    const out = execFileSync(
      "powershell",
      [
        "-NoProfile",
        "-Command",
        `(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToUniversalTime().ToString('o')`,
      ],
      { encoding: "utf8", windowsHide: true },
    ).trim();
    const t = Date.parse(out);
    return Number.isFinite(t) ? t : null;
  } catch {
    return null;
  }
}

/** Name WHY each non-done run in the window ended, so a sweep reads reasons instead of raw counts. */
function reportNonDoneReasons(db, since) {
  const rows = db
    .prepare(
      `SELECT role, state, error, num_turns FROM agent_runs
       WHERE started_at > ? AND state IN ('error','interrupted')`,
    )
    .all(since);
  if (!rows.length) return;

  const tally = new Map();
  for (const r of rows) {
    const key = classifyRun(r);
    tally.set(key, (tally.get(key) ?? 0) + 1);
  }
  const named = RUN_CLASSES.filter((c) => tally.has(c.key));
  console.log(`  non-done reasons: ${named.map((c) => `${tally.get(c.key)} ${c.key}`).join(", ")}`);

  const unexpected = named.filter((c) => c.human);
  const count = unexpected.reduce((n, c) => n + tally.get(c.key), 0);
  if (count) {
    warn(
      `${count} of ${rows.length} non-done run(s) are NOT an expected outcome (${unexpected
        .map((c) => c.key)
        .join(", ")}) — triage with: npm run probe:run-errors --prefix server`,
    );
  } else {
    ok(`all ${rows.length} non-done run(s) are expected outcomes (cutoff / cap / retry / restart)`);
  }
}

async function main() {
  // ---- 1) HTTP health ----
  section(`health ${BASE}`);
  let runningBuild = null;
  try {
    const res = await fetch(`${BASE}/api/health`);
    if (!res.ok) fail(`GET /api/health → HTTP ${res.status}`);
    else {
      const healthJson = await res.json();
      if (healthJson.ok) ok(`ok models=${JSON.stringify(healthJson.models || {})}`);
      else fail(`health.ok is not true: ${JSON.stringify(healthJson)}`);
      runningBuild = healthJson.build || null;
    }
  } catch (e) {
    fail(`GET /api/health failed: ${e && e.message ? e.message : e}`);
  }

  try {
    const res = await fetch(`${BASE}/api/version`);
    if (res.ok) {
      const v = await res.json();
      ok(`web asset ${v.web || JSON.stringify(v)}`);
    }
  } catch {
    /* version is optional */
  }

  let restartStatus = null;
  const restartRead = await readRestartCoordinator();
  if (!restartRead.status) {
    warn(`restart coordinator status unavailable: ${restartRead.error}`);
  } else {
    const reading = inspectRestartCoordinator(restartRead.status);
    if (reading.valid) restartStatus = restartRead.status;
    if (reading.level === "warn") warn(reading.message);
    else ok(reading.message);
  }

  // ---- 2) Listener PID + start vs dist mtime ----
  section("process vs dist");
  const pid = winListener(4317);
  let stopReach = null;
  let listenerShape = "unknown";
  if (!pid) warn("no LISTEN on :4317 (netstat), service may be down or non-Windows probe");
  else {
    ok(`:4317 LISTEN pid=${pid}`);
    const startMs = processStartMs(pid);
    if (startMs) ok(`process started ${new Date(startMs).toISOString()}`);
    // Confirmed from the LISTENER's own command line, never guessed: see scripts/listener-shape.cjs
    // for why (a source-run process is unstamped too, so `runningBuild` alone cannot tell it apart
    // from a pre-stamp-era dist process).
    listenerShape = classifyListenerShape(commandLineOf(pid));

    // Can the hub STOP this process, or only SEE it? Asked every sweep, not only when a restart is
    // already stuck: a matcher that stops matching is invisible from every other angle, the hub still
    // reports the script running (portMatchers), the coordinator still stages builds, and nothing goes
    // red until a deploy has been silently refused for days. Unknown is never green.
    stopReach = await checkHubStopReach({ pid });
    if (stopReach.state === "reachable") ok(`script-hub can stop this process (matched ${stopReach.matched})`);
    else if (stopReach.state === "unreachable") fail(unreachableRemedy(stopReach));
    else warn(`script-hub stop reach unproven: ${stopReach.reason}, a planned deploy may be refused`);

    const sampleDist = path.join(DIST, "agents", "grokRunner.js");
    if (fs.existsSync(sampleDist)) {
      const distMs = fs.statSync(sampleDist).mtimeMs;
      ok(`dist/agents/grokRunner.js mtime ${new Date(distMs).toISOString()}`);

      // 2026-09-11: on a machine running `npm run serve` (CLAUDE.md's "supervisor" deployment shape,
      // scripts/supervise.cjs -> tsx loading src/index.ts directly), this process never reads dist at
      // all, so every dist-mtime comparison below describes a build it never opened. Say so plainly,
      // once, instead of leaving the reader to rediscover the process tree by hand, which is what the
      // 2026-09-11 misread of commit b26fdaa cost.
      if (listenerShape === "source") {
        ok(
          "process runs from SOURCE under tsx (server/scripts/supervise.cjs -> node <tsx> src/index.ts, " +
            "not server/dist), confirmed from its own command line. Every dist mtime below describes a " +
            "build this process never reads",
        );
      }

      // The process reports the build it loaded, so this is a comparison rather than an inference. Only a
      // process too old to carry that stamp falls back to the mtimes below.
      const vsDist = processVsDist(runningBuild);
      if (vsDist.state === "stale") {
        // A coordinated bounce is already owed for this dist. Report it as the finished state `deploy
        // --verify` reports (it exits 0 here), not as "go restart it by hand" — see above.
        // Re-read only when the first snapshot had no pending restart: a deploy may have staged one
        // while this probe was comparing the process and dist.
        let staged = restartStatus && restartStatus.pending ? restartStatus : null;
        if (!staged) {
          const latest = await readRestartCoordinator();
          const reading = latest.status ? inspectRestartCoordinator(latest.status) : null;
          if (reading?.valid && latest.status.pending) staged = latest.status;
        }
        const failures = staged && staged.pending ? staged.pending.failures || 0 : 0;
        if (staged && failures === 0) {
          ok(
            `process vs dist: the built change is not live yet, but the restart coordinator owns the bounce ` +
              `(${staged.pendingLabel}; ${staged.pending.requesters.length} staged build(s)) — it fires at zero ` +
              `active work. Do NOT restart by hand; that would tree-kill the active agents`,
          );
        } else if (staged) {
          // Pending but the restart mechanism keeps refusing — that IS an operator action item.
          // Never guess the cause here. This line used to read "the listener is probably elevated",
          // which on 2026-09-11 sent the reader past the real one: the entry's processMatchers had
          // stopped matching the live command line, so every stop killed nothing. The reach check
          // above has already MEASURED it, so say what it found.
          const cause =
            stopReach && stopReach.state === "unreachable"
              ? unreachableRemedy(stopReach)
              : stopReach && stopReach.state === "reachable"
                ? "the hub CAN reach this process, so the refusals are not a matcher miss — check whether the listener is elevated (CLAUDE.md) or the hub's process enumeration is degraded"
                : `the cause is unmeasured (${stopReach ? stopReach.reason : "no reach check ran"}) — run \`node scripts/hub-stop-reach.cjs ${pid}\``;
          warn(
            `${vsDist.detail} — the restart coordinator has ` +
              `staged it but ${failures} restart attempt(s) were REFUSED (${staged.pendingLabel}). ${cause}`,
          );
        } else warn(`${vsDist.detail}. Run \`npm run deploy --prefix server\`; it routes the bounce through the restart coordinator.`);
      } else if (vsDist.state === "dirty-build" || vsDist.state === "unknown") warn(`process vs dist: ${vsDist.detail}`);
      else if (vsDist.state === "current") ok(`process vs dist: ${vsDist.detail}`);
      else if (listenerShape === "source") {
        // Unstamped AND confirmed source-run: the dist-mtime heuristic below means nothing for this
        // process (see the note above it). The only honest liveness signal left is server/src mtime
        // against the process's own start, tsx read whatever bytes sat on disk the moment it imported
        // each file, so a file touched on disk after that instant is not what is running.
        if (startMs) {
          const drifted = srcFilesNewerThan(startMs);
          if (drifted.length) {
            const shown = drifted
              .slice(0, 3)
              .map((f) => f.path)
              .join(", ");
            warn(
              `${drifted.length} server/src runtime file(s) changed on disk AFTER this process started ` +
                `(${shown}${drifted.length > 3 ? ", …" : ""}), so their on-disk content is not what tsx is ` +
                "running, whatever HEAD says. A `git checkout` rewrites mtimes wholesale, so on a freshly " +
                "checked out tree treat this as corroborating evidence, not proof. Remedy: " +
                "`npm run deploy --prefix server` (on this shape the coordinated bounce is a clean exit " +
                "that scripts/supervise.cjs respawns immediately onto current disk contents).",
            );
          } else {
            ok(
              `no server/src runtime file changed on disk since the process started ${new Date(startMs).toISOString()}, the running source matches disk`,
            );
          }
        } else {
          warn("process runs from source but its start time could not be read, server/src drift cannot be checked against it");
        }
      } else if (startMs && distMs > startMs + 2000) {
        const srcMs = newestSrcMtimeMs();
        if (srcMs && srcMs > startMs + 2000) {
          warn(
            `${vsDist.detail}; dist is NEWER than the running process start AND server/src changed after start — possibly a stale build. Confirm before restarting: a content-free rebuild and a same-bytes file touch both look like this`,
          );
        } else {
          ok(
            `dist rebuilt after process start but no server/src change since (newest src ${srcMs ? new Date(srcMs).toISOString() : "unknown"}) — scripts/docs-only rebuild, no runtime drift, no restart needed`,
          );
        }
      } else if (startMs && startMs >= distMs - 5000) {
        ok("process started at/after dist mtime (fresh build likely loaded)");
      }
      // The gap the process-vs-dist comparison above cannot see: dist itself behind HEAD. This is a
      // fact about the BUILD, not about what is live; the liveness clause is only ever added below,
      // and only once the listener shape confirms the running process actually reads dist (see
      // dist-vs-head.cjs's header for the 2026-09-11 incident this split exists to prevent).
      const vsHead = distVsHead();
      if (vsHead.state === "stale") {
        if (listenerShape === "dist") {
          warn(
            `${vsHead.detail}, that committed change is NOT live, however fresh the process looks. Run ` +
              "`npm run deploy --prefix server`; it builds HEAD and routes the bounce through the restart coordinator.",
          );
        } else if (listenerShape === "source") {
          warn(
            `${vsHead.detail}. This process does not load dist at all (runs from source under tsx), so ` +
              "this is only a fact about the BUILD, not about what is live here, see the server/src " +
              "check above for that. Still worth rebuilding before any future dist-based deploy: " +
              "`npm run deploy --prefix server`.",
          );
        } else {
          warn(
            `${vsHead.detail}. Whether that change is live cannot be confirmed here (the running ` +
              "process's shape could not be determined from its command line). Run `npm run deploy " +
              "--prefix server` to be safe.",
          );
        }
      } else ok(`dist vs HEAD: ${vsHead.detail}`);
      // And the half a restart cannot fix. The 2026-07-29 incident this whole section exists for was a
      // feature shipping its two halves separately; the check written afterwards only watched the server,
      // so the same split in the other direction stayed invisible until the web build got its own stamp.
      const webVsHead = webDistState(readWebStamp(), "HEAD");
      if (webVsHead.state === "stale") {
        warn(`${webVsHead.detail} — that committed change is NOT in the served bundle. Run \`npm run build --prefix web\` and reload; web/dist is static, so no restart ships it.`);
      } else ok(`web/dist vs HEAD: ${webVsHead.detail}`);
    } else {
      fail(`missing ${sampleDist}`);
    }
  }

  // ---- 3) Required dist symbols ----
  section("dist symbols (Grok office + QA path)");
  for (const { file, re } of REQUIRED_SYMBOLS) {
    const p = path.join(DIST, file);
    if (!fs.existsSync(p)) {
      fail(`missing ${file}`);
      continue;
    }
    const text = fs.readFileSync(p, "utf8");
    if (re.test(text)) ok(`${file} matches ${re}`);
    else fail(`${file} missing pattern ${re}`);
  }

  // ---- 4) Git dirty (concurrent WIP) ----
  section("git (leave concurrent WIP alone)");
  try {
    const branch = execFileSync("git", ["status", "-sb"], {
      cwd: ROOT,
      encoding: "utf8",
      windowsHide: true,
    })
      .trim()
      .split("\n")[0];
    ok(branch || "(no branch line)");
    const porcelain = execFileSync("git", ["status", "--porcelain"], {
      cwd: ROOT,
      encoding: "utf8",
      windowsHide: true,
    })
      .trim()
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
    if (!porcelain.length) ok("working tree clean");
    else {
      warn(`${porcelain.length} dirty path(s) — concurrent agent WIP? do not git add -A`);
      for (const line of porcelain.slice(0, 25)) console.log(`    ${line}`);
      if (porcelain.length > 25) console.log(`    … +${porcelain.length - 25} more`);
    }
  } catch (e) {
    warn(`git status failed: ${e && e.message ? e.message : e}`);
  }

  // ---- 5) SQLite operational snapshot ----
  section("sqlite (last 24h)");
  if (!fs.existsSync(DB_PATH)) {
    warn(`no DB at ${DB_PATH}`);
  } else {
    try {
      const db = new Database(DB_PATH, { readonly: true });
      db.pragma("busy_timeout = 5000");
      const since = Date.now() - 24 * 3600 * 1000;

      const byState = db.prepare("SELECT state, count(*) c FROM threads GROUP BY state ORDER BY c DESC").all();
      console.log("  threads by state:", Object.fromEntries(byState.map((r) => [r.state, r.c])));

      const runs = db
        .prepare("SELECT state, count(*) c FROM agent_runs WHERE started_at > ? GROUP BY state")
        .all(since);
      console.log("  runs 24h:", Object.fromEntries(runs.map((r) => [r.state, r.c])));

      // A healthy process and SQLite file do not prove that the account pings have produced a meter
      // reading. The original all-dash FleetView incident passed every earlier health line, so inspect
      // the same persisted snapshots `probe:accounts` reads and name every missing/stale dimension.
      const accountUsage = inspectAccountUsage(
        db.prepare("SELECT key, value FROM kv WHERE key LIKE 'account_usage_%' ORDER BY key").all(),
      );
      if (accountUsage.issues.length) warn(`account usage: ${accountUsage.issues.join("; ")}`);
      else ok(`${accountUsage.records.length} account usage reading(s) fresh and complete`);

      const stuck = db
        .prepare(
          `SELECT id, role, account, started_at FROM agent_runs
           WHERE state='running' AND started_at < ?
           ORDER BY started_at ASC LIMIT 10`,
        )
        .all(Date.now() - 2 * 3600 * 1000);
      if (stuck.length) warn(`${stuck.length} run(s) stuck >2h in state=running`);
      else ok("no runs stuck >2h");

      const caps = db
        .prepare(
          `SELECT count(*) c FROM agent_runs
           WHERE started_at > ? AND error LIKE '%weekly limit%'`,
        )
        .get(since);
      if (caps?.c) warn(`${caps.c} run(s) hit weekly limit in last 24h (failover expected)`);
      else ok("no weekly-limit errors in last 24h");

      // Review-state parks, classified by `classifyPark` (shared with probe-parks.cjs, so the two can
      // never disagree about what counts as stuck):
      //   • capWait — the cap supervisor (resumeCapParked, every ~capRetryMs/2m) SHOULD unpark it once
      //     any backend frees up. One sitting for hours means a persistent full cap wave OR a wedged
      //     supervisor — worth a human glance, so warn past a 2h threshold.
      //   • stalled — QA, an auto-review or a resume stopped mid-verification. Nothing will come back
      //     for it on its own, so it's a warn; a QA one is split by whether one of its recovery budgets
      //     (a turn-ceiling continuation or an empty-run retry) was genuinely SPENT, which says the
      //     mechanism ran and gave up rather than the reason being unread. Both count, via
      //     `isDeadEndLine` — knowing only the continuations left an empty-run dead end reported as an
      //     unread reason. That split defers to `recoveryLineFor` rather than testing the park wording
      //     directly: a park PREDATING the per-review allowance (748633a) carries the spent marker but was
      //     never actually woken — earlier unrelated reviews had drained the task-wide budget — so the
      //     wording alone reported three recoverable tasks as dead ends here for as long as this line
      //     asked `continuationsSpent` itself. Reusing the probe's precedence is what keeps the sweep's
      //     step 1 and step 4 from giving opposite verdicts on the same task.
      //   • verdict — the pipeline finished and is asking the owner to decide. By design, never a warn.
      //   • unknown — a park message no class recognizes, i.e. the classification has drifted from
      //     threadManager's wording. Warn, because a silent demotion here hides a stalled task.
      const reviewRows = db.prepare("SELECT id, error, updated_at FROM threads WHERE state='review'").all();
      const STALE_PARK_MS = 2 * 3600 * 1000;
      const parks = { capWait: 0, stalled: 0, verdict: 0, unknown: 0 };
      let staleAutoResume = 0;
      let qaDeadEnds = 0;
      let oldestAutoResumeH = 0;
      for (const r of reviewRows) {
        const key = classifyPark(r.error).key;
        parks[key]++;
        if (key === "capWait") {
          const ageMs = Date.now() - r.updated_at;
          if (ageMs > STALE_PARK_MS) staleAutoResume++;
          const ageH = ageMs / 3600000;
          if (ageH > oldestAutoResumeH) oldestAutoResumeH = ageH;
        } else if (key === "stalled" && isDeadEndLine(recoveryLineFor(key, r.error, lastRun(db, r.id)))) {
          qaDeadEnds++;
        }
      }
      const NAME_THEM = "name them with: npm run probe:parks --prefix server";
      if (staleAutoResume) {
        warn(
          `${staleAutoResume} of ${parks.capWait} auto-resume-pending park(s) have sat >2h (oldest ${oldestAutoResumeH.toFixed(1)}h) — supervisor should unpark within ~2m of a backend freeing up; a persistent one means every backend is still capped OR resumeCapParked is wedged (check the cap supervisor)`,
        );
      } else if (parks.capWait) {
        ok(`${parks.capWait} auto-resume-pending park(s) (oldest ${oldestAutoResumeH.toFixed(1)}h) — within normal supervisor window`);
      }
      if (parks.stalled) {
        const spent = qaDeadEnds ? `, ${qaDeadEnds} after a QA recovery budget was spent (mechanism ran, reviewer still couldn't finish)` : "";
        warn(`${parks.stalled} thread(s) parked mid-pipeline — QA/auto-review/resume couldn't finish${spent}; ${NAME_THEM}`);
      }
      if (parks.unknown) warn(`${parks.unknown} park(s) with text no class recognizes — ${NAME_THEM}`);
      if (parks.verdict) ok(`${parks.verdict} park(s) awaiting your verdict by design, not stuck`);

      // `review` isn't the only state waiting on a person: a restart's casualties land in `failed`, and no
      // sweep step read that state until 2026-08-10 — a task still claiming "auto-resuming…" is one whose
      // promised resume died with the process that made it, so it is a warn, not a count.
      const lost = { promised: 0, clickResume: 0, otherFailure: 0 };
      for (const r of db.prepare("SELECT error FROM threads WHERE state='failed'").all()) lost[classifyAbandoned(r.error).key]++;
      if (lost.promised) warn(`${lost.promised} abandoned thread(s) still promising an auto-resume that never arrived — ${NAME_THEM}`);
      if (lost.otherFailure) warn(`${lost.otherFailure} failed thread(s) with text no class recognizes — ${NAME_THEM}`);
      if (lost.clickResume) ok(`${lost.clickResume} restart casualt(ies) handed back for a Resume click, not stuck`);

      // What this looks for is the CLI office BRIDGE truncating an agent's claim mid-word ("claimi") or
      // posting a bare "\n" — a defect that only exists on agent chat. `scope='directors'` is the room for
      // the PEOPLE running the consoles, where "LOL" and "hallå" are ordinary human messages, so counting
      // it warned every night the owner typed a short line (4 such rows on 2026-09-10) and trained the
      // reader to skim a warn that is supposed to mean a real extractor bug.
      const junkChat = db
        .prepare(
          `SELECT count(*) c FROM chat_messages
           WHERE created_at > ? AND COALESCE(scope, '') <> 'directors'
             AND (body = '\\n' OR body = 'claimi' OR length(body) BETWEEN 1 AND 6)`,
        )
        .get(since);
      if (junkChat?.c) warn(`${junkChat.c} suspicious short/junk office chat body(ies) in 24h`);
      else ok("no obvious junk office bodies in 24h");

      // The `runs 24h` line above is a COUNT, and counts made a sweep read four benign turn-ceiling cutoffs
      // as four crashes (2026-07-25) — the same trap the review-park classification above exists for. Name
      // the reason instead, using probe-run-errors.cjs's classifier so the two can never disagree. Runs LAST
      // in this block so a throw here can't skip the checks above it.
      reportNonDoneReasons(db, since);

      db.close();
    } catch (e) {
      warn(`sqlite probe failed: ${e && e.message ? e.message : e}`);
    }
  }

  // ---- 6) Crash log — real faults vs the benign lifecycle notes the guards also write here ----
  // Until this section, a green `health` said nothing about crash.log content; a sweep had to `tail`
  // it and eyeball "only memory high-water notes". crashlog-scan.cjs splits faults (an
  // unhandledRejection/uncaughtException label, or any entry carrying a stack frame) from the
  // lifecycle notes (high-water, pressure warnings, signals, exit, Node warnings) the same file holds.
  section("crash log (last 24h)");
  const crashLogPath = path.join(SERVER, "data", "crash.log");
  if (!fs.existsSync(crashLogPath)) {
    ok(`no crash.log yet (clean process — no faults recorded)`);
  } else {
    try {
      const text = fs.readFileSync(crashLogPath, "utf8");
      const { faults, lifecycle } = scanCrashLog(text, Date.now() - 24 * 3600 * 1000);
      if (faults.length) {
        const recent = faults.reduce((a, b) => (a.ts != null && (b.ts == null || b.ts > a.ts) ? b : a));
        const when = recent.ts != null ? new Date(recent.ts).toISOString() : "undated";
        warn(
          `${faults.length} fault entry(ies) in crash.log in last 24h — most recent: ${recent.label} at ${when}; \`tail server/data/crash.log\` for the stack`,
        );
      } else {
        const lcLine =
          Object.entries(lifecycle)
            .filter(([, n]) => n)
            .map(([k, n]) => `${n} ${k}`)
            .join(", ") || "none";
        ok(`no fault entries in last 24h (lifecycle notes: ${lcLine})`);
      }
      // Memory-pressure warnings predict an OOM without being a crash yet — surface them so a sweep
      // watches the trend rather than waiting for the first real fault.
      if (lifecycle["memory pressure"]) {
        warn(
          `${lifecycle["memory pressure"]} memory-pressure warning(s) in last 24h — heap approached the V8 ceiling; an OOM was predicted (not a crash yet, but watch it)`,
        );
      }
    } catch (e) {
      warn(`crash.log scan failed: ${e && e.message ? e.message : e}`);
    }
  }

  // ---- summary ----
  section("summary");
  if (hardFail) {
    console.log("FAIL — service down or dist missing required symbols.");
    process.exit(1);
  }
  if (notes.length) {
    console.log("OK (with notes):");
    for (const n of notes) console.log(`  - ${n}`);
  } else {
    console.log("OK — healthy, dist symbols present, no operational notes.");
  }
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
