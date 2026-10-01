// Gate for `deploy.cjs`'s build decision. Run: `npm run test:deploy-plan`.
//
// This is the half of the deploy that can do damage, and it is invisible until it has: choose "plain"
// while a sibling has half a runner rewritten and their un-QA'd code is live in prod under your deploy;
// choose "head-only" on a clean tree and you have paid ten tool calls and a junction dance for nothing.
// Both happened on 2026-08-24 in the same afternoon. `planBuild` is pure, so the whole decision is held
// here without a build, a temp tree, or a restart.
const assert = require("node:assert/strict");
const http = require("node:http");
const path = require("node:path");

// deploy.cjs reads both endpoints at module load, so they are pointed at this file's fake servers
// BEFORE it is required. Ports are fixed and deliberately far from :4317/:3939 — nothing here may
// reach prod or the real script-hub.
const COORDINATOR_PORT = 4399;
const HUB_PORT = 4398;
process.env.DEPLOY_BASE = `http://127.0.0.1:${COORDINATOR_PORT}`;
process.env.SCRIPT_HUB_URL = `http://127.0.0.1:${HUB_PORT}`;

const { linkedWorktreeMain, planBuild, porcelainPath, restartLookedLikeANoop, parseStatusOutput, deployLabel, requestRestart, coordinatorStatus } = require("./deploy.cjs");

let checks = 0;
const check = (name, cond) => {
  checks++;
  if (!cond) {
    console.error(`  ✗ ${name}`);
    process.exitCode = 1;
  } else console.log(`  ✓ ${name}`);
};

console.log("deploy plan: a clean tree takes the fast path");
{
  const p = planBuild([]);
  check("clean tree builds plainly", p.server === "plain" && p.web === "plain");
  check("nothing is reported as excluded", p.serverBlockers.length === 0 && p.webBlockers.length === 0);
}

console.log("deploy plan: anything that COMPILES into dist forces the HEAD-only build");
{
  for (const line of [" M server/src/agents/runner.ts", "?? server/src/tools/newThing.ts", "M  server/tsconfig.json"]) {
    const p = planBuild([line]);
    check(`${line.trim()} → head-only`, p.server === "head-only");
    check("...and is named as excluded", p.serverBlockers.length === 1);
  }
}

console.log("deploy: a linked task worktree is refused and pointed at the main checkout");
{
  const main = path.resolve("/repos/app");
  check("the main checkout itself is not a linked worktree", linkedWorktreeMain(".git", ".git", main) === null);
  check(
    "a worktree resolves to its main checkout",
    linkedWorktreeMain(path.join(main, ".git", "worktrees", "fix-x"), path.join(main, ".git"), path.resolve("/repos/app.worktrees/fix-x")) === main,
  );
}

console.log("deploy plan: a dirty file that cannot reach dist must NOT cost the slow path");
{
  // The whole point of the predicate. `git status` is noisy in this checkout — labs, probes, rules,
  // scratch — and treating all of it as "dirty" would make the expensive path the permanent default,
  // which is how a correct-but-unusable check gets bypassed by hand.
  const noise = [
    " M server/scripts/notes-lab.cjs",
    " M server/package.json",
    " M CLAUDE.md",
    " M .claude/rules/office-bridge.md",
    "?? server/data/gates-last.log",
    " M docs/DECISIONS.md",
  ];
  const p = planBuild(noise);
  check("none of it forces head-only", p.server === "plain");
  check("and none of it blocks the web build", p.web === "plain");
}

console.log("deploy plan: the two halves are judged separately");
{
  const p = planBuild([" M web/src/components/Board.tsx"]);
  check("a dirty web source skips the web build", p.web === "skip" && p.webBlockers.length === 1);
  check("...without dragging the server onto the slow path", p.server === "plain");

  const q = planBuild([" M server/src/db/db.ts", " M web/src/store.ts"]);
  check("both dirty → head-only server, skipped web", q.server === "head-only" && q.web === "skip");
}

console.log("deploy plan: porcelain shapes that would otherwise read as a different file");
{
  const raw = " M server/src/orchestrator/threadManager.ts\n";
  const parsed = parseStatusOutput(raw);
  check("the first unstaged line keeps its porcelain status columns", parsed[0] === " M server/src/orchestrator/threadManager.ts");
  check("a first-line unstaged source still forces head-only", planBuild(parsed).server === "head-only");
  check("a rename reports its NEW path", porcelainPath('R  server/src/a.ts -> server/src/b.ts') === "server/src/b.ts");
  check("a renamed source still forces head-only", planBuild(['R  docs/a.md -> server/src/b.ts']).server === "head-only");
  check("a quoted path is unquoted", porcelainPath('?? "server/src/a b.ts"') === "server/src/a b.ts");
  check("backslashes normalize to forward", porcelainPath(" M server\\src\\a.ts") === "server/src/a.ts");
  check("a quoted dirty source still forces head-only", planBuild(['?? "server/src/new file.ts"']).server === "head-only");
  check("a blank line is ignored", planBuild([""]).server === "plain");
}

console.log("deploy: a restart that killed nothing is not a deploy");
{
  // The documented elevated-listener case: HTTP 200, no `errors`, nothing actually bounced. Reading that
  // as success is how a deploy gets reported done while prod keeps serving the old build.
  check("ok:false is a no-op", restartLookedLikeANoop({ ok: false, stop: { killed: [1234] } }));
  check("an empty kill list is a no-op", restartLookedLikeANoop({ ok: true, stop: { killed: [] } }));
  check("a real kill is not", !restartLookedLikeANoop({ ok: true, stop: { killed: [4242] } }));
  check("an unparseable reply is not assumed broken", !restartLookedLikeANoop(null));
}

console.log("deploy: who is asking the coordinator to restart");
{
  // Provenance for the coordinator log and the owner's "restart waiting" banner. Never a decision input,
  // so a missing one must degrade to "an agent", never to an error or an empty-string label.
  const saved = process.env.DEPLOY_LABEL;
  delete process.env.DEPLOY_LABEL;
  check("--label wins", deployLabel(["--label", "implementor · fix the crawler"]) === "implementor · fix the crawler");
  check("no label at all is null, not empty", deployLabel([]) === null);
  check("a --label with nothing after it is null", deployLabel(["--label"]) === null);
  check("a blank label is null", deployLabel(["--label", "   "]) === null);
  process.env.DEPLOY_LABEL = "qa · nightly";
  check("DEPLOY_LABEL is the fallback", deployLabel([]) === "qa · nightly");
  check("...and the flag still outranks it", deployLabel(["--label", "explicit"]) === "explicit");
  if (saved === undefined) delete process.env.DEPLOY_LABEL;
  else process.env.DEPLOY_LABEL = saved;
}

/** A throwaway HTTP endpoint. Free, instant, and — unlike a real instance — provably unable to touch
 *  prod: the ports above are the only ones these tests can reach. */
function serve(port, handler) {
  const server = http.createServer(handler);
  return new Promise((resolve) => server.listen(port, "127.0.0.1", () => resolve(server)));
}

const close = (server) => new Promise((resolve) => (server ? server.close(resolve) : resolve()));

// `connection: close`, or fetch reuses a pooled socket from the previous fake server and fails.
const json = (res, code, body) => {
  res.writeHead(code, { "content-type": "application/json", connection: "close" });
  res.end(JSON.stringify(body));
};

const RESTARTING = {
  outcome: "restarting",
  reason: "3 active work items auto-resume on the new build",
  readyAt: null,
  waitMs: 0,
  readyAtLabel: null,
  waitLabel: "now",
  activeWork: 3,
  staged: 1,
};

/** What a server from before immediate restarts answers while agents are busy. */
const LEGACY_DEFERRED = { ...RESTARTING, outcome: "deferred", reason: "3 active work items remain", staged: 2 };

async function restartRouting() {
  console.log("deploy: the restart is REQUESTED from the orchestrator, not issued to the hub");
  let hubCalls = 0;
  const hub = await serve(HUB_PORT, (req, res) => {
    hubCalls++;
    json(res, 200, { ok: true, stop: { killed: [4242] } });
  });

  // The normal path: the running server commits the restart itself, with agents still working.
  let coordinator = await serve(COORDINATOR_PORT, (req, res) => {
    if (req.url === "/api/deploy/restart") return json(res, 200, RESTARTING);
    json(res, 404, { error: "not found" });
  });
  const now = await requestRestart({ label: "implementor · a fix", commit: "abc1234", stampedAt: Date.now() });
  check("the coordinator restarts now, so the hub is never touched", now.via === "coordinator" && hubCalls === 0);
  check("...even with active agents", now.coordinator.outcome === "restarting" && now.coordinator.activeWork === 3);
  await close(coordinator);

  // A server from before immediate restarts would hold the build until its agents finish. Deploys no
  // longer wait for anything, so that answer is routed around once through the hub.
  coordinator = await serve(COORDINATOR_PORT, (req, res) => json(res, 200, LEGACY_DEFERRED));
  const legacy = await capturedAsync(() => requestRestart({ label: "implementor · a fix", commit: "abc1234" }));
  check("a legacy deferred answer restarts through the hub instead of waiting", legacy.value.via === "hub" && hubCalls === 1);
  check("...and says why", /predates immediate restarts/.test(legacy.output));
  await close(coordinator);

  // A live-but-broken coordinator is no reason to leave the box on stale code.
  coordinator = await serve(COORDINATOR_PORT, (req, res) => json(res, 503, { error: "busy" }));
  const broken = await capturedAsync(() => requestRestart({ label: "implementor · a fix", commit: "abc1234" }));
  check("a coordinator error falls back to the hub", broken.value.via === "hub" && hubCalls === 2);
  check("...and names the status it got", /answered 503/.test(broken.output));
  await close(coordinator);

  // A running build OLDER than restart coordination has no such route.
  coordinator = await serve(COORDINATOR_PORT, (req, res) => json(res, 404, { error: "not found" }));
  const viaHub = await capturedAsync(() => requestRestart({ label: "implementor · a fix", commit: "abc1234" }));
  check("a coordinator route that 404s falls back to the hub", viaHub.value.via === "hub" && hubCalls === 3);
  check("...and names the bootstrap rather than failing silently", /predates restart coordination/.test(viaHub.output));
  await close(coordinator);

  // A server that is DOWN must still be deployable.
  const down = await capturedAsync(() => requestRestart({ label: "implementor · a fix", commit: "abc1234" }));
  check("an unreachable coordinator falls back to the hub", down.value.via === "hub" && hubCalls === 4);
  check("...and the hub's own no-op detection still applies", !restartLookedLikeANoop(down.value.reply));
  await close(hub);

  console.log("deploy: status reads the coordinator route with a rolling-upgrade fallback");
  coordinator = await serve(COORDINATOR_PORT, (req, res) =>
    json(res, req.url === "/api/deploy/status" ? 200 : 404, { route: "current" }),
  );
  check("current coordinator status route wins", (await coordinatorStatus())?.route === "current");
  await close(coordinator);
  coordinator = await serve(COORDINATOR_PORT, (req, res) =>
    json(res, req.url === "/api/deploy/gate" ? 200 : 404, { route: "legacy" }),
  );
  check("the removed gate route is read only as an upgrade fallback", (await coordinatorStatus())?.route === "legacy");
  await close(coordinator);
}

/** `capture` for an async call — the fallback path prints its warning while awaiting. */
async function capturedAsync(fn) {
  const real = console.log;
  const lines = [];
  console.log = (m) => lines.push(String(m));
  try {
    return { value: await fn(), output: lines.join("\n") };
  } finally {
    console.log = real;
  }
}

restartRouting()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .then(() => {
    if (process.exitCode) {
      console.error(`\ndeploy-plan: FAILED (${checks} checks run)`);
    } else {
      console.log(`\nAll ${checks} deploy-plan checks passed.`);
    }
  });
