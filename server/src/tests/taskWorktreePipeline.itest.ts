/**
 * Integration test — how ThreadManager binds a task to its own worktree, using a real Db, EventHub and
 * throwaway git repos. Nothing spawns an agent: the methods under test run before any agent would.
 *
 * Scenarios:
 *   A. FIRST START  — a dispatched task moves into its own worktree once; workspace, binding, mode,
 *                     diff baseline and feed note all follow, and a second start reuses it.
 *   A2. NAMED       — with a model token, the branch and folder are named after the brief's work rather
 *                     than the dispatch-time title (the prompt's first words); task_worktree takes the
 *                     agent's own name.
 *   B. SUBFOLDER    — a task dispatched on <repo>/web keeps working in the worktree's web.
 *   C. NO WORKTREE  — sub-tasks, read lanes, pre-feature rows and the setting turned off stay in place.
 *   D. RESTORE      — a recorded worktree whose folder is gone comes back on resume.
 *   E. UMBRELLA     — a non-repo folder holding repos is marked umbrella; task_worktree claims one per
 *                     repo, a sub-task's claim lands on its parent, and asking again returns the same one.
 *   F. CLOSE        — closing a task retires its clean worktree and keeps the main checkout's packages.
 *   G. KICKOFF      — the worktree section a kickoff carries (own vs borrowed).
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
const { retireTaskWorktree } = await import("../orchestrator/taskWorktree.js");

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
const mode = (id: string): string | undefined => db.getThreadStageOutputs(id).workspaceMode;
const feed = (id: string): string => db.listMessages(id).map((m) => m.content).join("\n");
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

try {
  const repo = makeRepo(root, "app");

  console.log("0. default");
  check("a throwaway DB defaults worktrees OFF (gates dispatch into the real checkout)", mgr.settings().taskWorktrees === false);
  mgr.setSettings({ taskWorktrees: true });

  console.log("A. first start");
  const task = dispatch(repo, "Add dark mode");
  const prepared = await prepare(task);
  const wt = prepared?.worktrees?.[0];
  check("the task gets one worktree", prepared?.worktrees?.length === 1, JSON.stringify(prepared?.worktrees));
  check("...on its own branch", wt?.branch === `ggo/add-dark-mode-${task.id.slice(0, 8)}`, wt?.branch);
  check("workspace moves into it", !!wt && prepared?.workspace === wt.path, prepared?.workspace);
  check("homeWorkspace still names the repo", prepared?.homeWorkspace === repo);
  check("mode is persisted as worktree", mode(task.id) === "worktree");
  check("the diff baseline is the branch's start", db.getThread(task.id)?.baselineHead === wt?.baseSha);
  check("the feed says where it works", feed(task.id).includes(wt?.branch ?? "<none>"));
  const again = await prepare(db.getThread(task.id)!);
  check("a second start reuses the same worktree", again?.worktrees?.length === 1 && again.workspace === wt?.path);
  check("the main checkout never left master", git(repo, "branch", "--show-current") === "master");

  console.log("A2. named after the work");
  const realFetch = globalThis.fetch;
  let modelCalls = 0;
  globalThis.fetch = (async () => {
    modelCalls++;
    return new Response(JSON.stringify({ content: [{ type: "text", text: "crawler-email-extraction" }] }), { status: 200 });
  }) as typeof fetch;
  stubToken = "stub-token";
  try {
    const brief = "We have another agent working in the crawler right now. The email extraction rate is too low, improve it.";
    const namedTask = dispatch(repo, "We have another agent working in…", { brief });
    const named = (await prepare(namedTask))?.worktrees?.[0];
    check("the branch is named after the work", named?.branch === `ggo/crawler-email-extraction-${namedTask.id.slice(0, 8)}`, named?.branch);
    check("...and so is the folder", !!named && basename(named.path) === "crawler-email-extraction", named?.path);
    const callsAfterCreate = modelCalls;
    await prepare(db.getThread(namedTask.id)!);
    check("a later start does not ask for a name again", modelCalls === callsAfterCreate && callsAfterCreate === 1, String(modelCalls));
  } finally {
    globalThis.fetch = realFetch;
    stubToken = null;
  }

  console.log("B. dispatched on a subfolder");
  const sub = await prepare(dispatch(join(repo, "web"), "Web only"));
  check("works in the worktree's web folder", !!sub?.worktrees?.[0] && sub.workspace === join(sub.worktrees[0].path, "web"), sub?.workspace);

  console.log("C. tasks that stay in place");
  const child = await prepare(dispatch(repo, "Helper", { parentId: task.id }));
  check("a sub-task gets no worktree of its own", !child?.worktrees?.length && child?.workspace === repo);
  const read = await prepare(dispatch(repo, "Look something up", { lane: "read" }));
  check("a read lane gets no worktree", !read?.worktrees?.length && read?.workspace === repo);
  const legacy = await prepare(db.createThread({ title: "Old row", workspace: repo, rawPrompt: "x" }));
  check("a row from before the feature keeps working in place", !legacy?.worktrees?.length && legacy?.workspace === repo);
  mgr.setSettings({ taskWorktrees: false });
  const off = (await prepare(dispatch(repo, "Setting off")))!;
  check("with the setting off a new task works in place", !off?.worktrees?.length && off?.workspace === repo);
  db.createRun({ threadId: off.id, role: "implementor", model: "claude-x", account: "acct" });
  mgr.setSettings({ taskWorktrees: true });
  const offAgain = await prepare(db.getThread(off.id)!);
  check(
    "...and stays in place once its agent worked there, even after the setting is back on",
    !offAgain?.worktrees?.length && offAgain?.workspace === repo && mode(off.id) === "in-place",
    offAgain?.workspace,
  );
  const nonRepo = join(root, "plain");
  mkdirSync(nonRepo);
  const plain = await prepare(dispatch(nonRepo, "Not a repo"));
  check("a plain folder works in place", plain?.workspace === nonRepo && mode(plain.id) === "in-place");

  console.log("D. restore on resume");
  const second = (await prepare(dispatch(repo, "Restore me")))!;
  const secondWt = second.worktrees![0]!;
  await retireTaskWorktree(secondWt);
  check("(setup) its folder is gone", !existsSync(secondWt.path));
  const resumed = await internals.ensureWorktreesPresent(db.getThread(second.id)!);
  check("resume brings the folder back", existsSync(secondWt.path) && resumed.workspace === second.workspace);
  check("...on the same branch", git(secondWt.path, "branch", "--show-current") === secondWt.branch);

  console.log("E. umbrella");
  const umbrella = join(root, "umbrella");
  mkdirSync(umbrella);
  const api = makeRepo(umbrella, "api", "git@example.com:acme/commit-only-origin.git");
  makeRepo(umbrella, "site");
  const umb = (await prepare(dispatch(umbrella, "Cross repo")))!;
  check("marked umbrella, works in place", mode(umb.id) === "umbrella" && umb.workspace === umbrella && !umb.worktrees?.length);
  check("its kickoff section points at task_worktree", (internals.worktreeSection(umb) ?? "").includes("task_worktree"));
  const claim = await mgr.claimTaskWorktree(umb.id, { repo: "api" });
  check("task_worktree creates one for the named repo", claim.ok && claim.worktree.repo === api, claim.ok ? claim.worktree.repo : claim.error);
  check("...commit-only from its origin", claim.ok && claim.worktree.commitOnly === true);
  check("...and tells the agent where to work", claim.ok && claim.text.includes(claim.worktree.path) && claim.text.includes("Never push it"));
  check("the binding is recorded on the task", db.getThread(umb.id)?.worktrees?.length === 1);
  const helper = dispatch(umbrella, "Umbrella helper", { parentId: umb.id });
  const viaChild = await mgr.claimTaskWorktree(helper.id, { repo: join(umbrella, "api") });
  check("a sub-task's claim returns its parent's worktree", viaChild.ok && claim.ok && viaChild.worktree.path === claim.worktree.path);
  check("...without adding a second binding", db.getThread(umb.id)?.worktrees?.length === 1 && !db.getThread(helper.id)?.worktrees?.length);
  const site = await mgr.claimTaskWorktree(helper.id, { repo: "site" });
  check("a second repo is added to the parent", site.ok && db.getThread(umb.id)?.worktrees?.length === 2);
  makeRepo(umbrella, "docs");
  const chosen = await mgr.claimTaskWorktree(umb.id, { repo: "docs", name: "API reference refresh" });
  check("task_worktree takes the agent's own name", chosen.ok && chosen.worktree.branch === `ggo/api-reference-refresh-${umb.id.slice(0, 8)}`, chosen.ok ? chosen.worktree.branch : chosen.error);
  const bad = await mgr.claimTaskWorktree(umb.id, { repo: "nope" });
  check("a folder that is not a repo is refused", !bad.ok);

  console.log("E2. a Co-worker turn in the main checkout");
  const coworkBusy = internals.coworkWorkspaceBusy;
  internals.coworkWorkspaceBusy = (w: string) => w === repo;
  const freshTask = dispatch(repo, "Starts beside co-work");
  check("does not hold a task that will move into its own worktree", internals.repoAtCapacity(freshTask) === false);
  const legacyBusy = db.createThread({ title: "In place beside co-work", workspace: repo, rawPrompt: "x" });
  check("still holds a task that works in the main checkout", internals.repoAtCapacity(legacyBusy) === true);
  check("does not hold a task already in its worktree", internals.repoAtCapacity(db.getThread(second.id)!) === false);
  internals.coworkWorkspaceBusy = coworkBusy;

  console.log("F. close retires");
  db.updateThread(task.id, { state: "review" });
  const closed = await mgr.closeThread(task.id);
  check("the task closes", closed.ok);
  check("its clean worktree is removed", await settle(() => !existsSync(wt!.path)), wt?.path);
  check("...and the main checkout's packages survive", existsSync(join(repo, "node_modules", "pkg", "index.js")));

  console.log("G. kickoff section");
  const own = internals.worktreeSection(db.getThread(second.id)!) as string | null;
  check("own task: names its branch and the integration step", !!own && own.includes(secondWt.branch) && own.includes("--ff-only"));
  const borrowedChild = dispatch(second.workspace, "Second helper", { parentId: second.id });
  const borrowed = internals.worktreeSection(borrowedChild) as string | null;
  check("sub-task: the parent's worktree, no integration", !!borrowed && borrowed.includes(secondWt.path) && !borrowed.includes("--ff-only"));
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
