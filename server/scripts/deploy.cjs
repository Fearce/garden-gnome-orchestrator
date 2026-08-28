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

async function restart() {
  const r = await fetch(`${HUB_URL}/api/restart`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id: HUB_ID }),
  });
  return r.json().catch(() => null);
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

function printPlan(plan, commit) {
  log(`\ndeploy plan — HEAD ${commit ? commit.slice(0, 8) : "unknown"}`);
  log(`  server dist : ${plan.server === "plain" ? "plain tsc (nothing uncommitted compiles in)" : "HEAD-only archive build"}`);
  for (const p of plan.serverBlockers) log(`      excluded: ${p}`);
  log(`  web dist    : ${plan.web === "plain" ? "vite build" : "SKIPPED — uncommitted web sources"}`);
  for (const p of plan.webBlockers) log(`      blocking: ${p}`);
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
  const files = v.serverChanged ?? [];
  log(`✗ live: build ${live}, HEAD is ${head8} — your change is NOT running.`);
  log(`  ${files.length} runtime server file(s) differ: ${files.slice(0, 3).join(", ")}${files.length > 3 ? ", …" : ""}`);
  if (web) log(web);
  return 1;
}

async function main() {
  const args = process.argv.slice(2);
  const commit = head();
  const plan = planBuild(statusLines());

  if (args.includes("--verify")) process.exit(await verifyOnly(commit));

  printPlan(plan, commit);
  if (args.includes("--plan")) process.exit(0);

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
  log(`\nrestarting ${HUB_ID} (atomic, via the hub — this process is a child of pid ${oldPid ?? "?"} and may die here)`);
  log(`if this session ends now, the resumed one finishes with:  npm run deploy --prefix server -- --verify`);
  const reply = await restart();
  if (restartLookedLikeANoop(reply)) {
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

module.exports = { planBuild, porcelainPath, restartLookedLikeANoop, parseStatusOutput };

if (require.main === module) {
  main().catch((e) => {
    console.error(e && e.stdout ? String(e.stdout) : e);
    process.exit(1);
  });
}
