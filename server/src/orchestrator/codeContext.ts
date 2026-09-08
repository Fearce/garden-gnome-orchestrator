import { basename, relative, resolve, sep } from "node:path";
import { lstat, realpath } from "node:fs/promises";
import type { Db } from "../db/db.js";
import type { IdeService } from "../ide/service.js";
import { getRepoHeadState, gitCacheGeneration, resolveRepoRoot, type PushState } from "../gitService.js";

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

const emptyContext = (subject: CodeSubject, error: string | null, workspace: string | null = null): CodeContext => ({
  kind: subject.kind,
  id: subject.id,
  workspace,
  workspaceName: workspace ? basename(workspace.replace(/[\\/]+$/, "")) || workspace : null,
  ideWorkspaceId: null,
  repoPath: null,
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
  private cache = new Map<string, { at: number; generation: number; value: Promise<CodeContext> }>();

  constructor(
    private readonly db: Pick<Db, "getThread" | "getCoworkSession">,
    private readonly ide: Pick<IdeService, "workspaceIdFor" | "isRegistered">,
    /** Injectable so a gate can hold the TTL still and prove the OTHER invalidation path on its own.
     *  Against a real clock, a git call slow enough to outlast the TTL expires the entry anyway, and
     *  the cache-busting assertion then passes without the code that makes it true. */
    private readonly now: () => number = Date.now,
  ) {}

  async resolve(subject: CodeSubject): Promise<CodeContext> {
    const key = subjectKey(subject);
    const generation = gitCacheGeneration();
    const hit = this.cache.get(key);
    // The generation check is what makes a checkout/pull/commit visible AT ONCE. The console re-asks
    // for every on-screen subject the moment a repo action returns — inside this TTL — so a cache that
    // only expired on time would answer that refresh with the branch from before the switch, and then
    // nothing would ask again until the client's own much longer TTL lapsed.
    if (hit && hit.generation === generation && this.now() - hit.at < CACHE_TTL_MS) return hit.value;
    const value = this.resolveUncached(subject).catch((e) => emptyContext(subject, reason(e)));
    this.cache.set(key, { at: this.now(), generation, value });
    if (this.cache.size > 200) this.evict();
    return value;
  }

  private async resolveUncached(subject: CodeSubject): Promise<CodeContext> {
    const workspace = this.workspaceOf(subject);
    if (!workspace) {
      return emptyContext(
        subject,
        subject.kind === "workspace" ? "GGO has no work registered in that folder." : "That task no longer exists.",
      );
    }

    let root: string;
    try {
      root = await realpath(workspace);
      if (!(await lstat(root)).isDirectory()) return emptyContext(subject, "The workspace path is not a folder.", workspace);
    } catch {
      return emptyContext(subject, "The workspace folder is missing on this machine.", workspace);
    }

    const base = emptyContext(subject, null, root);
    base.ideWorkspaceId = await this.ide.workspaceIdFor(workspace);
    const repoPath = await resolveRepoRoot(root);
    if (!repoPath) return { ...base, error: "This workspace is not a Git checkout." };

    const status = await getRepoHeadState(root);
    return {
      ...base,
      repoPath,
      repoName: basename(repoPath.replace(/[\\/]+$/, "")) || repoPath,
      repoPrefix: repoPrefixOf(root, repoPath),
      branch: status.branch,
      detached: status.detached,
      pushState: status.pushState,
      unpushed: status.unpushed,
      behind: status.behind,
      hasUncommitted: status.hasUncommitted,
      error: status.error,
    };
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
    for (const [key, entry] of this.cache) if (this.now() - entry.at >= CACHE_TTL_MS) this.cache.delete(key);
  }
}

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
