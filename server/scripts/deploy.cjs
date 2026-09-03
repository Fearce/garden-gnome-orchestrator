// Deploy this checkout to the running orchestrator — pick the right build, restart, verify.
//
//   npm run deploy --prefix server            build + atomic restart + verify
//   npm run deploy --prefix server -- --plan  print the decision and exit (safe, touches nothing)
//   npm run deploy --prefix server -- --verify  only check what is live (for the auto-resumed session)
//
// Why this exists. `npm run build` compiles the WORKING TREE, and this checkout is shared by every
// implementor the orchestrator spawns — so the same two commands are right or catastrophic depending on
// `git status` at that moment. Deploy your fix while a sibling has half a runner rewritten and their
// un-QA'd code goes live under your name; run the slow HEAD-only recipe on a clean tree and you have
// spent ten tool calls and a `node_modules`-deleting footgun for nothing. Both mistakes happened on
// 2026-08-24: a QA agent's plain rebuild swept another task's uncommitted bridge into `dist`, and the
// same task ran the archive recipe by hand four times, twice needlessly.
//
// The rule is not "is the tree dirty" — it is "is anything that COMPILES INTO dist dirty". A dirty
// `server/scripts/*.cjs`, a doc, or a lab file cannot reach `dist`, so they must not cost the slow path.
// That predicate is `server/src` + `tsconfig.json`, deliberately the same one `stamp-build.cjs` records
// as `dirty`, so the stamp and this decision can never disagree.
//
// You are usually a child process of :4317, so the restart KILLS YOU. That is the designed flow (the
// rebooted server auto-resumes in-flight tasks): everything worth reading is printed BEFORE the restart
// is issued, and the resumed session finishes with `-- --verify`.
//
// The restart is REQUESTED from the running orchestrator's deploy gate, not issued to the script-hub
// directly. While the owner has more than one task running, the gate collapses agent restarts to one an
// hour and fires the held one itself — so `dist` still ships immediately, and several tasks each landing
// a patch cost the owner one interruption instead of one per patch. A held deploy prints "restart HELD"
// and exits 0: it is finished work, not a failure, and `--verify` says the same afterwards.
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { liveness } = require("./compiled-diff.cjs");

const SERVER_DIR = path.resolve(__dirname, "..");
const REPO = path.resolve(SERVER_DIR, "..");
const DIST = path.join(SERVER_DIR, "dist");
const NODE_MODULES = path.join(SERVER_DIR, "node_modules");

const HUB_URL = (process.env.SCRIPT_HUB_URL || "http://127.0.0.1:3939").replace(/\/$/, "");
const HUB_ID = process.env.SCRIPT_HUB_ID || "claude-orchestrator";
const BASE = (process.env.DEPLOY_BASE || "http://127.0.0.1:4317").replace(/\/$/, "");
const PORT = Number(new URL(BASE).port || 80);

// ---- the decision (pure, so `test:deploy-plan` can hold it without a build) ----

/** Paths whose contents end up in `server/dist`. `tsc -p` compiles `src` only; nothing else here is
 *  input, however loudly it shows up in `git status`. */
const SERVER_INPUT = /^server\/(src\/|tsconfig\.json$)/;
/** Paths Vite bundles into `web/dist`. */
const WEB_INPUT = /^web\/(src\/|index\.html$|vite\.config\.|tsconfig|package\.json$)/;

/**
 * Decide how each half must be built, from `git status --porcelain` alone.
 *
 * @param {string[]} statusLines Raw `git status --porcelain` lines (repo-relative, forward slashes).
 * @returns {{server: "plain"|"head-only", web: "plain"|"skip", serverBlockers: string[], webBlockers: string[]}}
 */
function planBuild(statusLines) {
  const paths = statusLines.map(porcelainPath).filter(Boolean);
  const serverBlockers = paths.filter((p) => SERVER_INPUT.test(p));
  const webBlockers = paths.filter((p) => WEB_INPUT.test(p));
  return {
    // A dirty compiled input means the working tree is not HEAD, and only HEAD is reviewed code.
    server: serverBlockers.length ? "head-only" : "plain",
    // web/dist is static and Vite has no cheap archive path, so a dirty web tree is a REFUSAL to rebuild
    // it rather than a slower build — shipping a sibling's half-written component is the same hazard.
    web: webBlockers.length ? "skip" : "plain",
    serverBlockers,
    webBlockers,
  };
}

/** The path out of one porcelain line, handling renames (`R  old -> new`) and quoted names. */
function porcelainPath(line) {
  if (!line || line.length < 4) return null;
  let rest = line.slice(3).trim();
  const arrow = rest.indexOf(" -> ");
  if (arrow >= 0) rest = rest.slice(arrow + 4);
  if (rest.startsWith('"') && rest.endsWith('"')) rest = rest.slice(1, -1);
  return rest.replace(/\\/g, "/");
}

// ---- shelling out ----

const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { encoding: "utf8", stdio: "pipe", windowsHide: true, ...opts });
const git = (args, cwd = REPO) => run("git", args, { cwd }).trim();
const ps = (script) => run("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script]).trim();

function head() {
  try {
    return git(["rev-parse", "HEAD"]);
  } catch {
    return null;
  }
}

function statusLines() {
  return parseStatusOutput(run("git", ["status", "--porcelain"], { cwd: REPO }));
}

function parseStatusOutput(out) {
  return out.split(/\r?\n/).map((l) => l.trimEnd()).filter(Boolean);
}

// ---- the two build paths ----

/** tsc's own entry point, run through node — the `.bin` shims need a shell on Windows, and a partial
 *  `npm install` (routine in this shared checkout) removes them while `typescript/` itself survives. */
const TSC = path.join(NODE_MODULES, "typescript", "bin", "tsc");

function buildServerPlain() {
  log("  tsc (working tree == HEAD for every compiled input)");
  run("node", [TSC, "-p", "tsconfig.json"], { cwd: SERVER_DIR, stdio: "inherit" });
}

/**
 * Compile `server/dist` from committed HEAD while the working tree holds someone else's WIP.
 *
 * Extract HEAD's server sources to a temp tree, junction the real `node_modules` in (so imports and the
 * SDK resolve), and point tsc's `--outDir` at the REAL dist. Everything uncommitted stays behind.
 */
function buildServerFromHead() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gg-deploy-"));
  const link = path.join(tmp, "server", "node_modules");
  try {
    // `server/package.json` is REQUIRED in the archive: without its `"type":"module"`, NodeNext compiles
    // every file as CommonJS and top-level `await` fails with TS1309.
    // Extract with tar's cwd set to the temp dir and a RELATIVE archive name: GNU tar reads a Windows
    // `C:\…` argument as a remote `host:path` and fails with "Cannot connect to C: resolve failed".
    git(["archive", "-o", path.join(tmp, "head.tar"), "HEAD", "server/src", "server/tsconfig.json", "server/package.json"]);
    run("tar", ["-xf", "head.tar"], { cwd: tmp });
    ps(`New-Item -ItemType Junction -Path '${link}' -Target '${NODE_MODULES}' | Out-Null`);
    if (!fs.existsSync(path.join(link, "typescript"))) throw new Error(`junction did not resolve: ${link}`);
    log(`  tsc from HEAD (${String(head()).slice(0, 8)}) — uncommitted compiled inputs excluded`);
    run("node", [TSC, "-p", "tsconfig.json", "--outDir", DIST], { cwd: path.join(tmp, "server"), stdio: "inherit" });
  } finally {
    dropTempTree(tmp, link);
  }
}

/**
 * Remove the temp tree — junction FIRST, as a LINK. A recursive delete that walks a live junction
 * deletes the REAL `server/node_modules` behind it, which is a 400-package reinstall and a broken build
 * for every other agent in this checkout. So the link goes first and the recursive delete is REFUSED
 * until `node_modules` is provably still there.
 */
function dropTempTree(tmp, link) {
  try {
    if (fs.existsSync(link)) ps(`[IO.Directory]::Delete('${link}', $false)`);
  } catch (e) {
    warn(`could not remove the junction ${link} (${String(e)}) — leaving ${tmp} in place rather than risk node_modules`);
    return;
  }
  if (fs.existsSync(link) || !fs.existsSync(path.join(NODE_MODULES, "typescript"))) {
    warn(`refusing to delete ${tmp}: the junction is still there or node_modules looks wrong`);
    return;
  }
  try {
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch {
    /* a temp dir left behind is harmless */
  }
}

function buildWeb() {
  log("  vite build");
  run("npm", ["run", "build", "--prefix", "web"], { cwd: REPO, stdio: "inherit", shell: process.platform === "win32" });
}

// ---- restart + verify ----

function listenerPid(port) {
  try {
    const out = run("netstat", ["-ano"]);
    const m = out.match(new RegExp(`TCP\\s+\\S+:${port}\\s+\\S+\\s+LISTENING\\s+(\\d+)`, "i"));
    return m ? Number(m[1]) : null;
  } catch {
    return null;
  }
}

async function liveBuild() {
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 8000);
    const r = await fetch(`${BASE}/api/health`, { signal: ctl.signal });
    clearTimeout(t);
    const j = await r.json();
    return j && j.build ? j.build : null;
  } catch {
    return null;
  }
}

async function restartViaHub() {
  const r = await fetch(`${HUB_URL}/api/restart`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id: HUB_ID }),
  });
  const reply = await r.json().catch(() => null);
  if (!r.ok) throw new Error(`the script-hub restart endpoint answered HTTP ${r.status}`);
  return reply;
}

/**
 * Ask the running orchestrator's deploy gate to bounce, rather than calling the script-hub directly.
 *
 * The gate is what keeps several tasks — each finishing its own patch — from restarting the owner's
 * console every few minutes: while more than one task is running it collapses agent restarts to one an
 * hour and fires the held one itself. It never refuses, so the build always lands; only the timing moves.
 *
 * Falls back to the hub only when the server is DOWN (there is nobody to interrupt) or a running build
 * is OLDER than this feature and returns 404 (the one-time bootstrap). A live gate timeout/error is a
 * failure, never permission to route around a limit whose whole contract is that it is hard.
 */
async function requestRestart(payload) {
  let response;
  try {
    response = await fetch(`${BASE}/api/deploy/restart`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(10_000),
    });
  } catch (e) {
    // Connection refused means the server is down: there is nobody to interrupt and the hub is the
    // recovery path. A timeout while a listener still exists is different — bypassing it would turn a
    // busy event loop into an ungated restart, violating the hard limit this route exists to enforce.
    const pid = listenerPid(PORT);
    if (pid != null) {
      throw new Error(`${BASE} did not answer its deploy gate while pid ${pid} is still listening; refusing to bypass the one-restart-per-hour limit (${String(e)})`);
    }
    warn(`${BASE} has no listener — restarting through the script-hub recovery path`);
    return { via: "hub", reply: await restartViaHub() };
  }
  if (response.ok) {
    const gate = await response.json();
    if (!gate || (gate.outcome !== "restarting" && gate.outcome !== "deferred")) {
      throw new Error(`the deploy gate returned an invalid response; refusing to bypass the one-restart-per-hour limit`);
    }
    return { via: "gate", gate };
  }
  // The only live-server bypass is bootstrap: a build older than the gate has no route to enforce it.
  // Authentication failures and server errors prove a listener is present, so routing around them would
  // make the supposedly hard limit best-effort precisely when the server is unhealthy or misconfigured.
  if (response.status !== 404) {
    throw new Error(`the deploy gate answered ${response.status}; refusing to bypass the one-restart-per-hour limit`);
  }
  warn(`the running server predates the deploy gate — using the script-hub once to install it`);
  return { via: "hub", reply: await restartViaHub() };
}

/** What the gate is currently holding, if anything. Null whenever it cannot be read — an unreachable
 *  gate must never be reported as "your deploy is safely staged". */
async function gateStatus() {
  try {
    const r = await fetch(`${BASE}/api/deploy/gate`, { signal: AbortSignal.timeout(8000) });
    return r.ok ? await r.json() : null;
  } catch {
    return null;
  }
}

/** The stamp on the dist sitting on disk right now — what the NEXT restart will load. */
function distStamp() {
  try {
    return JSON.parse(fs.readFileSync(path.join(DIST, ".build-info.json"), "utf8"));
  } catch {
    return null;
  }
}

/**
 * Is HEAD's server code already compiled into the local `dist`, merely waiting for a restart?
 *
 * Compared by CONTENT via the shared `liveness` predicate, for the same reason `--verify` is: a
 * docs-only or scripts-only commit moves HEAD without changing a single compiled byte, and calling that
 * "not staged" would send the caller off to rebuild and bounce prod for nothing.
 */
function stagedInDist(commit) {
  const stamp = distStamp();
  if (!stamp || !stamp.commit || !commit) return false;
  return liveness(stamp.commit, commit).live;
}

/** The hub answers 200 with nothing killed when the listener is elevated — a silent no-op that reads
 *  like success. Name it, with the remedy, rather than letting the caller believe it deployed. */
function restartLookedLikeANoop(reply) {
  if (!reply) return false;
  const killed = reply.stop && Array.isArray(reply.stop.killed) ? reply.stop.killed : null;
  return reply.ok === false || (killed !== null && killed.length === 0);
}

async function waitForNewProcess(oldPid, wantCommit) {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    await sleep(2000);
    const pid = listenerPid(PORT);
    if (!pid || pid === oldPid) continue;
    const build = await liveBuild();
    if (build && build.commit === wantCommit) return { pid, build };
  }
  return null;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- output ----

const log = (m) => console.log(m);
const warn = (m) => console.log(`  ⚠ ${m}`);

/** The other half of `--plan`: would this deploy bounce the server now, or be held? Read-only. */
async function printRestartPlan() {
  const status = await gateStatus();
  if (!status) {
    log(`  restart     : deploy gate unreachable — the script-hub would be asked directly`);
    return;
  }
  if (status.pending) {
    log(`  restart     : one is ALREADY held until ${status.pendingLabel} (${status.pending.requesters.length} staged) — this build would ride it`);
    return;
  }
  log(`  restart     : ${status.decision.allow ? "immediate" : "HELD"} — ${status.decision.reason}`);
}

function printPlan(plan, commit) {
  log(`\ndeploy plan — HEAD ${commit ? commit.slice(0, 8) : "unknown"}`);
  log(`  server dist : ${plan.server === "plain" ? "plain tsc (nothing uncommitted compiles in)" : "HEAD-only archive build"}`);
  for (const p of plan.serverBlockers) log(`      excluded: ${p}`);
  log(`  web dist    : ${plan.web === "plain" ? "vite build" : "SKIPPED — uncommitted web sources"}`);
  for (const p of plan.webBlockers) log(`      blocking: ${p}`);
}

/** Who is deploying, for the gate's log line and the owner's "restart held" banner. `--label "…"`, else
 *  DEPLOY_LABEL, else the gate says "an agent" — it is provenance, never a decision input. */
function deployLabel(args) {
  const i = args.indexOf("--label");
  const flag = i >= 0 ? args[i + 1] : null;
  return (flag || process.env.DEPLOY_LABEL || "").trim() || null;
}

/**
 * The restart was HELD, and that is a success: `dist` is built and the orchestrator owns the bounce.
 *
 * Said plainly and at length on purpose. The reflex on "not restarted" is to go restart it by hand
 * through the hub, which puts the interruption straight back — so the output has to leave no doubt that
 * waiting IS the finished state.
 */
function printHeld(gate) {
  log(`\n⏸ restart HELD — ${gate.reason}`);
  log(`  dist is built and stamped; the orchestrator bounces ITSELF onto it at ${gate.readyAtLabel} (in ${gate.waitLabel}).`);
  log(`  ${gate.staged} staged build(s) ride that one restart, so the owner is interrupted once — not once per patch.`);
  log(`  ✓ nothing further to do. Do NOT restart through the hub by hand; that is the interruption this prevents.`);
  log(`  confirm any time with:  npm run deploy --prefix server -- --verify`);
}

/** A one-line "and the web half" note, since `web/dist` is static: a web-only change is live once it is
 *  REBUILT, and a restart would do nothing for it. Silence here would let a web change look deployed. */
function webNote(webChanged) {
  if (!webChanged || !webChanged.length) return null;
  return `  ⚠ ${webChanged.length} web source(s) also changed — run \`npm run build --prefix web\` and reload the browser (web/dist is static; no restart)`;
}

/**
 * Answer "is my change running?" by CONTENT, not by commit id.
 *
 * A raw SHA comparison called every docs-only, rules-only, scripts-only or test-only commit "NOT
 * running" — and this check's remedy is a prod restart that tree-kills every in-flight agent. That is
 * the asymmetry health already learned (`4075fdf`): a check whose remedy is bouncing prod has to be
 * right. `liveness` is the shared predicate, so the two can no longer disagree.
 */
async function verifyOnly(commit) {
  const build = await liveBuild();
  const pid = listenerPid(PORT);
  if (!build) {
    log(`✗ ${BASE} is not answering /api/health (pid ${pid ?? "none"} on :${PORT})`);
    return 1;
  }
  const live = build.commit ? build.commit.slice(0, 8) : "unstamped";
  const head8 = commit ? commit.slice(0, 8) : "unknown";
  const v = liveness(build.commit, commit);
  const web = webNote(v.webChanged);

  if (v.reason === "same-commit") {
    log(`✓ live: build ${live}${build.dirty ? " (dirty)" : ""}, pid ${pid ?? "?"} — matches HEAD`);
    return 0;
  }
  if (v.reason === "no-runtime-change") {
    log(`✓ live: build ${live}, HEAD is ${head8} — nothing that compiles into the server differs, so your change IS running.`);
    log(`  (HEAD only moved in docs, rules, scripts, tests or tools — none of which reach dist. No restart needed.)`);
    if (web) log(web);
    return 0;
  }
  if (v.reason === "unknown") {
    log(`✗ live: build ${live}, HEAD is ${head8} — git cannot compare them (rebased away?), so this cannot prove your change is running.`);
    return 1;
  }
  // Held by the deploy gate is a THIRD answer, distinct from both "running" and "not running": the
  // build is done and the orchestrator owns the bounce, so there is nothing for the caller to do. Exit
  // 0 — a non-zero here is read as "act", and the only action available is bypassing the gate by hand,
  // which is exactly the interruption it exists to prevent.
  const held = await heldRestart(commit);
  if (held) {
    log(`⏸ live: build ${live}, HEAD is ${head8} — your change is BUILT and STAGED, not yet running.`);
    log(`  the deploy gate is holding the restart until ${held.pendingLabel} — ${held.pending.requesters.length} staged build(s) ride it.`);
    log(`  ${held.decision.allow ? "the window is open; it fires on the gate's next tick" : held.decision.reason}`);
    log(`  nothing to do: the orchestrator bounces itself onto this dist then. Do NOT restart it by hand.`);
    if (web) log(web);
    return 0;
  }

  const files = v.serverChanged ?? [];
  log(`✗ live: build ${live}, HEAD is ${head8} — your change is NOT running.`);
  log(`  ${files.length} runtime server file(s) differ: ${files.slice(0, 3).join(", ")}${files.length > 3 ? ", …" : ""}`);
  if (web) log(web);
  return 1;
}

/** A held restart that would deploy THIS commit — both halves matter. A pending bounce for someone
 *  else's build says nothing about yours unless your code is already in the dist it will load. */
async function heldRestart(commit) {
  if (!stagedInDist(commit)) return null;
  const status = await gateStatus();
  return status && status.pending ? status : null;
}

async function main() {
  const args = process.argv.slice(2);
  const commit = head();
  const plan = planBuild(statusLines());

  if (args.includes("--verify")) process.exit(await verifyOnly(commit));

  printPlan(plan, commit);
  if (args.includes("--plan")) {
    await printRestartPlan();
    process.exit(0);
  }

  log("\nbuilding…");
  if (plan.web === "plain") buildWeb();
  else warn("web/dist left as-is; commit the web changes and re-run to ship them");
  if (plan.server === "plain") buildServerPlain();
  else buildServerFromHead();
  run("node", [path.join(SERVER_DIR, "scripts", "stamp-build.cjs")], { cwd: SERVER_DIR });

  const stamp = JSON.parse(fs.readFileSync(path.join(DIST, ".build-info.json"), "utf8"));
  log(`  dist stamped ${String(stamp.commit).slice(0, 8)}`);

  if (args.includes("--no-restart")) {
    log("\n--no-restart: dist is built, nothing was bounced.");
    process.exit(0);
  }

  const oldPid = listenerPid(PORT);
  log(`\nasking the deploy gate to restart ${HUB_ID} (this process is a child of pid ${oldPid ?? "?"} and may die here)`);
  log(`if this session ends now, the resumed one finishes with:  npm run deploy --prefix server -- --verify`);
  const outcome = await requestRestart({ label: deployLabel(args), commit, stampedAt: stamp.at ?? null });

  if (outcome.via === "gate" && outcome.gate.outcome === "deferred") {
    printHeld(outcome.gate);
    process.exit(0);
  }
  if (outcome.via === "hub" && restartLookedLikeANoop(outcome.reply)) {
    warn("the hub reported a restart that killed nothing — the listener is probably elevated.");
    warn("self-elevate the kill, then let keepAlive respawn: Start-Process powershell -Verb RunAs -File <kill.ps1>");
    process.exit(1);
  }

  const fresh = await waitForNewProcess(oldPid, commit);
  if (!fresh) {
    log(`✗ no new listener on :${PORT} running ${commit ? commit.slice(0, 8) : "HEAD"} within 90s`);
    process.exit(1);
  }
  log(`✓ live: build ${fresh.build.commit.slice(0, 8)}, pid ${fresh.pid} — deployed`);
  process.exit(0);
}

module.exports = { planBuild, porcelainPath, restartLookedLikeANoop, parseStatusOutput, deployLabel, requestRestart, printHeld };

if (require.main === module) {
  main().catch((e) => {
    console.error(e && e.stdout ? String(e.stdout) : e);
    process.exit(1);
  });
}
