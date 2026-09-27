import { realpathSync, statSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import { tmpdir } from "node:os";

// The one answer to "would GET /api/deliverable/:id serve this path?". The route asks it on every
// click; `post_deliverable` and the CLI `DELIVERABLE:` bridge ask it at emission, so a card that can
// never be served is refused while the agent can still fix it, instead of rendering as a broken image
// with a Download that fails. Security-critical: the path is agent-supplied and the server is
// LAN-reachable, so symlinks are resolved on BOTH sides and any `..` / absolute / cross-drive escape
// is rejected. A legitimate file outside the workspace gets moved, never the fence.

export const MAX_DELIVERABLE_BYTES = 25 * 1024 * 1024;

export type DeliverableResolution =
  | { ok: true; realFile: string; size: number }
  | { ok: false; status: 403 | 404 | 413; error: string };

export function resolveDeliverable(workspace: string, artifactPath: string): DeliverableResolution {
  const candidate = isAbsolute(artifactPath) ? artifactPath : join(workspace, artifactPath);
  let realWorkspace: string;
  let realFile: string;
  try {
    realWorkspace = realpathSync(workspace);
    realFile = realpathSync(candidate);
  } catch {
    return { ok: false, status: 404, error: "file not found" };
  }
  const rel = relative(realWorkspace, realFile);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
    return { ok: false, status: 403, error: "path escapes the task workspace" };
  }
  let st;
  try {
    st = statSync(realFile);
  } catch {
    return { ok: false, status: 404, error: "file not found" };
  }
  if (!st.isFile()) return { ok: false, status: 404, error: "not a file" };
  if (st.size > MAX_DELIVERABLE_BYTES) return { ok: false, status: 413, error: "file too large to serve" };
  return { ok: true, realFile, size: st.size };
}

/** What the posting agent reads when its deliverable is refused: the reason in its own terms and the
 *  one move that fixes it. */
export function deliverableRefusal(workspace: string, artifactPath: string, res: Extract<DeliverableResolution, { ok: false }>): string {
  const prefix = `Deliverable NOT recorded: the console could never serve "${artifactPath}".`;
  if (res.status === 403) {
    const scratch = isInsideDir(tmpdir(), artifactPath)
      ? " It is in a temp/scratch folder, which is outside every task workspace by construction."
      : "";
    return `${prefix} It is outside this task's workspace (${workspace}).${scratch} Copy the file into the workspace, then call post_deliverable again with that absolute path.`;
  }
  if (res.status === 413) {
    return `${prefix} It is over the ${MAX_DELIVERABLE_BYTES / (1024 * 1024)} MB serving cap. Surface a smaller file (a compressed or trimmed version) instead.`;
  }
  if (res.error === "not a file") return `${prefix} It is a directory, not a file. Surface the file itself.`;
  const relHint = isAbsolute(artifactPath) ? "" : ` A relative path resolves against the task workspace (${workspace}), not your current directory; pass an absolute path.`;
  return `${prefix} No file exists there.${relHint} Write the file first, then post it.`;
}

function isInsideDir(dir: string, path: string): boolean {
  if (!isAbsolute(path)) return false;
  const rel = relative(dir, path);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}
