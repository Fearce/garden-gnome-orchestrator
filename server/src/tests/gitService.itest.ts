/**
 * Integration test — the real-git "Changes" service (`server/src/gitService.ts`), against REAL git repos.
 *
 * The Changes surface (the in-console GitHub-Desktop replacement) is backed entirely by gitService: it
 * resolves a task's repo (even when the workspace is the PARENT of a nested checkout), reads the changed
 * files with per-file ±counts, the commit log with each commit tagged pushed-or-local, the branch list +
 * current branch, ahead/behind vs upstream, and the push state (with the Vota commit-only case neutral) —
 * plus per-file diffs and a guarded branch checkout.
 *
 * WHAT IS REAL: the entire gitService runs unmodified against throwaway on-disk repos. Only the "remote"
 * is a local bare repo instead of GitHub; every git operation is 100% real.
 *
 * Scenarios:
 *   A. RESOLVE     — workspace = repo root, workspace = PARENT of a nested repo, and a non-repo dir.
 *   B. STATUS      — modified + untracked + staged + deleted files, with correct statuses and ±counts.
 *   C. PUSH STATE  — a local commit not on @{push} reads "unpushed"/local; after a push it's "pushed".
 *   D. VOTA        — an origin whose url contains "vota" reads commit-only (neutral), never a push nag.
 *   E. BEHIND      — upstream moved ahead → behind > 0 after a fetch.
 *   F. DIFF        — a tracked modification, a brand-new untracked file, and a binary file.
 *   G. CHECKOUT    — switching to an existing branch succeeds; a nonexistent branch is refused.
 *
 * Run:  npm run test:git   (from server/)   — or:  npx tsx src/tests/gitService.itest.ts
 * Exits non-zero if any assertion fails. Self-contained: builds throwaway repos in a temp dir, removes them.
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { resolveRepoRoot, getGitStatus, getGitSummary, getTaskGitSummary, getTaskGitStatus, getHeadSha, getFileDiff, checkoutBranch } = await import("../gitService.js");

// ---- tiny assertion harness ------------------------------------------------------------------------
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

// ---- git helpers -----------------------------------------------------------------------------------
function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } }).trim();
}

function configureRepo(dir: string): void {
  git(dir, "config", "user.name", "Git Test");
  git(dir, "config", "user.email", "git-test@example.com");
  git(dir, "config", "commit.gpgsign", "false");
  git(dir, "config", "core.autocrlf", "false");
  git(dir, "config", "push.default", "simple");
}

/** A working clone of a fresh bare "origin", with one seed commit pushed. @{push} resolves to origin/master. */
function setupClone(base: string, name: string): { work: string; originBare: string } {
  const originBare = join(base, `${name}-origin.git`);
  const work = join(base, `${name}-work`);
  git(base, "init", "--quiet", "--bare", originBare);
  git(base, "clone", "--quiet", originBare, work);
  configureRepo(work);
  writeFileSync(join(work, "README.md"), "base\n");
  git(work, "add", "-A");
  git(work, "commit", "--quiet", "-m", "initial");
  git(work, "branch", "-M", "master");
  git(work, "push", "--quiet", "-u", "origin", "master");
  return { work, originBare };
}

function originCommit(base: string, originBare: string, tag: string, file: string, content: string): void {
  const w = join(base, `origin-work-${tag}`);
  git(base, "clone", "--quiet", originBare, w);
  configureRepo(w);
  writeFileSync(join(w, file), content);
  git(w, "add", "-A");
  git(w, "commit", "--quiet", "-m", `origin: ${file}`);
  git(w, "push", "--quiet", "origin", "master");
}

// ---- run -------------------------------------------------------------------------------------------
const root = mkdtempSync(join(tmpdir(), "gitservice-itest-"));
try {
  // ---- A. resolveRepoRoot ---------------------------------------------------------------------------
  console.log("\nA. resolveRepoRoot — repo root, nested-parent, and non-repo");
  {
    const { work } = setupClone(root, "resolve");
    const direct = await resolveRepoRoot(work);
    check("workspace = repo root resolves to itself", direct === git(work, "rev-parse", "--show-toplevel"), String(direct));

    // Nested layout: a parent dir that itself is NOT a repo but contains exactly one checkout.
    const parent = join(root, "nested-parent");
    mkdirSync(parent);
    const { work: inner } = setupClone(parent, "inner");
    const resolved = await resolveRepoRoot(parent);
    check("workspace = PARENT of a nested repo resolves to the nested repo", resolved === git(inner, "rev-parse", "--show-toplevel"), String(resolved));

    const plain = join(root, "not-a-repo");
    mkdirSync(plain);
    check("a non-repo dir resolves to null", (await resolveRepoRoot(plain)) === null);
  }

  // ---- A2. resolveRepoRoot — a parent with MULTIPLE nested repos (the REAL orchestrator layout) ------
  // The real task workspace is the PARENT (…/claude-orchastrator) which holds three nested git dirs:
  // the main fork checkout, a linked "-demo" worktree, and a helper clone. The resolver must pick the
  // name-matching main checkout, not bail — else the Changes chip appears on zero real cards.
  console.log("\nA2. resolveRepoRoot — parent with 3 nested repos picks the name-matching main checkout");
  {
    const parent = join(root, "claude-orchastrator"); // note: workspace folder name (typo variant of the repo)
    mkdirSync(parent);
    const originBare = join(root, "multi-origin.git");
    git(root, "init", "--quiet", "--bare", originBare);

    // The main fork checkout — folder name closely matches the workspace (claude-orchestrator).
    const main = join(parent, "claude-orchestrator");
    git(parent, "clone", "--quiet", originBare, "claude-orchestrator");
    configureRepo(main);
    writeFileSync(join(main, "README.md"), "main\n");
    git(main, "add", "-A");
    git(main, "commit", "--quiet", "-m", "init");
    git(main, "branch", "-M", "master");

    // A linked worktree sibling — its .git is a FILE, not a dir (a normal orchestrator artifact).
    git(main, "worktree", "add", "-q", join(parent, "claude-orchestrator-demo"));

    // A separate helper repo with a less-similar name.
    const lite = join(parent, "claude-resume-lite");
    git(parent, "init", "--quiet", "claude-resume-lite");
    configureRepo(lite);
    writeFileSync(join(lite, "x.txt"), "y\n");
    git(lite, "add", "-A");
    git(lite, "commit", "--quiet", "-m", "lite");

    const mainTop = git(main, "rev-parse", "--show-toplevel");
    const resolved = await resolveRepoRoot(parent);
    check("multi-nested parent resolves to the main orchestrator checkout (not null, not the worktree/helper)", resolved === mainTop, String(resolved));
    const s = await getGitStatus(parent);
    check("getGitStatus via the multi-nested parent is a repo", s.isRepo && s.repoRoot === mainTop, `${s.isRepo}/${s.repoRoot}`);
    const sum = await getGitSummary(parent);
    check("getGitSummary via the multi-nested parent is a repo (chip would render)", sum.isRepo, String(sum.isRepo));
  }

  // ---- B. status: file statuses + counts ------------------------------------------------------------
  console.log("\nB. getGitStatus — modified / untracked / staged / deleted files with ±counts");
  {
    const { work } = setupClone(root, "status");
    // A committed file we then modify; a second committed file we delete; a new untracked file; a staged add.
    writeFileSync(join(work, "keep.txt"), "line1\nline2\nline3\n");
    writeFileSync(join(work, "gone.txt"), "old\n");
    git(work, "add", "-A");
    git(work, "commit", "--quiet", "-m", "seed files");

    writeFileSync(join(work, "keep.txt"), "line1\nCHANGED\nline3\nline4\n"); // +2 -1
    rmSync(join(work, "gone.txt"));
    writeFileSync(join(work, "fresh.txt"), "brand new\nsecond\n"); // untracked, +2
    writeFileSync(join(work, "staged.txt"), "staged add\n");
    git(work, "add", "staged.txt");

    const s = await getGitStatus(work);
    check("isRepo true", s.isRepo);
    check("branch = master", s.branch === "master", String(s.branch));
    check("hasUncommitted true", s.hasUncommitted);
    const byPath = new Map(s.files.map((f) => [f.path, f]));
    check("keep.txt is modified", byPath.get("keep.txt")?.status === "modified", byPath.get("keep.txt")?.status);
    check("keep.txt counts +2/-1", byPath.get("keep.txt")?.added === 2 && byPath.get("keep.txt")?.removed === 1, `${byPath.get("keep.txt")?.added}/${byPath.get("keep.txt")?.removed}`);
    check("gone.txt is deleted", byPath.get("gone.txt")?.status === "deleted", byPath.get("gone.txt")?.status);
    check("fresh.txt is untracked", byPath.get("fresh.txt")?.status === "untracked", byPath.get("fresh.txt")?.status);
    check("fresh.txt untracked count +2", byPath.get("fresh.txt")?.added === 2, String(byPath.get("fresh.txt")?.added));
    check("staged.txt is added", byPath.get("staged.txt")?.status === "added", byPath.get("staged.txt")?.status);
    check("commit log has the seed commit", s.commits.some((c) => c.subject === "seed files"));

    // Summary mirrors the status: 4 changed files, aggregate +counts.
    const sum = await getGitSummary(work);
    check("summary fileCount = 4", sum.fileCount === 4, String(sum.fileCount));
    check("summary added aggregates (>=4)", sum.added >= 4, String(sum.added));
  }

  // ---- C. push state: unpushed → pushed -------------------------------------------------------------
  console.log("\nC. push state — a local commit is 'unpushed'/local, then 'pushed' after a push");
  {
    const { work } = setupClone(root, "push");
    writeFileSync(join(work, "local.txt"), "local work\n");
    git(work, "add", "-A");
    git(work, "commit", "--quiet", "-m", "local: unpushed commit");

    const before = await getGitStatus(work);
    check("unpushed = 1", before.unpushed === 1, String(before.unpushed));
    check("pushState = unpushed", before.pushState === "unpushed", before.pushState);
    check("the local commit is tagged local", before.commits.find((c) => c.subject === "local: unpushed commit")?.local === true);
    check("initial commit is NOT local (it's on origin)", before.commits.find((c) => c.subject === "initial")?.local === false);

    git(work, "push", "--quiet", "origin", "master");
    const after = await getGitStatus(work);
    check("unpushed = 0 after push", after.unpushed === 0, String(after.unpushed));
    check("pushState = pushed after push", after.pushState === "pushed", after.pushState);
  }

  // ---- D. Vota: commit-only, neutral ----------------------------------------------------------------
  console.log("\nD. Vota repo — origin url contains 'vota' → commit-only, never a push nag");
  {
    const votaBare = join(root, "fleet-vota.git");
    git(root, "init", "--quiet", "--bare", votaBare);
    const work = join(root, "vota-work");
    git(root, "clone", "--quiet", votaBare, work);
    configureRepo(work);
    writeFileSync(join(work, "board.txt"), "fleet\n");
    git(work, "add", "-A");
    git(work, "commit", "--quiet", "-m", "vota: board");
    git(work, "branch", "-M", "master");
    // Deliberately do NOT push — commit-only is the steady state.

    const s = await getGitStatus(work);
    check("isVota true", s.isVota);
    check("pushState = commit-only (neutral, despite unpushed commits)", s.pushState === "commit-only", s.pushState);
    const sum = await getGitSummary(work);
    check("summary pushState = commit-only", sum.pushState === "commit-only", sum.pushState);
    check("summary isVota true", sum.isVota);
  }

  // ---- E. behind: upstream moved ahead --------------------------------------------------------------
  console.log("\nE. behind — upstream moved ahead → behind > 0 after fetch");
  {
    const { work, originBare } = setupClone(root, "behind");
    originCommit(root, originBare, "behind", "UPSTREAM.md", "upstream change\n");
    git(work, "fetch", "--quiet", "origin"); // refresh remote-tracking refs (the poll does this in prod)
    const s = await getGitStatus(work);
    check("behind = 1", s.behind === 1, String(s.behind));
    check("pushState still pushed (nothing local to push)", s.pushState === "pushed", s.pushState);
  }

  // ---- F. per-file diff -----------------------------------------------------------------------------
  console.log("\nF. getFileDiff — tracked modification, untracked file, binary file");
  {
    const { work } = setupClone(root, "diff");
    writeFileSync(join(work, "code.txt"), "alpha\nbeta\ngamma\n");
    git(work, "add", "-A");
    git(work, "commit", "--quiet", "-m", "seed code");
    writeFileSync(join(work, "code.txt"), "alpha\nBETA\ngamma\ndelta\n"); // modify + add
    writeFileSync(join(work, "new.txt"), "fresh content\n"); // untracked
    writeFileSync(join(work, "blob.bin"), Buffer.from([0, 1, 2, 0, 255, 254, 0])); // binary untracked

    const modDiff = await getFileDiff(work, "code.txt");
    check("tracked diff not binary", !modDiff.binary);
    check("tracked diff shows the removed line", modDiff.patch.includes("-beta"), modDiff.patch.slice(0, 120));
    check("tracked diff shows the added line", modDiff.patch.includes("+BETA"));

    const newDiff = await getFileDiff(work, "new.txt");
    check("untracked diff shows the new content as additions", newDiff.patch.includes("+fresh content"), newDiff.patch.slice(0, 120));

    const binDiff = await getFileDiff(work, "blob.bin");
    check("binary file flagged binary", binDiff.binary, `patch: ${binDiff.patch.slice(0, 80)}`);
    // And the status file list marks it binary too.
    const s = await getGitStatus(work);
    check("binary file marked binary in status", s.files.find((f) => f.path === "blob.bin")?.binary === true);
  }

  // ---- G. checkout ----------------------------------------------------------------------------------
  console.log("\nG. checkoutBranch — switch to an existing branch; refuse a nonexistent one");
  {
    const { work } = setupClone(root, "checkout");
    git(work, "branch", "feature/x");
    const okRes = await checkoutBranch(work, "feature/x");
    check("checkout to existing branch ok", okRes.ok, okRes.error);
    check("HEAD now on feature/x", git(work, "rev-parse", "--abbrev-ref", "HEAD") === "feature/x");
    const status = await getGitStatus(work);
    check("status reports the new branch", status.branch === "feature/x", String(status.branch));
    check("branch list includes both branches", status.branches.includes("master") && status.branches.includes("feature/x"));

    const badRes = await checkoutBranch(work, "does-not-exist");
    check("checkout to a nonexistent branch is refused", badRes.ok === false && !!badRes.error, JSON.stringify(badRes));
    check("HEAD unchanged after a refused checkout", git(work, "rev-parse", "--abbrev-ref", "HEAD") === "feature/x");
  }

  // ---- H. task-scoped summary — attribute ONLY this task's diff, excluding foreign WIP/commits --------
  // The card chip's whole point: in a repo many agents share, a task must show only the files/commits IT
  // produced (dispatch baseline + its own written-file set), not the accreted working tree. Here a foreign
  // commit AND a foreign dirty file sit beside the task's own committed + modified + untracked files; the
  // task summary must count only the latter.
  console.log("\nH. getTaskGitSummary — task-scoped attribution excludes foreign commits & WIP");
  {
    const { work } = setupClone(root, "taskscope"); // seed: README.md "base\n", committed + pushed
    const baseline = await getHeadSha(work);
    check("getHeadSha returns the baseline sha", !!baseline && baseline === git(work, "rev-parse", "HEAD"), String(baseline));

    // A FOREIGN commit after the baseline (another task's landed work) — must NOT be attributed here.
    writeFileSync(join(work, "foreign.txt"), "someone else's committed work\n");
    git(work, "add", "-A");
    git(work, "commit", "--quiet", "-m", "foreign: unrelated committed work");

    // THIS task's own work: a committed new file, an uncommitted edit to a baseline file, an untracked file.
    writeFileSync(join(work, "task-a.txt"), "task line 1\ntask line 2\n"); // +2, committed by the task
    git(work, "add", "task-a.txt");
    git(work, "commit", "--quiet", "-m", "task: add task-a");
    writeFileSync(join(work, "README.md"), "base\ntask appended\n"); // +1 uncommitted (baseline had "base\n")
    writeFileSync(join(work, "task-new.md"), "n1\nn2\nn3\n"); // +3 untracked

    // FOREIGN uncommitted WIP (another agent's dirty tree) — not in the task's written set → excluded.
    // Two of them, so the repo-wide file count strictly exceeds the task's (a clean contrast below).
    writeFileSync(join(work, "foreign-dirty.txt"), "concurrent WIP\n");
    writeFileSync(join(work, "foreign-dirty2.txt"), "more concurrent WIP\n");

    const taskFiles = [join(work, "task-a.txt"), join(work, "README.md"), join(work, "task-new.md")];
    const sum = await getTaskGitSummary(work, { threadId: "ts-baseline", baselineHead: baseline, taskFiles });
    check("task summary is a repo", sum.isRepo);
    check("task fileCount = 3 (committed + modified + untracked task files only)", sum.fileCount === 3, String(sum.fileCount));
    check("task added = 6 (+2 task-a, +1 README, +3 untracked)", sum.added === 6, String(sum.added));
    check("task removed = 0", sum.removed === 0, String(sum.removed));
    check("task commitCount = 1 (the task commit, NOT the foreign commit)", sum.commitCount === 1, String(sum.commitCount));

    // Contrast: the repo-wide summary sees the foreign dirty file too — proving the scoping actually excludes it.
    const repoWide = await getGitSummary(work);
    check("repo-wide summary includes the foreign dirty file (task summary did not)", repoWide.fileCount > sum.fileCount, `repo ${repoWide.fileCount} vs task ${sum.fileCount}`);

    // Null-baseline fallback (legacy row / non-repo at dispatch): diff the task files vs HEAD instead —
    // still task-scoped, but commit-blind (HEAD already contains the task commit, so it reads 0).
    const fb = await getTaskGitSummary(work, { threadId: "ts-fallback", baselineHead: null, taskFiles });
    check("null-baseline fallback still excludes foreign (fileCount = 2: modified + untracked)", fb.fileCount === 2, String(fb.fileCount));
    check("null-baseline fallback commitCount = 0 (commit-blind)", fb.commitCount === 0, String(fb.commitCount));
    check("null-baseline fallback added = 4 (+1 README, +3 untracked)", fb.added === 4, String(fb.added));

    // An unresolvable/garbage baseline sha degrades to the same HEAD-relative fallback, never errors.
    const garbage = await getTaskGitSummary(work, { threadId: "ts-garbage", baselineHead: "0".repeat(40), taskFiles });
    check("garbage baseline degrades to HEAD fallback (no crash, fileCount = 2)", garbage.fileCount === 2, String(garbage.fileCount));

    // A task that wrote NO in-repo files reports an empty (but valid) chip, not the whole tree.
    const none = await getTaskGitSummary(work, { threadId: "ts-none", baselineHead: baseline, taskFiles: [] });
    check("no task files → empty diff (fileCount 0), still a repo with branch/push meta", none.fileCount === 0 && none.isRepo && none.branch === "master", `${none.fileCount}/${none.isRepo}/${none.branch}`);
  }

  // ---- I. task-scoped DRAWER status — files + commits scoped to ONE task, excludes foreign & siblings --
  // The bug this fixes: the drawer was repo-wide — its Changes list was the whole working tree and its
  // History was `git log -20` (read as "the entire repo history"). getTaskGitStatus scopes BOTH to the
  // task: net changed files (`diff <baseline> -- <task files>` + untracked task files) and the task's own
  // commits (`log <baseline>..HEAD -- <task files>`), while branch/push stay repo-wide. Here a foreign
  // commit, a foreign dirty file, and a SIBLING task's committed + untracked work all sit in the same repo;
  // each task's drawer must show only its own slice.
  console.log("\nI. getTaskGitStatus — the drawer is task-scoped (files + commits), excludes foreign & sibling-task work");
  {
    const { work } = setupClone(root, "drawerscope"); // seed README.md "base\n", committed + pushed
    const baseline = await getHeadSha(work);
    check("baseline sha captured", !!baseline);

    // A FOREIGN commit after the baseline (another task's landed work).
    writeFileSync(join(work, "foreign.txt"), "foreign committed work\n");
    git(work, "add", "-A");
    git(work, "commit", "--quiet", "-m", "foreign: committed work");

    // Task A: a committed new file, an uncommitted edit to a baseline file, an untracked note.
    writeFileSync(join(work, "a-feature.ts"), "export const a = 1;\n");
    git(work, "add", "a-feature.ts");
    git(work, "commit", "--quiet", "-m", "task-a: add a-feature");
    writeFileSync(join(work, "README.md"), "base\nA touched\n"); // +1 uncommitted
    writeFileSync(join(work, "a-note.md"), "note a\n"); // untracked

    // Task B: its own committed file + untracked note.
    writeFileSync(join(work, "b-feature.ts"), "export const b = 2;\n");
    git(work, "add", "b-feature.ts");
    git(work, "commit", "--quiet", "-m", "task-b: add b-feature");
    writeFileSync(join(work, "b-note.md"), "note b\n"); // untracked

    // Foreign uncommitted WIP (a concurrent agent's dirty tree).
    writeFileSync(join(work, "foreign-dirty.txt"), "concurrent WIP\n");

    const aFiles = [join(work, "a-feature.ts"), join(work, "README.md"), join(work, "a-note.md")];
    const bFiles = [join(work, "b-feature.ts"), join(work, "b-note.md")];

    const aStatus = await getTaskGitStatus(work, { threadId: "drawer-a", baselineHead: baseline, taskFiles: aFiles });
    check("A drawer is a repo with a diff anchor", aStatus.isRepo && aStatus.hasDiffAnchor);
    const aByPath = new Map(aStatus.files.map((f) => [f.path, f]));
    check("A files = exactly its 3 (a-feature, README, a-note)", aStatus.files.length === 3 && aByPath.has("a-feature.ts") && aByPath.has("README.md") && aByPath.has("a-note.md"), aStatus.files.map((f) => f.path).join(","));
    check("A files exclude foreign + sibling-B files", !aByPath.has("foreign.txt") && !aByPath.has("foreign-dirty.txt") && !aByPath.has("b-feature.ts") && !aByPath.has("b-note.md"));
    check("A file statuses: a-feature added / README modified / a-note untracked", aByPath.get("a-feature.ts")?.status === "added" && aByPath.get("README.md")?.status === "modified" && aByPath.get("a-note.md")?.status === "untracked", `${aByPath.get("a-feature.ts")?.status}/${aByPath.get("README.md")?.status}/${aByPath.get("a-note.md")?.status}`);
    const aSubjects = aStatus.commits.map((c) => c.subject);
    check("A commits = only its own (task-a), not foreign / sibling-B / initial", aStatus.commits.length === 1 && aSubjects.includes("task-a: add a-feature"), aSubjects.join(" | "));
    check("A commits exclude foreign + sibling-B + initial", !aSubjects.includes("foreign: committed work") && !aSubjects.includes("task-b: add b-feature") && !aSubjects.includes("initial"));
    check("A drawer keeps repo-wide branch/push metadata", aStatus.branch === "master" && aStatus.branches.includes("master") && aStatus.pushState === "unpushed", `${aStatus.branch}/${aStatus.pushState}`);

    const bStatus = await getTaskGitStatus(work, { threadId: "drawer-b", baselineHead: baseline, taskFiles: bFiles });
    const bByPath = new Set(bStatus.files.map((f) => f.path));
    check("B drawer lists only its 2 files (excludes A's + foreign)", bStatus.files.length === 2 && bByPath.has("b-feature.ts") && bByPath.has("b-note.md") && !bByPath.has("a-feature.ts") && !bByPath.has("README.md"), bStatus.files.map((f) => f.path).join(","));
    check("B commits = only task-b", bStatus.commits.length === 1 && bStatus.commits[0]?.subject === "task-b: add b-feature", bStatus.commits.map((c) => c.subject).join(" | "));

    // Contrast: the repo-wide drawer status sees everything (foreign + both tasks) — proves the scoping bites.
    const repoWide = await getGitStatus(work);
    check("repo-wide status includes more files than the task drawer (foreign+siblings)", repoWide.files.length > aStatus.files.length && repoWide.hasDiffAnchor === false, `repo ${repoWide.files.length} vs A ${aStatus.files.length}`);

    // Null-baseline (legacy row): no anchor → History reports no anchor (commits empty), file list falls back
    // to a HEAD-relative task diff (a-feature is already committed into HEAD, so only README + a-note show).
    const nullStatus = await getTaskGitStatus(work, { threadId: "drawer-null", baselineHead: null, taskFiles: aFiles });
    check("null-baseline drawer has NO diff anchor", nullStatus.hasDiffAnchor === false);
    check("null-baseline commits empty (range can't be isolated)", nullStatus.commits.length === 0, String(nullStatus.commits.length));
    const nullPaths = new Set(nullStatus.files.map((f) => f.path));
    check("null-baseline files = HEAD-relative task diff (README + a-note = 2, a-feature excluded)", nullStatus.files.length === 2 && nullPaths.has("README.md") && nullPaths.has("a-note.md") && !nullPaths.has("a-feature.ts"), [...nullPaths].join(","));
    check("null-baseline still carries repo-wide branch meta", nullStatus.isRepo && nullStatus.branch === "master");

    // Garbage baseline sha → same graceful fallback, never errors.
    const garbage = await getTaskGitStatus(work, { threadId: "drawer-garbage", baselineHead: "0".repeat(40), taskFiles: aFiles });
    check("garbage baseline degrades to fallback (no anchor, fileCount 2, no crash)", garbage.hasDiffAnchor === false && garbage.files.length === 2, `${garbage.hasDiffAnchor}/${garbage.files.length}`);

    // A task that wrote NO in-repo files → an empty (but valid) drawer, not the whole tree.
    const none = await getTaskGitStatus(work, { threadId: "drawer-none", baselineHead: baseline, taskFiles: [] });
    check("no task files → empty file list + commits, still a repo with branch meta", none.files.length === 0 && none.commits.length === 0 && none.isRepo && none.branch === "master", `${none.files.length}/${none.commits.length}/${none.branch}`);

    // Per-file diff is baseline-scoped: a-feature.ts is COMMITTED, so a HEAD-relative diff would be empty;
    // the baseline-aware diff must still show its full addition.
    const aDiff = await getFileDiff(work, "a-feature.ts", baseline);
    check("baseline-scoped diff of a committed task file shows its net addition", aDiff.patch.includes("+export const a = 1;"), aDiff.patch.slice(0, 120));
    const headDiff = await getFileDiff(work, "a-feature.ts", null);
    check("HEAD-relative diff of the same committed file is empty (proves the baseline scoping matters)", headDiff.patch.trim() === "", headDiff.patch.slice(0, 80));
  }

  console.log(`\n${failed === 0 ? "PASS" : "FAIL"} — ${passed} checks passed, ${failed} failed`);
  if (failed > 0) {
    console.log("Failures:\n  - " + failures.join("\n  - "));
    process.exitCode = 1;
  }
} finally {
  try {
    rmSync(root, { recursive: true, force: true });
  } catch {
    /* best-effort cleanup */
  }
}
