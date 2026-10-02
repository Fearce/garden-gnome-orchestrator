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
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import type { AccountManager } from "../accounts/accountManager.js";
import type { Thread } from "../types.js";

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

try {
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
  check("...and tells the agent where to work", umbClaim.ok && umbClaim.text.includes(umbClaim.worktree.path) && umbClaim.text.includes("Never push it"));
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
