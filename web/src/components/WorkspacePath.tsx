import { apiUrl } from "../lib/base.js";
import { useStore } from "../store.js";

/**
 * The workspace folder chip: the repo a task, co-work session or schedule runs in, shown as a dimmed
 * parent path plus a bright leaf folder, and clickable to open that folder in the host's file
 * manager. One component for every surface that prints a workspace, so the affordance can't drift
 * between the board card, the scheduled-task card and the task detail panel.
 */

/** Split a path into the dimmed parent and the bright leaf folder that the chip highlights. The leaf
 *  keeps its leading separator so it reads naturally, and it's the part the user scans for, so it is
 *  never truncated; the parent is what gives way when space is tight. */
export function splitWorkspace(p: string): { parent: string; leaf: string } {
  const norm = p.replace(/[\\/]+$/, "");
  const i = Math.max(norm.lastIndexOf("\\"), norm.lastIndexOf("/"));
  return i < 0 ? { parent: "", leaf: norm } : { parent: norm.slice(0, i), leaf: norm.slice(i) };
}

/** Ask the local server to open the folder, since a browser can't launch a file manager itself. A
 *  workspace that has since been deleted is an ordinary outcome here, so every refusal surfaces as a
 *  notice rather than a click that appears to do nothing. */
export async function openWorkspace(path: string): Promise<void> {
  let message = "The orchestrator server didn't answer, so the folder wasn't opened.";
  try {
    const response = await fetch(apiUrl("/api/fs/reveal"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path }),
    });
    if (response.ok) return;
    const body = (await response.json().catch(() => ({}))) as { error?: string };
    message = body.error || `The folder couldn't be opened (${response.status}).`;
  } catch {
    // Keep the message above: fetch only rejects when the request never reached the server at all.
  }
  useStore.setState({ notice: { level: "warn", title: "Couldn't open " + path, message } });
}

function FolderIcon() {
  return (
    <svg
      className="ws-ico"
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" />
    </svg>
  );
}

/** `chip` is the pill the board and scheduled-task cards carry; `meta` is the flatter line the task
 *  detail header uses, which keeps that header's quiet one-line look while gaining the same click.
 *
 *  `onOpen`/`destination` let a surface that has RESOLVED where this workspace lives send the click
 *  somewhere better than the file manager — the task detail panel routes it into the IDE. The default
 *  stays the File Explorer reveal, because a board card has no resolved context and a route is only
 *  offered when it can be taken (`.claude/rules/contextual-code-navigation.md`). The two labels are
 *  derived from `destination`, never passed separately: a chip that names one place and opens another
 *  is the same lie as a link to the wrong file. */
export function WorkspacePath({
  path,
  variant = "chip",
  onOpen,
  destination = "File Explorer",
}: {
  path: string;
  variant?: "chip" | "meta";
  onOpen?: () => void;
  destination?: string;
}) {
  const { parent, leaf } = splitWorkspace(path);

  return (
    <button
      type="button"
      className={"ws-path" + (variant === "meta" ? " ws-path-meta" : "")}
      title={"Open in " + destination + "\n" + path}
      aria-label={"Open " + path + " in " + destination}
      // A board card is itself one big click target (it selects the task) and a dnd-kit drag source,
      // so both events have to stop here: the click would also open the detail panel, and the
      // pointerdown would arm a drag instead of letting the press stay a click.
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => {
        e.stopPropagation();
        if (onOpen) onOpen();
        else void openWorkspace(path);
      }}
    >
      <FolderIcon />
      {parent ? <span className="ws-parent">{parent}</span> : null}
      <span className="ws-leaf">{leaf}</span>
    </button>
  );
}
