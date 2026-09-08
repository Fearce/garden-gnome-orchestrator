import type { CodeContext, CodeOrigin, IdeTarget, Thread } from "../types.js";

/**
 * Turning a resolved `CodeContext` into a navigation target. Every deep link in the console goes
 * through here, so the one rule that matters holds everywhere: a route is offered only when the
 * system actually knows where it goes. A missing IDE workspace id, a repo the IDE can't reach, or a
 * path that doesn't sit inside the workspace all return null, and the caller renders no button —
 * rather than a control that opens the wrong file or an error.
 */

/** Can this subject be opened in the editor at all? False for a workspace the IDE never registered. */
export const canOpenIde = (context: CodeContext | undefined): context is CodeContext =>
  !!context?.ideWorkspaceId;

/** Can this subject be opened in the Git console? Needs a real checkout, not just a folder. */
export const canOpenGit = (context: CodeContext | undefined): context is CodeContext =>
  !!context?.repoPath;

/** The IDE target for a subject's workspace root — "show me this task's code". */
export function ideWorkspaceTarget(context: CodeContext, mode: IdeTarget["mode"] = "files"): Omit<IdeTarget, "nonce"> | null {
  return context.ideWorkspaceId ? { workspaceId: context.ideWorkspaceId, mode } : null;
}

/**
 * The IDE target for one REPO-relative file — what a changed-file row or a diff header links to. The
 * IDE addresses files relative to the WORKSPACE, and a workspace is routinely the parent of its
 * checkout, so the repo prefix has to be prepended. `repoPrefix` is null when the repo sits above the
 * workspace: the file then has no in-workspace path at all and this correctly refuses.
 */
export function ideFileTarget(context: CodeContext, repoRelativePath: string, line?: number): Omit<IdeTarget, "nonce"> | null {
  if (!context.ideWorkspaceId || context.repoPrefix === null) return null;
  const path = joinWorkspacePath(context.repoPrefix, repoRelativePath);
  return path ? { workspaceId: context.ideWorkspaceId, path, ...(line && line > 0 ? { line } : {}) } : null;
}

/** Join the repo prefix and a repo-relative path into the IDE's workspace-relative form, or null when
 *  the result would leave the workspace. The server confines the path again when the file is read; this
 *  is what keeps a traversing path from becoming a rendered link in the first place. */
export function joinWorkspacePath(prefix: string, relative: string): string | null {
  const parts = [...prefix.split("/"), ...relative.replace(/\\/g, "/").split("/")].filter((p) => p && p !== ".");
  if (!parts.length || parts.some((p) => p === ".." || p.includes(":"))) return null;
  return parts.join("/");
}

/** How a task, co-work session or Supervisor row identifies itself for the return trip. */
export const threadOrigin = (thread: Pick<Thread, "id" | "title">): CodeOrigin => ({
  kind: "thread",
  id: thread.id,
  label: thread.title,
  view: "tasks",
});

export const coworkOrigin = (id: string, name: string): CodeOrigin => ({ kind: "cowork", id, label: name, view: "cowork" });

export const supervisorOrigin = (workspace: string, label: string): CodeOrigin => ({
  kind: "workspace",
  id: workspace,
  label,
  view: "supervisor",
});

/** The one-line branch reading a context bar shows. Kept here so the task panel, Co-work and the
 *  Supervisor audit can never word the same state differently. */
export function branchLabel(context: CodeContext): string {
  if (context.detached) return "detached HEAD";
  return context.branch ?? "no branch";
}
