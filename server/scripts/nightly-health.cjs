// One-shot post-bounce / nightly quality probe for garden-gnome orchestrator.
// Read-only. Safe while prod is up (WAL + busy_timeout). Does NOT restart anything.
//
//   npm run health --prefix server
//   node scripts/nightly-health.cjs
//   node scripts/nightly-health.cjs --base http://127.0.0.1:4317
//
// What a resume-after-orchestrator-bounce agent needs in one command:
//   • /api/health up?
//   • is the running process on the code in dist? Compared by BUILD COMMIT — the
//     process reports which build it loaded (`build` on /api/health) — and, when
//     that differs from dist, by whether any server/src content actually changed
//     between the two (see scripts/process-vs-dist.cjs). A process too old to
//     carry the stamp falls back to the dist-mtime-vs-listener-start heuristic,
//     which only warns when RUNTIME server/src mtimes ALSO moved after start
//     (src/tests + src/tools excluded — see newestSrcMtimeMs).
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
const { serverRuntimeDiff } = require("./compiled-diff.cjs");
const { classifyRun, CLASSES: RUN_CLASSES } = require("./probe-run-errors.cjs");
const { classifyPark, classifyAbandoned, recoveryLineFor, lastRun, isDeadEndLine } = require("./probe-parks.cjs");
const { scanCrashLog } = require("./crashlog-scan.cjs");
const { inspectAccountUsage } = require("./account-usage-health.cjs");

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
    const out = execFileSync("netstat", ["-ano"], { encoding: "utf8" });
    const re = new RegExp(`TCP\\s+\\S+:${port}\\s+\\S+\\s+LISTENING\\s+(\\d+)`, "i");
    const m = out.match(re);
    return m ? Number(m[1]) : null;
  } catch {
    return null;
  }
}

/**
 * Newest mtime among compiled RUNTIME sources under server/src. Used to tell a
 * real stale-build (runtime server/src changed after the process started) apart
 * from a benign rebuild (dist mtimes bump on any `npm run build` even when no
 * runtime code changed). Tests (`src/tests/`, `*.test.ts`, `*.itest.ts`) and
 * agent tooling (`src/tools/`, the tsx-run probes) are excluded: neither is
 * loaded by the running server, but an edit to one after boot (a StubAccounts
 * fake following a feature, a probe added while tuning it) would otherwise trip
 * the "real stale build" warning as a false positive every nightly sweep.
 * Returns null if src is unreadable.
 */
function newestSrcMtimeMs() {
  const srcDir = path.join(SERVER, "src");
  let newest = 0;
  const walk = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name === "tests" || e.name === "tools") continue;
        walk(full);
      } else if (e.isFile() && /\.(ts|tsx|mts|cts)$/.test(e.name) && !/\.(test|itest)\.(ts|tsx|mts|cts)$/.test(e.name)) {
        const m = fs.statSync(full).mtimeMs;
        if (m > newest) newest = m;
      }
    }
  };
  walk(srcDir);
  return newest || null;
}

/**
 * Whether `dist` was built from current HEAD's server code — the gap the process-vs-dist check cannot see.
 * Both of those can agree perfectly while `dist` ITSELF predates HEAD, which is how a feature shipped its
 * web half and sat in prod for a day with its server half unbuilt (the director Stop button, 2026-07-29:
 * the button rendered, and the WS command it sent wasn't in the server's union).
 *
 * Compared by CONTENT, never by timestamp: build → verify → commit is the normal order, so a dist a minute
 * older than HEAD is usually correct, and mtimes are rewritten wholesale by a checkout. The build stamps the
 * commit it came from (scripts/stamp-build.cjs); the only question that matters is whether anything under
 * server/src changed between that commit and HEAD.
 *
 * Returns { state, detail } where state is "current" | "stale" | "unknown" | "dirty-build".
 */
function distVsHead() {
  const stampFile = path.join(DIST, ".build-info.json");
  let stamp;
  try {
    stamp = JSON.parse(fs.readFileSync(stampFile, "utf8"));
  } catch {
    return { state: "unknown", detail: "dist has no .build-info.json — built before build stamping, or by a bare `tsc`" };
  }
  if (!stamp.commit) return { state: "unknown", detail: "the build recorded no commit (no git at build time)" };
  const short = String(stamp.commit).slice(0, 8);
  // Two-dot, direction-agnostic, tests/tools excluded — see `scripts/compiled-diff.cjs`, which is the
  // single implementation this and `deploy.cjs --verify` both read.
  const files = serverRuntimeDiff(stamp.commit, "HEAD");
  if (files === null) {
    return { state: "unknown", detail: `git cannot compare the built commit ${short} to HEAD (unreachable after a rebase?)` };
  }
  if (files.length) {
    return {
      state: "stale",
      detail:
        `dist was built from ${short}, and ${files.length} server/src file(s) have changed in HEAD since ` +
        `(${files.slice(0, 3).join(", ")}${files.length > 3 ? ", …" : ""}) — that committed change is NOT live, ` +
        "however fresh the process looks. Run `npm run build`, then the atomic hub restart.",
    };
  }
  if (stamp.dirty) {
    return {
      state: "dirty-build",
      detail: `dist matches HEAD's server/src (built from ${short}) but was built from a DIRTY tree — it may carry uncommitted code`,
    };
  }
  return { state: "current", detail: `dist was built from ${short}, whose server/src matches HEAD` };
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
      { encoding: "utf8" },
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

  // ---- 2) Listener PID + start vs dist mtime ----
  section("process vs dist");
  const pid = winListener(4317);
  if (!pid) warn("no LISTEN on :4317 (netstat) — service may be down or non-Windows probe");
  else {
    ok(`:4317 LISTEN pid=${pid}`);
    const startMs = processStartMs(pid);
    if (startMs) ok(`process started ${new Date(startMs).toISOString()}`);

    const sampleDist = path.join(DIST, "agents", "grokRunner.js");
    if (fs.existsSync(sampleDist)) {
      const distMs = fs.statSync(sampleDist).mtimeMs;
      ok(`dist/agents/grokRunner.js mtime ${new Date(distMs).toISOString()}`);

      // The process reports the build it loaded, so this is a comparison rather than an inference. Only a
      // process too old to carry that stamp falls back to the mtimes below.
      const vsDist = processVsDist(runningBuild);
      if (vsDist.state === "stale") warn(vsDist.detail);
      else if (vsDist.state === "dirty-build" || vsDist.state === "unknown") warn(`process vs dist: ${vsDist.detail}`);
      else if (vsDist.state === "current") ok(`process vs dist: ${vsDist.detail}`);
      else if (startMs && distMs > startMs + 2000) {
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
      // The gap the process-vs-dist comparison above cannot see: dist itself behind HEAD.
      const vsHead = distVsHead();
      if (vsHead.state === "stale") warn(vsHead.detail);
      else ok(`dist vs HEAD: ${vsHead.detail}`);
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
    })
      .trim()
      .split("\n")[0];
    ok(branch || "(no branch line)");
    const porcelain = execFileSync("git", ["status", "--porcelain"], {
      cwd: ROOT,
      encoding: "utf8",
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

      const junkChat = db
        .prepare(
          `SELECT count(*) c FROM chat_messages
           WHERE created_at > ? AND (body = '\\n' OR body = 'claimi' OR length(body) BETWEEN 1 AND 6)`,
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
