import { basename } from "node:path";
import { config } from "../config.js";
import type { Db } from "../db/db.js";
import { discoverRepos } from "../git/discoverRepos.js";
import { getFileDiff, resolveRepoRoot, type GitFileDiff } from "../gitService.js";
import {
  TREE_MUTATING_ACTIONS,
  getCommitDetail,
  getCommitFileDiff,
  getRepoState,
  runRepoAction,
  validRepoPath,
  type RepoActionResult,
  type RepoCommitDetail,
  type RepoOp,
  type RepoState,
} from "../git/repoOps.js";
import type { ThreadState } from "../types.js";

// The Git console's service layer: which repositories the operator can act on, and the one rule the raw
// git module deliberately can't enforce — don't yank a branch (or the working tree) out from under an
// agent that is live in that repo.
//
// Standalone by design: it depends on `Db` alone, never on ThreadManager. That keeps the import graph
// acyclic and means a change here can't collide with pipeline work in threadManager.ts.

/** Thread states in which an agent process is alive with the workspace open — a checkout, a pull or a
 *  discard underneath one of these corrupts real work in flight. Deliberately narrower than the
 *  pipeline's IN_FLIGHT set: `queued`/`intake`/`enriching`/`awaiting_approval` have no agent in the
 *  workspace, so they must not block the operator. `awaiting_user` DOES — its implementor is alive and
 *  merely blocked on a question. */
const WORKING_STATES: ReadonlySet<ThreadState> = new Set([
  "planning",
  "researching",
  "implementing",
  "qa",
  "reviewing",
  "paused",
  "awaiting_user",
]);

/** How many distinct task workspaces we bother resolving into repo roots for the picker. Resolution is
 *  cached in gitService, and workspaces repeat heavily across tasks, so this is generous in practice —
 *  it exists so a DB with thousands of threads can't turn the picker into a filesystem sweep. */
const MAX_WORKSPACE_SCAN = 80;

/** How long a disk scan for repositories is reused. Long enough that opening the console repeatedly
 *  never re-walks the drives, short enough that a repo cloned earlier today shows up on its own; the
 *  picker's Rescan is there for the impatient case. */
const DISCOVERY_TTL_MS = 10 * 60_000;

export interface RepoRef {
  /** The resolved repo root — the identity every other command uses. */
  path: string;
  name: string;
  /** How many tasks in the console live in this repo (any state) — the picker's "why is this here". */
  taskCount: number;
  /** How many of those have an agent live in the workspace right now. */
  activeCount: number;
  /** True for the orchestrator's own checkout, which is always offered even with no tasks against it. */
  isSelf: boolean;
  /** Found by scanning the disk rather than known from a dispatch — sorted below the repos in use. */
  discovered: boolean;
}

/** A task with an agent live in the repo — what the safety gate names when it refuses. */
export interface RepoBusyTask {
  id: string;
  title: string;
  state: ThreadState;
}

export interface RepoStateDTO extends RepoState {
  busy: RepoBusyTask[];
}

export interface RepoActionDTO extends RepoActionResult {
  /** The refusal came from the live-agent gate, not from git — the console offers an explicit override
   *  rather than a dead button. */
  blocked: boolean;
}

export class RepoConsole {
  private discoveryCache: { at: number; roots: string[] } | null = null;
  private discoveryInFlight: Promise<string[]> | null = null;

  constructor(
    private readonly db: Db,
    /** The orchestrator's own checkout, always listed so the console works before any task exists. */
    private readonly selfRepo: string,
  ) {}

  /** Every repository the console offers, so the picker is populated without anyone typing a path:
   *  the orchestrator's own checkout, the operator's recent repos and every task workspace (the repos
   *  actually in use), plus every git checkout found by scanning the configured search roots. All
   *  resolved to real repo roots and deduped, so the parent-of-a-nested-checkout spellings that tasks
   *  use collapse onto one entry. Ordered by how much this console has to do with each: live agents,
   *  then task count, then the ones merely found on disk. */
  async list(rescan = false): Promise<RepoRef[]> {
    const threads = this.db.listThreads();
    const cowork = this.db.listCoworkSessions();
    const known = [this.selfRepo, ...this.recentRepos(), ...threads.map((t) => t.workspace), ...cowork.map((session) => session.workspace)]
      .map((p) => (p ?? "").trim())
      .filter(Boolean);

    const selfRoot = await resolveRepoRoot(this.selfRepo);
    const roots = new Map<string, RepoRef>();
    const workspaceRoot = new Map<string, string | null>();

    const add = (root: string, discovered: boolean): void => {
      if (roots.has(root)) return;
      roots.set(root, {
        path: root,
        name: basename(root.replace(/[\\/]+$/, "")) || root,
        taskCount: 0,
        activeCount: 0,
        isSelf: root === selfRoot,
        discovered,
      });
    };

    // Known repos first: a workspace can be the PARENT of its checkout, so each needs resolving, and
    // the mapping is kept to attribute task counts below.
    let scanned = 0;
    for (const candidate of known) {
      if (workspaceRoot.has(candidate)) continue;
      if (scanned >= MAX_WORKSPACE_SCAN) break;
      scanned++;
      const root = await resolveRepoRoot(candidate);
      workspaceRoot.set(candidate, root);
      if (root) add(root, false);
    }

    for (const root of await this.discovered(rescan)) add(root, true);

    for (const t of threads) {
      const root = workspaceRoot.get((t.workspace ?? "").trim());
      const ref = root ? roots.get(root) : undefined;
      if (!ref) continue;
      ref.taskCount++;
      if (WORKING_STATES.has(t.state)) ref.activeCount++;
    }
    for (const session of cowork) {
      const root = workspaceRoot.get((session.workspace ?? "").trim());
      const ref = root ? roots.get(root) : undefined;
      if (!ref) continue;
      ref.taskCount++;
      if (session.activeTurnId || session.state === "running" || session.state === "stopping") ref.activeCount++;
    }

    return [...roots.values()].sort((a, b) => {
      if (a.activeCount !== b.activeCount) return b.activeCount - a.activeCount;
      if (a.taskCount !== b.taskCount) return b.taskCount - a.taskCount;
      if (a.discovered !== b.discovered) return a.discovered ? 1 : -1;
      return a.name.localeCompare(b.name);
    });
  }

  /** The repo root a task's work lives in — what the console opens on when a task is selected, so
   *  clicking Git while looking at a task lands in that task's repository. Null when the task is gone
   *  or its workspace isn't a checkout. Resolved server-side deliberately: a workspace is often the
   *  PARENT of its repo, and re-deriving that mapping in the browser would be a copy that drifts. */
  async repoForThread(threadId: string): Promise<string | null> {
    const workspace = this.db.getThread(threadId)?.workspace?.trim();
    return workspace ? resolveRepoRoot(workspace) : null;
  }

  /** The on-disk scan, memoized: walking whole drives is far too expensive to repeat every time the
   *  picker opens, and repos don't appear that often. `rescan` is the picker's explicit Rescan. */
  private async discovered(rescan: boolean): Promise<string[]> {
    if (!rescan && this.discoveryCache && Date.now() - this.discoveryCache.at < DISCOVERY_TTL_MS) {
      return this.discoveryCache.roots;
    }
    // One scan at a time: two consoles opening at once must not walk the drive twice.
    this.discoveryInFlight ??= discoverRepos(config.workspaceSearchRoots)
      .then((roots) => {
        this.discoveryCache = { at: Date.now(), roots };
        return roots;
      })
      .catch(() => this.discoveryCache?.roots ?? [])
      .finally(() => {
        this.discoveryInFlight = null;
      });
    return this.discoveryInFlight;
  }

  /** Full console state for one repo, plus the tasks currently working in it (which is what makes the
   *  destructive buttons explain themselves before you click). */
  async state(path: string): Promise<RepoStateDTO> {
    const state = await getRepoState(path);
    return { ...state, busy: state.isRepo ? await this.busyTasks(state.path) : [] };
  }

  /** A working-tree file's diff vs HEAD, or a file's diff inside a commit when `commit` is given. The
   *  path is operator-supplied, and the untracked-file branch of `getFileDiff` diffs against the null
   *  device — which would happily render a file OUTSIDE the repo as one big addition — so a traversing
   *  path is rejected here rather than relied upon to fail inside git. */
  async diff(path: string, file: string, commit?: string): Promise<GitFileDiff> {
    if (!validRepoPath(file)) return { path: file, binary: false, patch: "", truncated: false };
    return commit ? getCommitFileDiff(path, commit, file) : getFileDiff(path, file, null);
  }

  async commitDetail(path: string, hash: string): Promise<RepoCommitDetail> {
    return getCommitDetail(path, hash);
  }

  /** Run an action, refusing the tree-mutating ones while an agent is live in the repo unless the
   *  operator explicitly overrode it. The refusal names the tasks — a bare "busy" would just get
   *  force-clicked. */
  async action(path: string, op: RepoOp, force: boolean): Promise<RepoActionDTO> {
    if (TREE_MUTATING_ACTIONS.has(op.action) && !force) {
      const root = await resolveRepoRoot(path);
      const busy = root ? await this.busyTasks(root) : [];
      if (busy.length > 0) return { ok: false, blocked: true, message: busyMessage(op.action, busy) };
    }
    const result = await runRepoAction(path, op);
    return { ...result, blocked: false };
  }

  /** Tasks with an agent live in this repo. Resolves each candidate workspace to its root so a task
   *  whose workspace is the PARENT of the checkout still counts. */
  private async busyTasks(repoRoot: string): Promise<RepoBusyTask[]> {
    const busy: RepoBusyTask[] = [];
    for (const t of this.db.listThreads()) {
      if (!WORKING_STATES.has(t.state)) continue;
      const root = await resolveRepoRoot((t.workspace ?? "").trim());
      if (root !== repoRoot) continue;
      busy.push({ id: t.id, title: t.title, state: t.state });
    }
    for (const session of this.db.listCoworkSessions()) {
      if (!session.activeTurnId && session.state !== "running" && session.state !== "stopping") continue;
      const root = await resolveRepoRoot((session.workspace ?? "").trim());
      if (root !== repoRoot) continue;
      busy.push({ id: `cowork:${session.id}`, title: `Co-work: ${session.name}`, state: "implementing" });
    }
    return busy;
  }

  /** The operator's recent-repo list, shared with the dispatch composer (kv `setting_recent_repos`). */
  private recentRepos(): string[] {
    const raw = this.db.kvGet("setting_recent_repos");
    if (!raw) return [];
    try {
      const v = JSON.parse(raw) as unknown;
      return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
    } catch {
      return [];
    }
  }
}

const ACTION_VERB: Record<string, string> = {
  checkout: "Switching branches",
  pull: "Pulling",
  discard: "Discarding changes",
};

function busyMessage(action: RepoOp["action"], busy: RepoBusyTask[]): string {
  const names = busy.slice(0, 3).map((t) => `“${t.title}”`).join(", ");
  const more = busy.length > 3 ? ` and ${busy.length - 3} more` : "";
  const verb = ACTION_VERB[action] ?? "This";
  return `${verb} would change files under ${busy.length} running agent${busy.length === 1 ? "" : "s"}: ${names}${more}.`;
}
