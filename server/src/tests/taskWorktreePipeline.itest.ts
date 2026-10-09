/**
 * Integration test — how ThreadManager relates a task to git worktrees, using a real Db, EventHub and
 * throwaway git repos. Nothing spawns an agent: the methods under test run before any agent would, or
 * are the ones its bus tool calls.
 *
 * Worktrees are GUIDANCE, never enforcement: GGO does not move a task. A task in a repo's main checkout
 * is `guided` — its kickoff and the office tell the agent to claim its own worktree with `task_worktree`
 * when other agents share the repo — and everything downstream follows the claim.
 *
 * Scenarios:
 *   A. FIRST START  — a dispatched task stays in the main checkout, is marked guided, cuts no worktree and
 *                     spends no naming call; its kickoff section explains when to claim one.
 *   A2. CLAIM       — `task_worktree` on a guided task cuts the agent-named branch, records it without
 *                     moving the task, and the kickoff, Changes view and deliverables follow it; with no
 *                     name, the brief namer names it after the work.
 *   B. SUBFOLDER    — a task dispatched on <repo>/web is told the repo root, and its Changes view maps
 *                     into the claimed worktree's web.
 *   C. NO GUIDANCE  — sub-tasks, read lanes, pre-feature rows, the setting turned off, plain folders and a
 *                     worktree the owner made get no mode or work in place.
 *   D. RESTORE      — a claimed worktree whose folder is gone comes back on resume.
 *   E. UMBRELLA     — a non-repo folder holding repos is marked umbrella; task_worktree claims one per
 *                     repo, a sub-task's claim lands on its parent, and asking again returns the same one.
 *   E1. HAND-MADE   — a worktree a CLI agent made by hand off a guided repo is discovered and recorded.
 *   E2. CO-WORK     — a Co-worker turn in the main checkout holds a task that starts there.
 *   F. CLOSE        — closing a task retires its clean claimed worktree and keeps the main checkout's packages.
 *   F2. DONE        — a task reaching 'done' retires a worktree whose branch reached its base, and keeps one
 *                     whose branch did not, saying so in the feed.
 *   F3. DELIVERABLES — a deliverable the main checkout holds byte for byte, or one committed on the branch,
 *                     moves its card there and no longer pins the worktree; one only the worktree holds
 *                     (an ignored output) still does.
 *   G. KICKOFF      — the worktree section a sub-task carries (borrowed).
 *   H. OFFICE       — the office's worktree advice is given to an unclaimed guided task only.
 *
 * Run:  npm run test:task-worktree-pipeline   (from server/)
 */

process.env.CAP_RETRY_MS = "0";
process.env.ACCOUNT_PING_MS = "3600000";
process.env.FAST_ACCOUNT_PING_MS = "3600000";
process.env.NO_PUSH_REPO_PATTERN = "commit-only-origin";

import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import type { AccountManager } from "../accounts/accountManager.js";
import type { Thread } from "../types.js";
import assert from "node:assert/strict";

const { Db } = await import("../db/db.js");
const { EventHub } = await import("../events.js");
const { FileMemoryService } = await import("../memory/memory.js");
const { ThreadManager } = await import("../orchestrator/threadManager.js");
const { retireTaskWorktree, taskWorkCheckout, worktreesHome } = await import("../orchestrator/taskWorktree.js");
const { resolveTaskDeliverable } = await import("../orchestrator/deliverablePath.js");

let passed = 0;
let failed = 0;
const failures: string[] = [];
function check(label: string, cond: boolean, detail?: string): void {
  if (cond) {
    passed++;
    console.log(`  ✓ ${label}`);
  } else {
    failed++;
    failures.push(label + (detail ? ` — ${detail}` : ""));
    console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

let stubToken: string | null = null;

class StubAccounts {
  onUsageRefresh(_cb: () => void): void {}
  effectiveUtilization(): number | null {
    return null;
  }
  soonestResetAt(): number | null {
    return null;
  }
  hasHeadroom(): boolean {
    return true;
  }
  setPingInterval(_ms: number): void {}
  applyEnabled(_id: string, _enabled: boolean): void {}
  applyWeeklySafetyPct(_id: string, _pct: number): void {}
  setSpreadUsage(_on: boolean): void {}
  setProfileToken(_id: string, _token: string): void {}
  auxToken(): string | null {
    return stubToken;
  }
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_TERMINAL_PROMPT: "0" }, windowsHide: true }).trim();
}

function makeRepo(parent: string, name: string, origin?: string): string {
  const repo = join(parent, name);
  mkdirSync(join(repo, "web"), { recursive: true });
  git(repo, "init", "--quiet", "-b", "master");
  for (const [key, value] of [["user.name", "Pipeline Test"], ["user.email", "pipeline@example.com"], ["commit.gpgsign", "false"], ["core.autocrlf", "false"]]) {
    git(repo, "config", key!, value!);
  }
  if (origin) git(repo, "remote", "add", "origin", origin);
  writeFileSync(join(repo, ".gitignore"), "node_modules/\n");
  writeFileSync(join(repo, "web", "index.ts"), "export {};\n");
  mkdirSync(join(repo, "node_modules", "pkg"), { recursive: true });
  writeFileSync(join(repo, "node_modules", "pkg", "index.js"), "1\n");
  git(repo, "add", ".gitignore", "web/index.ts");
  git(repo, "commit", "--quiet", "-m", "initial");
  return realpathSync(repo);
}

const root = mkdtempSync(join(tmpdir(), "ggo-worktree-pipeline-"));
const db = new Db(join(root, "orchestrator.sqlite"));
const hub = new EventHub();
const mgr = new ThreadManager(db, hub, new FileMemoryService(join(root, "memory")), new StubAccounts() as unknown as AccountManager);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const internals = mgr as any;
const prepare = (thread: Thread): Promise<Thread | null> => internals.prepareTaskWorkspace(thread);
const section = (thread: Thread): string => (internals.worktreeSection(thread) as string | null) ?? "";
const mode = (id: string): string | undefined => db.getThreadStageOutputs(id).workspaceMode;
const fresh = (id: string): Thread => db.getThread(id)!;
const dispatch = (workspace: string, title: string, extra: Record<string, unknown> = {}): Thread =>
  db.createThread({ title, workspace, homeWorkspace: workspace, rawPrompt: "do it", ...extra });

async function settle(predicate: () => boolean, ms = 30_000): Promise<boolean> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (predicate()) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return predicate();
}

/** Run `body` with the Haiku namer answering `reply`, counting the calls it makes. */
async function withNamer<T>(reply: string, body: (calls: () => number) => Promise<T>): Promise<T> {
  const realFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => {
    calls++;
    return new Response(JSON.stringify({ content: [{ type: "text", text: reply }] }), { status: 200 });
  }) as typeof fetch;
  stubToken = "stub-token";
  try {
    return await body(() => calls);
  } finally {
    globalThis.fetch = realFetch;
    stubToken = null;
  }
}

/** Real retirement boundaries, without waiting for a particular machine's Git timing.
 * --retirement-only runs this focused regression without the other workspace scenarios. */
async function retirementLifecycleRegression(): Promise<void> {
  console.log("I. deliverable retirement boundaries");
  mgr.setSettings({ taskWorktrees: true });
  const repo = makeRepo(root, "retirement-lifecycle");
  const task = (await prepare(dispatch(repo, "Deliverable retirement boundaries")))!;
  const claim = await mgr.claimTaskWorktree(task.id, { repo, name: "deliverable-boundary" });
  assert.ok(claim.ok, claim.ok ? undefined : claim.error);
  const wt = claim.worktree;
  for (const name of ["one.md", "two.md"]) writeFileSync(join(wt.path, name), `${name}\n`);
  git(wt.path, "add", "one.md", "two.md");
  git(wt.path, "commit", "--quiet", "-m", "deliverable copies");
  let called = false;
  const beforeRemove = () => { called = true; };
  const unmerged = await retireTaskWorktree(wt, { onlyIntegrated: true, beforeRemove });
  check("the removal callback never runs for an unintegrated branch", !unmerged.removed && !called && existsSync(wt.path));
  git(repo, "merge", "--quiet", "--ff-only", wt.branch);
  writeFileSync(join(wt.path, "untracked.txt"), "keep\n");
  const dirty = await retireTaskWorktree(wt, { beforeRemove });
  check("the removal callback never runs for dirty work", !dirty.removed && !called && existsSync(wt.path));
  unlinkSync(join(wt.path, "untracked.txt"));
  const kept = await retireTaskWorktree(wt, { keep: [join(wt.path, "one.md")], beforeRemove });
  check("a retained deliverable prevents the removal callback", !kept.removed && !called && existsSync(wt.path));

  const findings = ["one.md", "two.md"].map(name => db.addFinding({ threadId: task.id, fromRole: "implementor",
    summary: name, severity: "info", kind: "deliverable", path: join(wt.path, name) }));
  const planned = await internals.deliverablesLeaving(fresh(task.id), wt, findings.map(f => ({ id: f.id, path: f.path! })));
  assert.equal(planned.moves.length, 2);
  // The copy was valid during planning, then vanished while Git checked retention guards.
  unlinkSync(join(repo, "two.md"));
  await assert.rejects(retireTaskWorktree(wt, { onlyIntegrated: true,
    beforeRemove: () => internals.repointDeliverables(fresh(task.id), planned.moves) }), /surviving copy cannot be served/);
  check("a vanished destination leaves every original card untouched", findings.every(f => db.getFinding(f.id)?.path === f.path));
  check("a rejected callback preserves the worktree and its package junction", existsSync(wt.path) && existsSync(join(wt.path, "node_modules", "pkg", "index.js")));
  writeFileSync(join(repo, "two.md"), "two.md\n");
  await assert.rejects(retireTaskWorktree(wt, { beforeRemove: () => { throw new Error("callback rejected"); } }), /callback rejected/);
  check("a throwing callback cannot unlink packages or remove the folder", existsSync(wt.path) && existsSync(join(wt.path, "node_modules", "pkg", "index.js")));

  // Pause before native removal; no Git transaction is held while the mapping assertions run.
  let mapped!: () => void;
  const mappingReached = new Promise<void>(resolve => { mapped = resolve; });
  let allowRemoval!: () => void;
  const removalReleased = new Promise<void>(resolve => { allowRemoval = resolve; });
  const realRepoint = internals.repointDeliverables;
  internals.repointDeliverables = (thread: Thread, moves: { id: string; path: string }[]) => {
    realRepoint.call(mgr, thread, moves);
    if (thread.id === task.id) { mapped(); return removalReleased; }
  };
  const branchReady = join(root, "branch-cleanup.ready");
  const branchRelease = join(root, "branch-cleanup.release");
  const quote = (value: string): string => `'${value.replace(/\\/g, "/").replace(/'/g, "'\\''")}'`;
  const hook = join(repo, ".git", "hooks", "reference-transaction");
  writeFileSync(hook, `#!/bin/sh
if [ "$1" = prepared ]; then
  while read old new ref; do
    if [ "$ref" = ${quote(`refs/heads/${wt.branch}`)} ] && [ "$new" = 0000000000000000000000000000000000000000 ]; then
      : > ${quote(branchReady)}
      while [ ! -f ${quote(branchRelease)} ]; do sleep 0.05; done
    fi
  done
fi
`);
  chmodSync(hook, 0o755);
  // Pin the fixture hook even on a workstation with a global core.hooksPath.
  git(repo, "config", "core.hooksPath", join(repo, ".git", "hooks"));
  let retirement: Promise<void> | undefined;
  try {
    db.updateThread(task.id, { state: "done" });
    retirement = internals.retireWorktrees(fresh(task.id), "done");
    await Promise.race([mappingReached, retirement!.then(() => { throw new Error("retirement ended before the mapping barrier"); })]);
    check("cards move before the worktree or package junction disappears", existsSync(wt.path) &&
      existsSync(join(wt.path, "node_modules", "pkg", "index.js")) && findings.every(f => db.getFinding(f.id)?.path === join(repo, f.summary)));
    check("every mapped card is readable before removal", findings.every(f => {
      const card = db.getFinding(f.id)!;
      return resolveTaskDeliverable(fresh(task.id), card.path!).ok && readFileSync(card.path!, "utf8") === `${f.summary}\n`;
    }));
    allowRemoval();
    // Git itself reports that branch deletion started. Completion/timeout rejects this wait, so there
    // is no guessed sleep or unbounded barrier if the hook fails to execute.
    await new Promise<void>((resolve, reject) => {
      const timer = setInterval(() => { if (existsSync(branchReady)) { clearInterval(timer); resolve(); } }, 25);
      retirement!.then(() => { clearInterval(timer); if (!existsSync(branchReady)) reject(new Error("branch cleanup never reached its barrier")); }, error => { clearInterval(timer); reject(error); });
    });
    check("the native folder is gone while merged-branch deletion is held", !existsSync(wt.path) && existsSync(join(repo, ".git", "refs", "heads", wt.branch)));
    check("cards remain readable throughout pending branch cleanup", findings.every(f => {
      const card = db.getFinding(f.id)!;
      return resolveTaskDeliverable(fresh(task.id), card.path!).ok && readFileSync(card.path!, "utf8") === `${f.summary}\n`;
    }));
    writeFileSync(branchRelease, "released\n");
    await retirement;
    check("branch cleanup completes after its barrier is released", !existsSync(join(repo, ".git", "refs", "heads", wt.branch)));
    check("retirement preserves the main checkout's package contents", readFileSync(join(repo, "node_modules", "pkg", "index.js"), "utf8") === "1\n");
  } finally {
    allowRemoval();
    writeFileSync(branchRelease, "released\n");
    if (retirement) await retirement;
    internals.repointDeliverables = realRepoint;
  }
}

try {
  if (!process.argv.includes("--retirement-only")) {
  const repo = makeRepo(root, "app");

  console.log("0. default");
  check("a throwaway DB defaults worktrees OFF (gates dispatch into the real checkout)", mgr.settings().taskWorktrees === false);
  mgr.setSettings({ taskWorktrees: true });

  console.log("A. first start");
  const task = dispatch(repo, "Add dark mode");
  const prepared = await withNamer("dark-mode", async (calls) => {
    const result = await prepare(task);
    check("no naming call is spent on a task that may never need a branch", calls() === 0, String(calls()));
    return result;
  });
  check("the task stays in the main checkout", prepared?.workspace === repo, prepared?.workspace);
  check("...with no worktree cut", !prepared?.worktrees?.length && !existsSync(worktreesHome(repo)), JSON.stringify(prepared?.worktrees));
  check("mode is persisted as guided", mode(task.id) === "guided", mode(task.id));
  check("the main checkout never left master", git(repo, "branch", "--show-current") === "master");
  const guidance = section(fresh(task.id));
  check("its kickoff points at task_worktree for this repo", guidance.includes("task_worktree") && guidance.includes(repo), guidance);
  check("...only when another agent shares the repo", /alone in this repository/.test(guidance) && /another agent works in this repository/.test(guidance));
  check("...with the exact branch convention for CLI agents", guidance.includes(`ggo/<name>-${task.id.slice(0, 8)}`) && guidance.includes(worktreesHome(repo)));
  check("...and no integration step yet", !guidance.includes("--ff-only"));
  const again = await prepare(fresh(task.id));
  check("a second start changes nothing", again?.workspace === repo && !again?.worktrees?.length && mode(task.id) === "guided");

  console.log("A2. the agent claims a worktree");
  const claim = await mgr.claimTaskWorktree(task.id, { repo, name: "Dark mode toggle" });
  const wt = claim.ok ? claim.worktree : null;
  check("task_worktree cuts the agent-named branch", wt?.branch === `ggo/dark-mode-toggle-${task.id.slice(0, 8)}`, claim.ok ? wt?.branch : claim.error);
  check("...in <repo>.worktrees/<name>", !!wt && wt.path === join(worktreesHome(repo), "dark-mode-toggle") && existsSync(wt.path), wt?.path);
  check("...and tells the agent where to work and how to integrate", claim.ok && claim.text.includes(wt!.path) && claim.text.includes("--ff-only"));
  check("the binding is recorded on the task", fresh(task.id).worktrees?.length === 1);
  check("...without moving the task (its session's cwd stays valid)", fresh(task.id).workspace === repo);
  const claimed = section(fresh(task.id));
  check("later kickoffs name the claimed worktree and its integration", !!wt && claimed.includes(wt.path) && claimed.includes(wt.branch) && claimed.includes("--ff-only"), claimed);
  check("...and say the session may start in the main checkout", claimed.includes(`main checkout \`${repo}\``));
  const view = taskWorkCheckout(fresh(task.id));
  check("the Changes view reads the claimed worktree", !!wt && view.workspace === wt.path, view.workspace);
  check("...diffed from the branch's start", !!wt && view.baselineHead === wt.baseSha);
  writeFileSync(join(wt!.path, "report.md"), "# report\n");
  check("a deliverable inside the claimed worktree is servable", resolveTaskDeliverable(fresh(task.id), join(wt!.path, "report.md")).ok);
  const outside = join(root, "elsewhere.md");
  writeFileSync(outside, "x\n");
  const refused = resolveTaskDeliverable(fresh(task.id), outside);
  check("...while a file outside workspace and worktree is still refused", !refused.ok && refused.status === 403);
  rmSync(join(wt!.path, "report.md"));
  const repeat = await mgr.claimTaskWorktree(task.id, { repo: join(repo, "web") });
  check("claiming again (even from a subfolder) returns the same worktree", repeat.ok && repeat.worktree.path === wt?.path && fresh(task.id).worktrees?.length === 1);

  console.log("A3. a claim with no name is named after the work");
  await withNamer("crawler-email-extraction", async (calls) => {
    const brief = "We have another agent working in the crawler right now. The email extraction rate is too low, improve it.";
    const namedTask = dispatch(repo, "We have another agent working in…", { brief });
    await prepare(namedTask);
    const named = await mgr.claimTaskWorktree(namedTask.id, { repo });
    check("the branch is named after the work", named.ok && named.worktree.branch === `ggo/crawler-email-extraction-${namedTask.id.slice(0, 8)}`, named.ok ? named.worktree.branch : named.error);
    check("...and so is the folder", named.ok && basename(named.worktree.path) === "crawler-email-extraction");
    check("...with one naming call", calls() === 1, String(calls()));
  });

  console.log("B. dispatched on a subfolder");
  const sub = (await prepare(dispatch(join(repo, "web"), "Web only")))!;
  check("stays in the subfolder, guided", sub.workspace === join(repo, "web") && mode(sub.id) === "guided");
  check("its kickoff names the repo root, not the subfolder", section(fresh(sub.id)).includes(`git -C "${repo}" worktree add`), section(fresh(sub.id)));
  const subClaim = await mgr.claimTaskWorktree(sub.id, { repo: join(repo, "web"), name: "web only" });
  check("the Changes view maps into the claimed worktree's web", subClaim.ok && taskWorkCheckout(fresh(sub.id)).workspace === join(subClaim.worktree.path, "web"), subClaim.ok ? taskWorkCheckout(fresh(sub.id)).workspace : subClaim.error);

  console.log("C. tasks that hear no guidance");
  const child = await prepare(dispatch(repo, "Helper", { parentId: task.id }));
  check("a sub-task gets no mode of its own", child?.workspace === repo && !mode(child.id));
  const read = await prepare(dispatch(repo, "Look something up", { lane: "read" }));
  check("a read lane gets no mode", read?.workspace === repo && !mode(read.id) && section(read) === "");
  const legacy = await prepare(db.createThread({ title: "Old row", workspace: repo, rawPrompt: "x" }));
  check("a row from before the feature keeps working in place", legacy?.workspace === repo && !mode(legacy.id));
  mgr.setSettings({ taskWorktrees: false });
  const off = (await prepare(dispatch(repo, "Setting off")))!;
  check("with the setting off a task gets no guidance", off.workspace === repo && !mode(off.id) && section(off) === "");
  mgr.setSettings({ taskWorktrees: true });
  const nonRepo = join(root, "plain");
  mkdirSync(nonRepo);
  const plain = await prepare(dispatch(nonRepo, "Not a repo"));
  check("a plain folder works in place", plain?.workspace === nonRepo && mode(plain.id) === "in-place");
  const ownerMade = join(root, "owner-made");
  git(repo, "worktree", "add", "--quiet", "-b", "owner/feature", ownerMade);
  const picked = await prepare(dispatch(realpathSync(ownerMade), "In the owner's worktree"));
  check("a worktree the owner made works in place", !!picked && mode(picked.id) === "in-place" && section(picked) === "");

  console.log("D. restore on resume");
  const second = (await prepare(dispatch(repo, "Restore me")))!;
  const secondClaim = await mgr.claimTaskWorktree(second.id, { repo, name: "restore me" });
  if (!secondClaim.ok) throw new Error(secondClaim.error);
  const secondWt = secondClaim.worktree;
  await retireTaskWorktree(secondWt);
  check("(setup) its folder is gone", !existsSync(secondWt.path));
  const resumed = await prepare(fresh(second.id));
  check("resume brings the folder back", existsSync(secondWt.path) && resumed?.workspace === repo);
  check("...on the same branch", git(secondWt.path, "branch", "--show-current") === secondWt.branch);

  console.log("E. umbrella");
  const umbrella = join(root, "umbrella");
  mkdirSync(umbrella);
  const api = makeRepo(umbrella, "api", "git@example.com:acme/commit-only-origin.git");
  makeRepo(umbrella, "site");
  const umb = (await prepare(dispatch(umbrella, "Cross repo")))!;
  check("marked umbrella, works in place", mode(umb.id) === "umbrella" && umb.workspace === umbrella && !umb.worktrees?.length);
  check("its kickoff section points at task_worktree", section(umb).includes("task_worktree"));
  const umbClaim = await mgr.claimTaskWorktree(umb.id, { repo: "api" });
  check("task_worktree creates one for the named repo", umbClaim.ok && umbClaim.worktree.repo === api, umbClaim.ok ? umbClaim.worktree.repo : umbClaim.error);
  check("...commit-only from its origin", umbClaim.ok && umbClaim.worktree.commitOnly === true);
  check("...and tells the agent where to work", umbClaim.ok && umbClaim.text.includes(umbClaim.worktree.path) && umbClaim.text.includes("Never push:") && umbClaim.text.includes("--ff-only"));
  check("the binding is recorded on the task", fresh(umb.id).worktrees?.length === 1);
  check("later kickoffs list the claim", umbClaim.ok && section(fresh(umb.id)).includes(`Already claimed: \`${umbClaim.worktree.path}\``));
  const helper = dispatch(umbrella, "Umbrella helper", { parentId: umb.id });
  const viaChild = await mgr.claimTaskWorktree(helper.id, { repo: join(umbrella, "api") });
  check("a sub-task's claim returns its parent's worktree", viaChild.ok && umbClaim.ok && viaChild.worktree.path === umbClaim.worktree.path);
  check("...without adding a second binding", fresh(umb.id).worktrees?.length === 1 && !fresh(helper.id).worktrees?.length);
  const site = await mgr.claimTaskWorktree(helper.id, { repo: "site" });
  check("a second repo is added to the parent", site.ok && fresh(umb.id).worktrees?.length === 2);
  makeRepo(umbrella, "docs");
  const chosen = await mgr.claimTaskWorktree(umb.id, { repo: "docs", name: "API reference refresh" });
  check("task_worktree takes the agent's own name", chosen.ok && chosen.worktree.branch === `ggo/api-reference-refresh-${umb.id.slice(0, 8)}`, chosen.ok ? chosen.worktree.branch : chosen.error);
  const bad = await mgr.claimTaskWorktree(umb.id, { repo: "nope" });
  check("a folder that is not a repo is refused", !bad.ok);

  console.log("E1. a worktree a CLI agent made by hand");
  const cliTask = (await prepare(dispatch(repo, "CLI agent task")))!;
  const handBranch = `ggo/hand-made-${cliTask.id.slice(0, 8)}`;
  git(repo, "worktree", "add", "--quiet", "-b", handBranch, join(worktreesHome(repo), "hand-made"));
  await internals.syncHandMadeWorktrees(fresh(cliTask.id));
  const synced = fresh(cliTask.id).worktrees ?? [];
  check("it is discovered off the guided repo and recorded", synced.length === 1 && synced[0]!.branch === handBranch, synced.map((w) => w.branch).join(","));
  check("...and the task still runs in the main checkout", fresh(cliTask.id).workspace === repo);

  console.log("E2. a Co-worker turn in the main checkout");
  const coworkBusy = internals.coworkWorkspaceBusy;
  internals.coworkWorkspaceBusy = (w: string) => w === repo;
  check("holds a task that starts in that checkout", internals.repoAtCapacity(dispatch(repo, "Starts beside co-work")) === true);
  check("does not hold a task dispatched elsewhere", internals.repoAtCapacity(dispatch(api, "Elsewhere")) === false);
  internals.coworkWorkspaceBusy = coworkBusy;

  console.log("F. close retires");
  db.updateThread(task.id, { state: "review" });
  const closed = await mgr.closeThread(task.id);
  check("the task closes", closed.ok);
  check("its clean claimed worktree is removed", await settle(() => !existsSync(wt!.path)), wt?.path);
  check("...and the main checkout's packages survive", existsSync(join(repo, "node_modules", "pkg", "index.js")));

  console.log("F2. done retires an integrated worktree");
  const finishCommit = (folder: string, file: string): void => {
    writeFileSync(join(folder, file), "work\n");
    git(folder, "add", file);
    git(folder, "commit", "--quiet", "-m", file);
  };
  const integrated = (await prepare(dispatch(repo, "Integrated task")))!;
  const integratedClaim = await mgr.claimTaskWorktree(integrated.id, { repo, name: "integrated work" });
  if (!integratedClaim.ok) throw new Error(integratedClaim.error);
  finishCommit(integratedClaim.worktree.path, "integrated.txt");
  git(repo, "merge", "--quiet", "--ff-only", integratedClaim.worktree.branch);
  internals.setState(integrated.id, "done");
  check("its worktree is removed once the task is done", await settle(() => !existsSync(integratedClaim.worktree.path)), integratedClaim.worktree.path);
  check("...with its merged branch", await settle(() => !git(repo, "branch", "--list", integratedClaim.worktree.branch)));
  check("...and the main checkout's packages survive", existsSync(join(repo, "node_modules", "pkg", "index.js")));
  check("the Changes view reads the work from the main checkout", taskWorkCheckout(fresh(integrated.id)).workspace === repo);
  const stranded = (await prepare(dispatch(repo, "Stranded task")))!;
  const strandedClaim = await mgr.claimTaskWorktree(stranded.id, { repo, name: "stranded work" });
  if (!strandedClaim.ok) throw new Error(strandedClaim.error);
  finishCommit(strandedClaim.worktree.path, "stranded.txt");
  internals.setState(stranded.id, "done");
  const strandedNote = (): boolean => db.listMessages(stranded.id).some((m) => /not integrated into master/.test(m.content));
  check("an unintegrated one is kept, and the feed says why", (await settle(strandedNote)) && existsSync(strandedClaim.worktree.path));
  git(repo, "merge", "--quiet", "--ff-only", strandedClaim.worktree.branch);
  const notesBefore = db.listMessages(stranded.id).length;
  await internals.retireFinishedWorktrees();
  check("the boot sweep retires a done task's worktree integrated after it finished", !existsSync(strandedClaim.worktree.path));
  check("...without a new feed note", db.listMessages(stranded.id).length === notesBefore);

  console.log("F3. a done task's integrated worktree holding its deliverables");
  const delivering = (await prepare(dispatch(repo, "Delivering task")))!;
  const deliveringClaim = await mgr.claimTaskWorktree(delivering.id, { repo, name: "delivering work" });
  if (!deliveringClaim.ok) throw new Error(deliveringClaim.error);
  const dwt = deliveringClaim.worktree;
  finishCommit(dwt.path, "delivered-report.md");
  git(repo, "merge", "--quiet", "--ff-only", dwt.branch);
  const post = (path: string) => db.addFinding({ threadId: delivering.id, fromRole: "implementor", summary: "report", severity: "info", kind: "deliverable", path });
  const report = post(join(dwt.path, "delivered-report.md"));
  internals.setState(delivering.id, "done");
  const repointed = (): boolean => db.getFinding(report.id)?.path === join(repo, "delivered-report.md");
  check("its card moves to the main checkout's byte-identical copy", await settle(repointed), db.getFinding(report.id)?.path ?? "gone");
  check("...and the worktree it no longer pins is removed", await settle(() => !existsSync(dwt.path)), dwt.path);
  check("...which the console serves", resolveTaskDeliverable(fresh(delivering.id), db.getFinding(report.id)!.path!).ok);
  const diverged = (await prepare(dispatch(repo, "Diverged deliverable")))!;
  const divergedClaim = await mgr.claimTaskWorktree(diverged.id, { repo, name: "diverged work" });
  if (!divergedClaim.ok) throw new Error(divergedClaim.error);
  finishCommit(divergedClaim.worktree.path, "diverged-report.md");
  git(repo, "merge", "--quiet", "--ff-only", divergedClaim.worktree.branch);
  writeFileSync(join(repo, "diverged-report.md"), "rewritten later\n");
  git(repo, "commit", "--quiet", "-am", "later rewrite");
  const rewritten = db.addFinding({ threadId: diverged.id, fromRole: "implementor", summary: "report", severity: "info", kind: "deliverable", path: join(divergedClaim.worktree.path, "diverged-report.md") });
  internals.setState(diverged.id, "done");
  const followed = (): boolean => db.getFinding(rewritten.id)?.path === join(repo, "diverged-report.md");
  check("a committed deliverable the base later rewrote moves to the main checkout's version (git keeps the original)", await settle(followed), db.getFinding(rewritten.id)?.path ?? "gone");
  check("...and that worktree is removed too", await settle(() => !existsSync(divergedClaim.worktree.path)));
  const ignoredOnly = (await prepare(dispatch(repo, "Ignored output")))!;
  const ignoredClaim = await mgr.claimTaskWorktree(ignoredOnly.id, { repo, name: "ignored output" });
  if (!ignoredClaim.ok) throw new Error(ignoredClaim.error);
  writeFileSync(join(ignoredClaim.worktree.path, ".gitignore"), "node_modules/\nout/\n");
  git(ignoredClaim.worktree.path, "commit", "--quiet", "-am", "ignore out");
  git(repo, "merge", "--quiet", "--ff-only", ignoredClaim.worktree.branch);
  mkdirSync(join(ignoredClaim.worktree.path, "out"));
  writeFileSync(join(ignoredClaim.worktree.path, "out", "render.png"), "png\n");
  const own = db.addFinding({ threadId: ignoredOnly.id, fromRole: "implementor", summary: "render", severity: "info", kind: "deliverable", path: join(ignoredClaim.worktree.path, "out", "render.png") });
  internals.setState(ignoredOnly.id, "done");
  const keptNote = (): boolean => db.listMessages(ignoredOnly.id).some((m) => /a deliverable lives in it/.test(m.content));
  check("an ignored deliverable only the worktree holds keeps it", (await settle(keptNote)) && existsSync(ignoredClaim.worktree.path));
  check("...and its card is untouched", db.getFinding(own.id)?.path === join(ignoredClaim.worktree.path, "out", "render.png"));

  console.log("G. kickoff section of a sub-task");
  const borrowed = section(dispatch(repo, "Second helper", { parentId: second.id }));
  check("in its parent's claimed worktree, with no integration", borrowed.includes(secondWt.path) && !borrowed.includes("--ff-only"), borrowed);
  const unclaimedParent = (await prepare(dispatch(repo, "Unclaimed parent")))!;
  const thirdHelper = dispatch(repo, "Third helper", { parentId: unclaimedParent.id });
  check("no section while the parent works in the main checkout", section(thirdHelper) === "");
  const splitClaim = await mgr.claimTaskWorktree(thirdHelper.id, { repo, name: "split work" });
  check("...and its own claim is refused rather than splitting it from its parent", !splitClaim.ok && !fresh(unclaimedParent.id).worktrees?.length, splitClaim.ok ? splitClaim.worktree.path : splitClaim.error);
  const viaClaimedParent = await mgr.claimTaskWorktree(dispatch(repo, "Fifth helper", { parentId: second.id }).id, { repo });
  check("a sub-task of a parent that claimed one gets the parent's", viaClaimedParent.ok && viaClaimedParent.worktree.path === secondWt.path);

  console.log("H. office advice");
  const advice = internals.worktreeAdvice(unclaimedParent, false) as string | null;
  check("an unclaimed guided task is told to claim a worktree", !!advice && advice.includes("task_worktree"), advice ?? "null");
  check("...unless its brief or the owner named the branch", !!advice && /named the branch to work on, stay/.test(advice));
  const cliAdvice = internals.worktreeAdvice(unclaimedParent, true) as string | null;
  check("...a CLI agent through the git command in its brief", !!cliAdvice && cliAdvice.includes("git worktree add") && !cliAdvice.includes("task_worktree"));
  check("a task that claimed one hears nothing", internals.worktreeAdvice(fresh(second.id), false) === null);
  check("a sub-task hears nothing (a claim would land on its parent)", internals.worktreeAdvice(dispatch(repo, "Fourth helper", { parentId: unclaimedParent.id }), false) === null);
  check("an umbrella task hears nothing (its brief already says when)", internals.worktreeAdvice(umb, false) === null);
  }
  await retirementLifecycleRegression();
} finally {
  if (internals.capSupervisor) clearInterval(internals.capSupervisor);
  if (internals.tokenResumeTimer) clearTimeout(internals.tokenResumeTimer);
  await new Promise((r) => setTimeout(r, 200));
  db.raw.close();
  rmSync(root, { recursive: true, force: true });
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log("\nFailures:");
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
process.exit(0);
