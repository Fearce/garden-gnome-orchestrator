import assert from "node:assert/strict";
import { branchLabel, canOpenGit, canOpenIde, ideFileTarget, ideWorkspaceTarget, joinWorkspacePath } from "../src/lib/codeNav.js";
import type { CodeContext } from "../src/types.js";

/**
 * The browser half of contextual navigation: turning a resolved context into a deep link. The rule
 * under test is that a route exists only when it can actually be taken — the server confines every
 * path again when it serves the file, but a link the console renders and then fails on is a defect in
 * its own right, and a link to the WRONG file is worse than no link.
 *
 * Run: npm run test:code-context --prefix server (this file runs beside the server-side resolver gate).
 */

const context = (over: Partial<CodeContext> = {}): CodeContext => ({
  kind: "thread",
  id: "t1",
  workspace: "C:/work/project",
  workspaceName: "project",
  ideWorkspaceId: "a".repeat(24),
  repoPath: "C:/work/project",
  repoName: "project",
  repoPrefix: "",
  branch: "master",
  detached: false,
  pushState: "pushed",
  unpushed: 0,
  behind: 0,
  hasUncommitted: false,
  error: null,
  ...over,
});

// ---- the two route gates -------------------------------------------------------------------------

assert.equal(canOpenIde(context()), true);
assert.equal(canOpenIde(context({ ideWorkspaceId: null })), false, "an unregistered workspace offers no editor route");
assert.equal(canOpenIde(undefined), false, "an unresolved context offers nothing at all");
assert.equal(canOpenGit(context()), true);
assert.equal(canOpenGit(context({ repoPath: null })), false, "a plain folder offers no Git route");

assert.deepEqual(ideWorkspaceTarget(context()), { workspaceId: "a".repeat(24), mode: "files" });
assert.deepEqual(ideWorkspaceTarget(context(), "git"), { workspaceId: "a".repeat(24), mode: "git" });
assert.equal(ideWorkspaceTarget(context({ ideWorkspaceId: null })), null);

// ---- repo-relative file → workspace-relative path ------------------------------------------------

assert.deepEqual(ideFileTarget(context(), "src/index.ts"), { workspaceId: "a".repeat(24), path: "src/index.ts" });
assert.deepEqual(ideFileTarget(context(), "src/index.ts", 42), { workspaceId: "a".repeat(24), path: "src/index.ts", line: 42 });
assert.deepEqual(
  ideFileTarget(context({ repoPrefix: "service" }), "src/index.ts"),
  { workspaceId: "a".repeat(24), path: "service/src/index.ts" },
  "a workspace that is the PARENT of its checkout needs the prefix prepended",
);
assert.equal(
  ideFileTarget(context({ repoPrefix: null }), "src/index.ts"),
  null,
  "a checkout ABOVE the workspace has no in-workspace path for its files",
);
assert.equal(ideFileTarget(context({ ideWorkspaceId: null }), "src/index.ts"), null);
// A line number is only carried when it is real; zero and negatives are absence, not position 0.
assert.deepEqual(ideFileTarget(context(), "a.ts", 0), { workspaceId: "a".repeat(24), path: "a.ts" });
assert.deepEqual(ideFileTarget(context(), "a.ts", -3), { workspaceId: "a".repeat(24), path: "a.ts" });

// ---- path joining refuses anything that would leave the workspace --------------------------------

assert.equal(joinWorkspacePath("", "src/index.ts"), "src/index.ts");
assert.equal(joinWorkspacePath("service", "src/a.ts"), "service/src/a.ts");
assert.equal(joinWorkspacePath("", "src\\windows\\a.ts"), "src/windows/a.ts", "git can report either separator");
assert.equal(joinWorkspacePath("", "./src/./a.ts"), "src/a.ts");
assert.equal(joinWorkspacePath("", "src//a.ts"), "src/a.ts");
for (const escape of ["../outside.ts", "src/../../outside.ts", "C:/absolute.ts", "..", ""]) {
  assert.equal(joinWorkspacePath("", escape), null, `must refuse ${JSON.stringify(escape)}`);
}
assert.equal(joinWorkspacePath("service", "../sibling/a.ts"), null, "a prefix does not license a traversal");

// ---- the branch reading ---------------------------------------------------------------------------

assert.equal(branchLabel(context()), "master");
assert.equal(branchLabel(context({ detached: true, branch: null })), "detached HEAD");
assert.equal(branchLabel(context({ branch: null })), "no branch", "a repo with no branch never reads as one");

console.log("code navigation: route gates, prefix joining, traversal refusal and branch labels passed.");
