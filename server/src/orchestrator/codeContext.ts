import { basename, relative, resolve, sep } from "node:path";
import { lstat, realpath } from "node:fs/promises";
import type { Db } from "../db/db.js";
import type { IdeService } from "../ide/service.js";
import { getRepoHeadState, gitCacheGeneration, resolveRepoRoot, type PushState, type RepoHeadState } from "../gitService.js";

// One resolved answer to "where does this work live, and how do I get into it" — the single seam the
// console's contextual navigation runs on. Everything here already exists somewhere (a thread's
// workspace, the IDE's workspace registry, the repo root, git's branch state); what did not exist was a
// server-resolved bundle the browser can turn into a deep link without re-deriving any of it.
//
// Standalone by design, like `repoConsole.ts` and `notes.ts`: it depends on `Db` + `IdeService` and
// never on ThreadManager, so the import graph stays acyclic and pipeline work can't collide with it.

/** What a navigation target can be about. `workspace` covers surfaces that know a path but no owning
 *  record — a Supervisor audit row is the case that exists today. */
export type CodeSubjectKind = "thread" | "cowork" | "workspace";

export interface CodeSubject {
  kind: CodeSubjectKind;
  /** Thread id, co-work session id, or (for `workspace`) the absolute workspace path. */
  id: string;
}

export interface CodeContext {
  kind: CodeSubjectKind;
  id: string;
  /** Absolute workspace path, or null when the subject is gone / has no workspace recorded. */
  workspace: string | null;
  /** Display name for the workspace folder. */
  workspaceName: string | null;
  /** The IDE's own workspace id, so the browser can deep-link straight into the editor. Null when the
   *  path isn't a registered, openable directory — the IDE would refuse it, so the button must not exist. */
  ideWorkspaceId: string | null;
  /** Resolved git repo root for the workspace, or null when it isn't a checkout. */
  repoPath: string | null;
  /** The folder/IDE route is ready while slower Git metadata is still being filled in. */
  gitPending: boolean;
  repoName: string | null;
  /** The repo root relative to the workspace, forward slashes ("" when they are the same folder). Null
   *  when the repo is ABOVE the workspace: a repo-relative changed file then has no path the IDE can
   *  open, and the caller must not guess one. */
  repoPrefix: string | null;
  branch: string | null;
  detached: boolean;
  pushState: PushState;
  /** Local commits not yet on the push remote. */
  unpushed: number;
  /** Commits the tracked upstream has that this checkout doesn't. */
  behind: number;
  hasUncommitted: boolean;
  /** Why there is nothing to navigate to — shown verbatim, so it has to read as an explanation. */
  error: string | null;
}

/** A resolution is several `stat`s plus a git sweep. Task cards, the Co-work list and the Supervisor
 *  audit all ask about the same handful of workspaces, so a short cache turns a screenful of surfaces
 *  into one filesystem pass while still noticing a branch switch within a few seconds. */
const CACHE_TTL_MS = 4000;

const subjectKey = (subject: CodeSubject): string => `${subject.kind}:${subject.id}`;

type WorkspaceContext = Omit<CodeContext, "kind" | "id">;

interface WorkspaceCacheEntry {
  at: number;
  generation: number;
  quick: Promise<WorkspaceContext>;
  full?: Promise<WorkspaceContext>;
}

interface SubjectCacheEntry {
  at: number;
  generation: number;
  shared?: WorkspaceCacheEntry;
  quick: Promise<CodeContext>;
  full?: Promise<CodeContext>;
}

/** Injectable so the gate can hold the expensive half unresolved and verify the fast route. */
export interface CodeContextGit {
  resolveRepoRoot(workspace: string): Promise<string | null>;
  getRepoHeadState(workspace: string): Promise<RepoHeadState>;
  generation(): number;
}

const DEFAULT_GIT: CodeContextGit = {
  resolveRepoRoot,
  getRepoHeadState,
  generation: gitCacheGeneration,
};

const emptyContext = (subject: CodeSubject, error: string | null, workspace: string | null = null): CodeContext => ({
  kind: subject.kind,
  id: subject.id,
  workspace,
  workspaceName: workspace ? basename(workspace.replace(/[\\/]+$/, "")) || workspace : null,
  ideWorkspaceId: null,
  repoPath: null,
  gitPending: false,
  repoName: null,
  repoPrefix: null,
  branch: null,
  detached: false,
  pushState: "no-remote",
  unpushed: 0,
  behind: 0,
  hasUncommitted: false,
  error,
});

export class CodeContextService {
  private subjects = new Map<string, SubjectCacheEntry>();
  /** The expensive answer belongs to a workspace, not a task id. A Supervisor screen can contain 100
   *  rows backed by only a few repos; sharing here prevents 100 identical Git sweeps. */
  private workspaces = new Map<string, WorkspaceCacheEntry>();

  constructor(
    private readonly db: Pick<Db, "getThread" | "getCoworkSession">,
    private readonly ide: Pick<IdeService, "workspaceIdFor" | "isRegistered">,
    /** Injectable so a gate can hold the TTL still and prove the OTHER invalidation path on its own.
     *  Against a real clock, a git call slow enough to outlast the TTL expires the entry anyway, and
     *  the cache-busting assertion then passes without the code that makes it true. */
    private readonly now: () => number = Date.now,
    private readonly git: CodeContextGit = DEFAULT_GIT,
  ) {}

  /** Resolve only the local folder + IDE identity. This starts no Git process, so navigation becomes
   *  clickable before branch, remote and dirty-state metadata have finished. */
  resolveQuick(subject: CodeSubject): Promise<CodeContext> {
    return this.entryFor(subject).quick;
  }

  resolve(subject: CodeSubject): Promise<CodeContext> {
    const entry = this.entryFor(subject);
    if (!entry.shared) return entry.quick;
    entry.full ??= this.fullWorkspace(entry.shared).then((value) => ({ kind: subject.kind, id: subject.id, ...value }));
    return entry.full;
  }

  private entryFor(subject: CodeSubject): SubjectCacheEntry {
    const key = subjectKey(subject);
    const generation = this.git.generation();
    const hit = this.subjects.get(key);
    // Git writes invalidate the answer immediately. A time-only cache would show the pre-checkout
    // branch until the browser's much longer refresh interval elapsed.
    if (hit && hit.generation === generation && this.now() - hit.at < CACHE_TTL_MS) return hit;

    const workspace = this.workspaceOf(subject);
    if (!workspace) {
      const quick = Promise.resolve(emptyContext(
        subject,
        subject.kind === "workspace" ? "GGO has no work registered in that folder." : "That task no longer exists.",
      ));
      const entry: SubjectCacheEntry = { at: this.now(), generation, quick };
      this.subjects.set(key, entry);
      return entry;
    }

    const shared = this.workspaceEntry(workspace, generation);
    const quick = shared.quick.then((value) => ({ kind: subject.kind, id: subject.id, ...value }));
    const entry: SubjectCacheEntry = { at: this.now(), generation, shared, quick };
    this.subjects.set(key, entry);
    if (this.subjects.size > 200 || this.workspaces.size > 200) this.evict();
    return entry;
  }

  private workspaceEntry(workspace: string, generation: number): WorkspaceCacheEntry {
    const key = workspaceCacheKey(workspace);
    const hit = this.workspaces.get(key);
    if (hit && hit.generation === generation && this.now() - hit.at < CACHE_TTL_MS) return hit;
    const quick = this.resolveQuickWorkspace(workspace).catch((e) => asWorkspace(
      emptyContext({ kind: "workspace", id: workspace }, reason(e), workspace),
    ));
    const entry: WorkspaceCacheEntry = { at: this.now(), generation, quick };
    this.workspaces.set(key, entry);
    return entry;
  }

  private async resolveQuickWorkspace(workspace: string): Promise<WorkspaceContext> {
    let root: string;
    try {
      root = await realpath(workspace);
      if (!(await lstat(root)).isDirectory()) {
        return asWorkspace(emptyContext({ kind: "workspace", id: workspace }, "The workspace path is not a folder.", workspace));
      }
    } catch {
      return asWorkspace(emptyContext({ kind: "workspace", id: workspace }, "The workspace folder is missing on this machine.", workspace));
    }

    const base = asWorkspace(emptyContext({ kind: "workspace", id: workspace }, null, root));
    base.ideWorkspaceId = await this.ide.workspaceIdFor(workspace);
    base.gitPending = true;
    return base;
  }

  private fullWorkspace(entry: WorkspaceCacheEntry): Promise<WorkspaceContext> {
    entry.full ??= entry.quick.then(async (base) => {
      if (!base.gitPending || !base.workspace) return base;
      const repoPath = await this.git.resolveRepoRoot(base.workspace);
      if (!repoPath) return { ...base, gitPending: false, error: "This workspace is not a Git checkout." };

      const status = await this.git.getRepoHeadState(base.workspace);
      return {
        ...base,
        repoPath,
        gitPending: false,
        repoName: basename(repoPath.replace(/[\\/]+$/, "")) || repoPath,
        repoPrefix: repoPrefixOf(base.workspace, repoPath),
        branch: status.branch,
        detached: status.detached,
        pushState: status.pushState,
        unpushed: status.unpushed,
        behind: status.behind,
        hasUncommitted: status.hasUncommitted,
        error: status.error,
      };
    }).catch(async (e) => ({ ...await entry.quick, gitPending: false, error: reason(e) }));
    return entry.full;
  }

  /** The absolute workspace path behind a subject. A `workspace` subject carries its own path, and that
   *  path arrives from the browser — so it is honoured ONLY when GGO already works in it (the same
   *  registry the IDE enforces). Without that check this command is a "stat any directory, and read its
   *  git remote state" oracle for anyone who reaches the console. */
  private workspaceOf(subject: CodeSubject): string | null {
    if (subject.kind === "thread") return trimmed(this.db.getThread(subject.id)?.workspace);
    if (subject.kind === "cowork") return trimmed(this.db.getCoworkSession(subject.id)?.workspace);
    const path = trimmed(subject.id);
    return path && this.ide.isRegistered(path) ? path : null;
  }

  private evict(): void {
    for (const [key, entry] of this.subjects) if (this.now() - entry.at >= CACHE_TTL_MS) this.subjects.delete(key);
    for (const [key, entry] of this.workspaces) if (this.now() - entry.at >= CACHE_TTL_MS) this.workspaces.delete(key);
  }
}

const asWorkspace = ({ kind: _kind, id: _id, ...context }: CodeContext): WorkspaceContext => context;

const workspaceCacheKey = (path: string): string => {
  const key = resolve(path);
  return process.platform === "win32" ? key.toLowerCase() : key;
};

const trimmed = (value: string | null | undefined): string | null => {
  const v = (value ?? "").trim();
  return v ? v : null;
};

const reason = (e: unknown): string => (e instanceof Error && e.message ? e.message : "Could not read this workspace.");

/** The repo root expressed relative to the workspace. Null when the repo sits ABOVE the workspace — the
 *  common shape where a task workspace IS the checkout's parent is the opposite case (prefix names the
 *  nested repo), and both must be distinguishable so a caller never joins a `..` path into the IDE. */
export function repoPrefixOf(workspace: string, repoPath: string): string | null {
  const rel = relative(workspace, repoPath);
  if (rel === "") return "";
  if (rel === ".." || rel.startsWith(`..${sep}`) || resolve(workspace, rel) !== resolve(repoPath)) return null;
  return rel.replace(/\\/g, "/");
}
