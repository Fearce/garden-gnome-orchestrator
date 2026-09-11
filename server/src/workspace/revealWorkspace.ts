import { spawn } from "node:child_process";
import { statSync } from "node:fs";
import { isAbsolute } from "node:path";
import { normalizeWorkspace, type CoworkSession, type ScheduledTask, type Thread } from "../types.js";

/**
 * Opening a task's workspace folder in the desktop file manager.
 *
 * The console runs in a browser and cannot launch Explorer itself, so the click travels to this
 * server (which runs on the same machine) and lands here. Deliberately NOT a general "open any path"
 * primitive: a request is only honoured for a folder this orchestrator already tracks as a
 * workspace, so the endpoint can never be turned into a launcher for arbitrary filesystem paths.
 * Nothing is ever assembled into a shell string; the path is passed as a single argv element.
 */

/** Why a reveal was refused: the HTTP status to answer with, and the sentence the console shows. */
export interface RevealRefusal {
  status: number;
  error: string;
}

export type RevealOutcome = { ok: true } | ({ ok: false } & RevealRefusal);

/** Starts a detached file-manager process. Resolves once the OS has accepted it. */
export type LaunchFileManager = (cmd: string, args: string[]) => Promise<void>;

/** The workspace-bearing rows this reveal is allowed to open, kept structural so tests need no Db. */
export interface WorkspaceSource {
  listThreads(): Pick<Thread, "workspace">[];
  listCoworkSessions(): Pick<CoworkSession, "workspace">[];
  listScheduledTasks(): Pick<ScheduledTask, "workspace">[];
}

/** Every workspace this console renders a path for, as normalized comparison keys. Tasks, co-work
 *  sessions and scheduled tasks are exactly the three surfaces that show a clickable folder chip, so
 *  this set is the allow-list: if the UI can show it the server will open it, and nothing else. */
export function knownWorkspaces(source: WorkspaceSource): Set<string> {
  const keys = new Set<string>();
  const add = (workspace: string | null | undefined): void => {
    const key = normalizeWorkspace((workspace ?? "").trim());
    if (key) keys.add(key);
  };
  for (const thread of source.listThreads()) add(thread.workspace);
  for (const session of source.listCoworkSessions()) add(session.workspace);
  for (const scheduled of source.listScheduledTasks()) add(scheduled.workspace);
  return keys;
}

/** The command that shows a folder in the host's file manager, or null where we don't know one. */
export function fileManagerCommand(platform: NodeJS.Platform, path: string): { cmd: string; args: string[] } | null {
  if (platform === "win32") return { cmd: "explorer.exe", args: [path] };
  if (platform === "darwin") return { cmd: "open", args: [path] };
  if (platform === "linux") return { cmd: "xdg-open", args: [path] };
  return null;
}

/** Spawn the file manager and hand it off to the desktop, argv-array so no path can be parsed as
 *  syntax. Success is the `spawn` event, never the exit code: explorer.exe exits 1 even when it has
 *  just opened the window, so waiting on the code would report every successful open as a failure. */
export const launchFileManager: LaunchFileManager = (cmd, args) =>
  new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { windowsHide: true, detached: true, stdio: "ignore" });
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
    child.once("error", reject);
  });

export interface RevealDeps {
  platform?: NodeJS.Platform;
  launch?: LaunchFileManager;
}

/** Open `rawPath` in the host's file manager, refusing anything that isn't a live known workspace. */
export async function revealWorkspace(rawPath: string, known: Set<string>, deps: RevealDeps = {}): Promise<RevealOutcome> {
  const platform = deps.platform ?? process.platform;
  const launch = deps.launch ?? launchFileManager;

  const path = (rawPath ?? "").trim();
  if (!path) return { ok: false, status: 400, error: "No folder was given." };
  if (!isAbsolute(path)) return { ok: false, status: 400, error: "Only an absolute folder path can be opened." };
  // Membership is checked before touching the disk, so the endpoint can't be used to probe which
  // arbitrary paths exist on this machine.
  if (!known.has(normalizeWorkspace(path))) {
    return { ok: false, status: 403, error: "That folder isn't a workspace this console knows about." };
  }

  // Workspaces really do get deleted underneath the board (a retired checkout, a cleaned worktree)
  // while the card keeps showing the path, so a missing folder is an expected answer, not a crash.
  let isDirectory: boolean;
  try {
    isDirectory = statSync(path).isDirectory();
  } catch {
    return { ok: false, status: 404, error: "That folder no longer exists on this machine." };
  }
  if (!isDirectory) return { ok: false, status: 400, error: "That workspace path isn't a folder." };

  const command = fileManagerCommand(platform, path);
  if (!command) return { ok: false, status: 501, error: `Opening a folder isn't supported on ${platform}.` };

  try {
    await launch(command.cmd, command.args);
  } catch {
    return { ok: false, status: 500, error: `The file manager couldn't be started (${command.cmd}).` };
  }
  return { ok: true };
}
