/**
 * Integration test — a task's own git worktree (`server/src/orchestrator/taskWorktree.ts`) and the
 * kickoff words that go with it (`worktreeBriefing.ts`), against REAL git repos in a temp dir.
 *
 * The property that matters most is the one a green `git worktree remove` hides: the dependency folders
 * of a task worktree are junctions to the MAIN checkout's, and git deletes the main checkout's packages
 * through them. Every retire scenario therefore asserts the main checkout's node_modules survives.
 *
 * Scenarios:
 *   A. CREATE     — branch ggo/<slug>-<id8> in <repo>.worktrees/<slug>, junctioned node_modules, copied .env;
 *                   a chosen name (a model's, or the agent's) beats the title for both.
 *   B. REFUSE     — a branch already checked out elsewhere is refused, naming where.
 *   C. STATE      — dirty, ahead and merged read from the real branch.
 *   D. RETIRE     — refuses dirty or deliverable-holding; removes a merged one, deletes its branch, keeps
 *                   the main checkout's packages.
 *   E. RESTORE    — an unmerged worktree retires keeping its branch, and comes back on that branch.
 *   F. HAND-MADE  — a junction GGO never recorded is still unlinked before removal.
 *   G. UMBRELLA   — worktrees made by hand under a non-repo folder are discovered by the id suffix.
 *   H. BRIEFING   — own / commit-only / borrowed / umbrella / in-place kickoff sections.
 *
 * Run:  npm run test:task-worktree   (from server/)
 */

import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

process.env.NO_PUSH_REPO_PATTERN = "commit-only-origin";
const {
  childRepos,
  createTaskWorktree,
  discoverTaskWorktrees,
  readWorktreeState,
  restoreTaskWorktree,
  retireTaskWorktree,
  taskBranchName,
  worktreesHome,
} = await import("../orchestrator/taskWorktree.js");
const { worktreeBriefing } = await import("../orchestrator/worktreeBriefing.js");

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

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_TERMINAL_PROMPT: "0" }, windowsHide: true }).trim();
}

/** A repo on master with one commit, an ignored node_modules holding a package, and an ignored .env. */
function makeRepo(parent: string, name: string, origin?: string): string {
  const repo = join(parent, name);
  mkdirSync(repo, { recursive: true });
  git(repo, "init", "--quiet", "-b", "master");
  git(repo, "config", "user.name", "Worktree Test");
  git(repo, "config", "user.email", "worktree@example.com");
  git(repo, "config", "commit.gpgsign", "false");
  git(repo, "config", "core.autocrlf", "false");
  if (origin) git(repo, "remote", "add", "origin", origin);
  writeFileSync(join(repo, ".gitignore"), "node_modules/\n.env\n");
  writeFileSync(join(repo, "README.md"), "base\n");
  mkdirSync(join(repo, "node_modules", "left-pad"), { recursive: true });
  writeFileSync(join(repo, "node_modules", "left-pad", "index.js"), "module.exports = 1;\n");
  writeFileSync(join(repo, ".env"), "SECRET=1\n");
  git(repo, "add", ".gitignore", "README.md");
  git(repo, "commit", "--quiet", "-m", "initial");
  return realpathSync(repo);
}

const packageSurvives = (repo: string): boolean => existsSync(join(repo, "node_modules", "left-pad", "index.js"));
const branchExists = (repo: string, branch: string): boolean => {
  try {
    git(repo, "show-ref", "--verify", "--quiet", `refs/heads/${branch}`);
    return true;
  } catch {
    return false;
  }
};

function commitIn(folder: string, file: string, message: string): void {
  writeFileSync(join(folder, file), `${message}\n`);
  git(folder, "add", file);
  git(folder, "commit", "--quiet", "-m", message);
}

const root = mkdtempSync(join(tmpdir(), "ggo-task-worktree-"));
const THREAD = "0a1b2c3d-1111-2222-3333-444455556666";

try {
  console.log("A. create");
  const repo = makeRepo(root, "app");
  const created = await createTaskWorktree({ repoPath: repo, threadId: THREAD, title: "Fix the login form!" });
  check("the worktree is created", created.ok, created.ok ? undefined : created.error);
  if (!created.ok) throw new Error("cannot continue without a worktree");
  const wt = created.worktree;
  check("branch is ggo/<slug>-<id8>", wt.branch === "ggo/fix-the-login-form-0a1b2c3d", wt.branch);
  check("branch name helper agrees", taskBranchName("Fix the login form!", THREAD) === wt.branch);
  check("the folder is the words, without the id suffix", basename(wt.path) === "fix-the-login-form", wt.path);
  check("folder lives in <repo>.worktrees", wt.path.toLowerCase().startsWith(realpathSync(worktreesHome(repo)).toLowerCase()), wt.path);
  check("base is the main checkout's branch", wt.base === "master", String(wt.base));
  check("baseSha is the main checkout's HEAD", wt.baseSha === git(repo, "rev-parse", "HEAD"));
  check("the worktree is on its branch", git(wt.path, "branch", "--show-current") === wt.branch);
  check("node_modules is a junction", lstatSync(join(wt.path, "node_modules")).isSymbolicLink());
  check("...recorded as a link", !!wt.links?.includes("node_modules"), wt.links?.join(","));
  check("...that reaches the main checkout's packages", existsSync(join(wt.path, "node_modules", "left-pad", "index.js")));
  check(".env is copied", readFileSync(join(wt.path, ".env"), "utf8") === "SECRET=1\n");
  check("a repo without the commit-only origin may push", wt.commitOnly === false);
  check("the main checkout stays on master", git(repo, "branch", "--show-current") === "master");
  const NAMED = "5ec874c0-1111-2222-3333-444455556666";
  const named = await createTaskWorktree({ repoPath: repo, threadId: NAMED, title: "We have another agent working in", name: "crawler-email-extraction" });
  check("a chosen name names the branch, not the title", named.ok && named.worktree.branch === "ggo/crawler-email-extraction-5ec874c0", named.ok ? named.worktree.branch : named.error);
  check("...and the folder", named.ok && basename(named.worktree.path) === "crawler-email-extraction", named.ok ? named.worktree.path : "");
  const blank = await createTaskWorktree({ repoPath: repo, threadId: "77776666-0000-0000-0000-000000000000", title: "Tidy the docs", name: "  " });
  check("a blank name falls back to the title", blank.ok && blank.worktree.branch === "ggo/tidy-the-docs-77776666", blank.ok ? blank.worktree.branch : blank.error);
  if (named.ok) await retireTaskWorktree(named.worktree);
  if (blank.ok) await retireTaskWorktree(blank.worktree);

  console.log("B. refuse a branch checked out elsewhere");
  const again = await createTaskWorktree({ repoPath: repo, threadId: THREAD, title: "x", branch: wt.branch });
  check("refused", !again.ok);
  check("...naming the folder holding it", !again.ok && again.error.includes(wt.branch));
  const onMaster = await createTaskWorktree({ repoPath: repo, threadId: THREAD, title: "x", branch: "master" });
  check("the main checkout's own branch is refused", !onMaster.ok);

  console.log("C. state");
  const fresh = await readWorktreeState(wt);
  check("a fresh worktree (junction and .env included) is clean and untouched", fresh.exists && !fresh.dirty && fresh.untouched && !fresh.merged, JSON.stringify(fresh));
  writeFileSync(join(wt.path, "scratch.txt"), "wip\n");
  check("an untracked file reads as dirty", (await readWorktreeState(wt)).dirty);

  console.log("D. retire");
  const dirtyRetire = await retireTaskWorktree(wt);
  check("a dirty worktree is kept", !dirtyRetire.removed && existsSync(wt.path), dirtyRetire.reason);
  git(wt.path, "add", "scratch.txt");
  git(wt.path, "commit", "--quiet", "-m", "task work");
  const ahead = await readWorktreeState(wt);
  check("a commit reads as ahead 1, not merged", ahead.ahead === 1 && !ahead.merged && !ahead.untouched, JSON.stringify(ahead));
  writeFileSync(join(wt.path, "report.md"), "deliverable\n");
  git(wt.path, "add", "report.md");
  git(wt.path, "commit", "--quiet", "-m", "report");
  const keptForDeliverable = await retireTaskWorktree(wt, [join(wt.path, "report.md")]);
  check("a worktree holding a deliverable is kept", !keptForDeliverable.removed && existsSync(wt.path), keptForDeliverable.reason);
  git(repo, "merge", "--quiet", "--ff-only", wt.branch);
  const merged = await readWorktreeState(wt);
  check("after the fast-forward the branch reads merged", merged.merged && merged.ahead === 0, JSON.stringify(merged));
  const retired = await retireTaskWorktree(wt);
  check("a clean merged worktree is removed", retired.removed && !existsSync(wt.path), retired.reason);
  check("...and its merged branch deleted", retired.branchDeleted && !branchExists(repo, wt.branch));
  check("...and the MAIN checkout's packages survive", packageSurvives(repo));
  check("...and the main checkout has the work", existsSync(join(repo, "scratch.txt")));

  console.log("E. retire unmerged, then restore");
  const second = await createTaskWorktree({ repoPath: repo, threadId: "99998888-0000-0000-0000-000000000000", title: "Second task" });
  if (!second.ok) throw new Error(second.error);
  commitIn(second.worktree.path, "second.txt", "second task work");
  const tip = git(second.worktree.path, "rev-parse", "HEAD");
  const unmerged = await retireTaskWorktree(second.worktree);
  check("a clean unmerged worktree is removed", unmerged.removed && !existsSync(second.worktree.path), unmerged.reason);
  check("...but its branch is kept", !unmerged.branchDeleted && branchExists(repo, second.worktree.branch));
  check("...and the main checkout's packages survive", packageSurvives(repo));
  const restored = await restoreTaskWorktree(second.worktree);
  check("it is restored", restored.ok, restored.ok ? undefined : restored.error);
  check("...on its branch, at its tip", existsSync(second.worktree.path) && git(second.worktree.path, "rev-parse", "HEAD") === tip);
  check("...with its junction back", restored.ok && lstatSync(join(second.worktree.path, "node_modules")).isSymbolicLink());

  console.log("F. a junction GGO never recorded");
  const handMade = { ...(restored.ok ? restored.worktree : second.worktree), links: [] as string[] };
  check("the restored worktree still has its junction", lstatSync(join(handMade.path, "node_modules")).isSymbolicLink());
  const handRetire = await retireTaskWorktree(handMade);
  check("it is removed", handRetire.removed && !existsSync(handMade.path), handRetire.reason);
  check("...and the main checkout's packages survive", packageSurvives(repo));

  console.log("G. umbrella discovery");
  const umbrella = join(root, "umbrella");
  mkdirSync(umbrella);
  const api = makeRepo(umbrella, "api", "git@github.com:acme/commit-only-origin.git");
  makeRepo(umbrella, "web");
  const umbrellaBranch = taskBranchName("Umbrella task", THREAD);
  git(api, "worktree", "add", "--quiet", "-b", umbrellaBranch, join(worktreesHome(api), "umbrella-task"));
  git(api, "worktree", "add", "--quiet", "-b", "ggo/someone-else-ffffffff", join(worktreesHome(api), "other"));
  const found = await discoverTaskWorktrees(childRepos(umbrella), THREAD);
  check("exactly this task's worktree is found", found.length === 1 && found[0]!.branch === umbrellaBranch, found.map((w) => w.branch).join(","));
  check("...against the right repo", found[0]?.repo === api);
  check("...flagged commit-only from its origin", found[0]?.commitOnly === true);
  check("...based on the main checkout's branch", found[0]?.base === "master" && found[0]?.baseSha === git(api, "rev-parse", "HEAD"));
  check("the .worktrees folder is not mistaken for a repo", !found.some((w) => w.repo.endsWith(".worktrees")));
  const viaTool = await createTaskWorktree({ repoPath: join(umbrella, "web"), threadId: THREAD, title: "Umbrella task" });
  check("a task_worktree claim works on a repo inside the umbrella", viaTool.ok && viaTool.worktree.branch === umbrellaBranch);

  console.log("H. briefing");
  const own = worktreeBriefing({ threadId: THREAD, workspace: wt.path, mode: "worktree", worktrees: [wt], owner: "Kevin", autoPush: true });
  check("own: names the branch and folder", !!own && own.includes(wt.branch) && own.includes(wt.path));
  check("own: integrates by rebase + fast-forward + push", !!own && /rebase/.test(own) && /--ff-only/.test(own) && /push `master`/.test(own));
  check("own: forbids git worktree remove", !!own && own.includes("Never run `git worktree remove`"));
  const noPush = worktreeBriefing({ threadId: THREAD, workspace: wt.path, mode: "worktree", worktrees: [wt], owner: "Kevin", autoPush: false });
  check("auto-push off: never says to push the base", !!noPush && !/then push/.test(noPush) && /do not push/.test(noPush));
  const vota = worktreeBriefing({ threadId: THREAD, workspace: wt.path, mode: "worktree", worktrees: [{ ...wt, commitOnly: true }], owner: "Kevin", autoPush: true });
  check("commit-only: stays on the branch, never pushes or merges", !!vota && /Never push it and never merge it/.test(vota) && !/--ff-only/.test(vota));
  const borrowed = worktreeBriefing({ threadId: THREAD, workspace: wt.path, mode: "worktree", worktrees: [wt], owner: "Kevin", autoPush: true, borrowed: true });
  check("borrowed: works in the parent's worktree without integrating", !!borrowed && borrowed.includes("parent task") && !/--ff-only/.test(borrowed));
  const umb = worktreeBriefing({ threadId: THREAD, workspace: umbrella, mode: "umbrella", worktrees: [], owner: "Kevin", autoPush: true });
  check("umbrella: points at task_worktree and the exact branch convention", !!umb && umb.includes("task_worktree") && umb.includes(`-${THREAD.slice(0, 8)}`) && umb.includes("ggo/<name>"));
  check("umbrella: the agent names the branch itself, not from the title", !!umb && /`name`/.test(umb) && !umb.includes(umbrellaBranch));
  check("umbrella: a branch the owner named overrides the worktree rule", !!umb && /names the branch to work on in a repository/.test(umb) && /checkout that already has it/.test(umb));
  const guided = worktreeBriefing({ threadId: THREAD, workspace: join(repo, "web"), repoRoot: repo, mode: "guided", worktrees: [], owner: "Kevin", autoPush: true });
  check("guided: work here while alone, claim a worktree when the repo is shared", !!guided && /alone in this repository/.test(guided) && /another agent works in this repository/.test(guided) && guided.includes("task_worktree"));
  check("guided: the CLI fallback names the repo root and the branch convention", !!guided && guided.includes(`git -C "${repo}" worktree add -b ggo/<name>-${THREAD.slice(0, 8)}`) && guided.includes(worktreesHome(repo)));
  check("guided: no integration step before a claim", !!guided && !/--ff-only/.test(guided));
  check("guided: a branch the owner named outranks the worktree advice", !!guided && /names the branch to work on/.test(guided) && /claim no worktree and create no branch/.test(guided));
  const guidedClaimed = worktreeBriefing({ threadId: THREAD, workspace: repo, repoRoot: repo, mode: "guided", worktrees: [wt], owner: "Kevin", autoPush: true });
  check("guided + claimed: the own-worktree rules and integration", !!guidedClaimed && guidedClaimed.includes(wt.path) && /--ff-only/.test(guidedClaimed) && /never there/.test(guidedClaimed));
  check("guided sub-task of an unclaimed parent: no section", worktreeBriefing({ threadId: THREAD, workspace: repo, mode: "guided", worktrees: [], owner: "Kevin", autoPush: true, borrowed: true }) === null);
  check("in-place: no section",worktreeBriefing({ threadId: THREAD, workspace: repo, mode: "in-place", worktrees: [], owner: "Kevin", autoPush: true }) === null);
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log("\nFailures:");
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
