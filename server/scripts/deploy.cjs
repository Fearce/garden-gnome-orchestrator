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
// You are usually a child process of :4317, so the restart kills this shell. It is immediate: GGO bounces
// whatever agents are running and auto-resumes them on the new build. Confirm with --verify afterwards.
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { liveness, readWebStamp, webDistState } = require("./compiled-diff.cjs");

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
const SERVER_INPUT = /^server\/(src\/|tsconfig\.json$|scripts\/git-transaction\.cjs$)/;
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
  return (await health())?.build ?? null;
}

/** The raw /api/health body, or null when the port genuinely did not answer. Kept separate from
 *  liveBuild() because "the server is down" and "the server is up but reports no build stamp" are
 *  different answers and only one of them is a reason to worry: a process started before build
 *  stamping shipped, or run from source under tsx, answers happily with `build: null`. Collapsing
 *  both into null made --verify report a healthy server as "not answering". */
async function health() {
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 8000);
    const r = await fetch(`${BASE}/api/health`, { signal: ctl.signal });
    clearTimeout(t);
    return await r.json();
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
 * Ask the running orchestrator's restart coordinator to bounce, rather than calling the hub directly.
 *
 * The coordinator restarts at once — it only adds a short settle so its HTTP reply flushes and nothing
 * new starts on the dying process. Anything short of a committed restart falls back to the hub, which
 * costs nothing now that deploys do not wait for agents: a server that is down, wedged, erroring, too
 * old to have the route, or old enough to still hold deploys for active work (answers `deferred`).
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
    const pid = listenerPid(PORT);
    warn(pid == null
      ? `${BASE} has no listener — restarting through the script-hub recovery path`
      : `${BASE} did not answer its restart coordinator (pid ${pid}; ${String(e)}) — restarting through the script-hub`);
    return { via: "hub", reply: await restartViaHub() };
  }
  const coordinator = response.ok ? await response.json().catch(() => null) : null;
  if (coordinator && coordinator.outcome === "restarting") return { via: "coordinator", coordinator };
  warn(`${coordinatorShortfall(response.status, coordinator)} — using the script-hub to restart now`);
  return { via: "hub", reply: await restartViaHub() };
}

/** Why the coordinator did not commit a restart, for the one-line warning before the hub fallback. */
function coordinatorShortfall(status, coordinator) {
  if (status === 404) return "the running server predates restart coordination";
  if (coordinator && coordinator.outcome === "deferred") {
    return "the running server predates immediate restarts and would hold this deploy for active agents";
  }
  return status >= 200 && status < 300
    ? `the restart coordinator did not commit a restart (${coordinator ? coordinator.outcome : "unreadable reply"})`
    : `the restart coordinator answered ${status}`;
}

/** What the coordinator is holding, if anything. Null when it cannot be read; unreachable coordination
 *  must never be reported as "your deploy is safely staged". */
async function coordinatorStatus() {
  try {
    const current = await fetch(`${BASE}/api/deploy/status`, { signal: AbortSignal.timeout(8000) });
    if (current.ok) return await current.json();
    if (current.status !== 404) return null;
    // Rolling-upgrade compatibility: the old live process only exposes this status under /gate.
    const legacy = await fetch(`${BASE}/api/deploy/gate`, { signal: AbortSignal.timeout(8000) });
    return legacy.ok ? await legacy.json() : null;
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

/** The other half of `--plan`: what the immediate restart would interrupt. Read-only. */
async function printRestartPlan() {
  const status = await coordinatorStatus();
  if (!status) {
    log(`  restart     : coordinator unreachable — the script-hub would be asked directly`);
    return;
  }
  const active = status.activeWork > 0 ? `${status.activeWork} active work item(s) auto-resume on the new build` : "no active agent work";
  log(`  restart     : immediate — ${active}`);
}

function printPlan(plan, commit) {
  log(`\ndeploy plan — HEAD ${commit ? commit.slice(0, 8) : "unknown"}`);
  log(`  server dist : ${plan.server === "plain" ? "plain tsc (nothing uncommitted compiles in)" : "HEAD-only archive build"}`);
  for (const p of plan.serverBlockers) log(`      excluded: ${p}`);
  log(`  web dist    : ${plan.web === "plain" ? "vite build" : "SKIPPED — uncommitted web sources"}`);
  for (const p of plan.webBlockers) log(`      blocking: ${p}`);
}

/** Who is deploying, for the coordinator log. `--label "…"`, else DEPLOY_LABEL. */
function deployLabel(args) {
  const i = args.indexOf("--label");
  const flag = i >= 0 ? args[i + 1] : null;
  return (flag || process.env.DEPLOY_LABEL || "").trim() || null;
}

/**
 * A one-line "and the web half" note, since `web/dist` is static: a web-only change is live once it is
 * REBUILT, and a restart would do nothing for it. Silence here would let a web change look deployed.
 *
 * Answered from the BUNDLE's own stamp, never from the live server's build commit. That older proxy
 * was wrong both ways: it repeated "run npm run build --prefix web" at a bundle that was already
 * current (a server build staged behind a drain reads the same as a stale bundle — this cost a
 * needless rebuild + re-verify on 2026-09-08), and it printed nothing at all on the `same-commit`
 * path, which is exactly where a stale bundle hides.
 */
function webNote(commit) {
  const state = webDistState(readWebStamp(REPO), commit, REPO);
  if (state.state === "current") return null;
  if (state.state === "stale") {
    return `  ⚠ ${state.detail} — run \`npm run build --prefix web\` and reload the browser (web/dist is static; no restart)`;
  }
  if (state.state === "unknown") return `  ⚠ ${state.detail} — \`npm run build --prefix web\` establishes one`;
  return `  ⚠ ${state.detail}`;
}

/**
 * Answer "is my change running?" by CONTENT, not by commit id.
 *
 * A raw SHA comparison called every docs-only, rules-only, scripts-only or test-only commit "NOT
 * running" — and this check's remedy is a prod restart. That is
 * the asymmetry health already learned (`4075fdf`): a check whose remedy is bouncing prod has to be
 * right. `liveness` is the shared predicate, so the two can no longer disagree.
 */
async function verifyOnly(commit) {
  const alive = await health();
  const build = alive?.build ?? null;
  const pid = listenerPid(PORT);
  if (!alive) {
    log(`✗ ${BASE} is not answering /api/health (pid ${pid ?? "none"} on :${PORT})`);
    return 1;
  }
  if (!build) {
    // Answering, just unstamped. Name which of the two it is, and report what IS still knowable:
    // whether HEAD is compiled into dist, which does not depend on the process naming its own build.
    const staged = stagedInDist(commit);
    log(`⚠ ${BASE} is UP (pid ${pid ?? "?"}) but reports no build stamp, so what is LIVE cannot be`);
    log(`  confirmed from here. That process started before build stamping shipped, or runs from`);
    log(`  source under tsx. Restart it to get a stamped process.`);
    log(staged
      ? `  dist DOES carry HEAD's server code, so a restart is all that is missing.`
      : `  dist does NOT carry HEAD's server code; run \`npm run deploy --prefix server\` first.`);
    return 1;
  }
  const live = build.commit ? build.commit.slice(0, 8) : "unstamped";
  const head8 = commit ? commit.slice(0, 8) : "unknown";
  const v = liveness(build.commit, commit);
  const web = webNote(commit);

  if (v.reason === "same-commit") {
    log(`✓ live: build ${live}${build.dirty ? " (dirty)" : ""}, pid ${pid ?? "?"} — matches HEAD`);
    if (web) log(web);
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
  // A held restart now only means a restart mechanism REFUSED; the build is not live, so this stays red.
  const held = await heldRestart(commit);
  if (held) {
    log(`✗ live: build ${live}, HEAD is ${head8} — your change is BUILT and STAGED, but its restart was refused.`);
    log(`  the restart coordinator retries it (${held.pendingLabel}); ${held.pending.requesters.length} staged build(s) ride it.`);
    log(`  re-run \`npm run deploy --prefix server\` to try again now; a deploy never waits on that backoff.`);
    if (web) log(web);
    return 1;
  }

  const files = v.serverChanged ?? [];
  log(`✗ live: build ${live}, HEAD is ${head8} — your change is NOT running.`);
  log(`  ${files.length} runtime server file(s) differ: ${files.slice(0, 3).join(", ")}${files.length > 3 ? ", …" : ""}`);
  if (web) log(web);
  return 1;
}

/** A refused restart that would deploy THIS commit — both halves matter. A pending bounce for someone
 *  else's build says nothing about yours unless your code is already in the dist it will load. */
async function heldRestart(commit) {
  if (!stagedInDist(commit)) return null;
  const status = await coordinatorStatus();
  return status && status.pending ? status : null;
}

/** The main checkout when `repo` is a linked git worktree (a task's own checkout), else null. Deploying
 *  from one would build its dist and then restart prod, which runs the main checkout's stale build. */
function linkedWorktreeMain(gitDir, commonDir, repo) {
  const own = path.resolve(repo, gitDir);
  const common = path.resolve(repo, commonDir);
  if (path.normalize(own).toLowerCase() === path.normalize(common).toLowerCase()) return null;
  return path.dirname(common);
}

function refuseLinkedWorktree() {
  let main = null;
  try {
    main = linkedWorktreeMain(git(["rev-parse", "--git-dir"]), git(["rev-parse", "--git-common-dir"]), REPO);
  } catch {
    return;
  }
  if (!main) return;
  log(`✗ ${REPO} is a linked worktree; prod runs from the main checkout ${main}.`);
  log(`  Integrate this branch there first (rebase, fast-forward), then deploy from it:  npm run deploy --prefix "${path.join(main, "server")}"`);
  process.exit(1);
}

async function main() {
  const args = process.argv.slice(2);
  const commit = head();
  const plan = planBuild(statusLines());

  if (args.includes("--verify")) process.exit(await verifyOnly(commit));
  refuseLinkedWorktree();

  printPlan(plan, commit);
  if (args.includes("--plan")) {
    await printRestartPlan();
    process.exit(0);
  }

  // Unlike compiled TS, this shared CLI/server library is loaded from the checkout.
  // A HEAD-only dist build cannot exclude its uncommitted working-tree bytes.
  if (plan.serverBlockers.some(file => ["server/scripts/git-transaction.cjs", "server/scripts/git-recover-index.ps1"].includes(file))) {
    log("Commit the reviewed Git transaction runtime before deploying; it is loaded directly from this checkout.");
    process.exit(1);
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
  log(`\nasking GGO's restart coordinator to restart ${HUB_ID} now (parent pid ${oldPid ?? "?"})`);
  log(`running agents auto-resume on the new build; if this shell ends with the restart, verify with:  npm run deploy --prefix server -- --verify`);
  const outcome = await requestRestart({ label: deployLabel(args), commit, stampedAt: stamp.at ?? null });

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

module.exports = { linkedWorktreeMain, planBuild, porcelainPath, restartLookedLikeANoop, parseStatusOutput, deployLabel, requestRestart, coordinatorStatus };

if (require.main === module) {
  main().catch((e) => {
    console.error(e && e.stdout ? String(e.stdout) : e);
    process.exit(1);
  });
}
