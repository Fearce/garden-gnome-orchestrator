import { useEffect } from "react";
import { useStore, codeKey } from "../store.js";
import type { CodeContext, CodeOrigin, CodeSubjectKind } from "../types.js";
import { branchLabel, canOpenGit, canOpenIde, ideFileTarget, ideWorkspaceTarget } from "../lib/codeNav.js";
import "./codeContext.css";

/**
 * The one row that answers "where is this work, and how do I get into it" — used by the task detail
 * panel, the Co-work conversation header and the Supervisor audit. It states the repo and branch, how
 * HEAD stands against its remote, and offers the two routes: Code (the IDE, on this workspace) and Git
 * (the repo console, on this repo). Both record where the operator came from, so the destination can
 * offer one click back.
 *
 * It renders exactly what the server resolved and nothing more: no branch when git didn't report one,
 * no route when the destination can't accept the target. An unavailable subject says why in place of
 * the buttons — the row never goes silently blank, because "no context here" and "still loading" have
 * to be told apart.
 */
export function CodeContextBar({
  subject,
  origin,
  compact = false,
}: {
  subject: { kind: CodeSubjectKind; id: string };
  origin: CodeOrigin;
  /** Icon-scale variant for dense lists (a Supervisor audit row). */
  compact?: boolean;
}) {
  const key = codeKey(subject.kind, subject.id);
  const context = useStore((s) => s.codeContexts[key]);
  const pending = useStore((s) => !!s.codeContextPending[key]);
  const loadCodeContext = useStore((s) => s.loadCodeContext);

  useEffect(() => {
    loadCodeContext(subject.kind, subject.id);
  }, [subject.kind, subject.id, loadCodeContext]);

  if (!context) {
    return (
      <div className={"codectx" + (compact ? " compact" : "")}>
        <span className="codectx-note">{pending ? "Locating this workspace…" : " "}</span>
      </div>
    );
  }

  return (
    <div className={"codectx" + (compact ? " compact" : "")}>
      <RepoReading context={context} />
      <CodeRoutes subject={subject} origin={origin} />
    </div>
  );
}

/** Read one subject's resolved context, asking for it if nothing has yet. Every consumer goes through
 *  this so the request is made exactly once per subject however many surfaces want the answer. */
export function useCodeContext(subject: { kind: CodeSubjectKind; id: string }): CodeContext | undefined {
  const context = useStore((s) => s.codeContexts[codeKey(subject.kind, subject.id)]);
  const loadCodeContext = useStore((s) => s.loadCodeContext);
  useEffect(() => {
    loadCodeContext(subject.kind, subject.id);
  }, [subject.kind, subject.id, loadCodeContext]);
  return context;
}

/** The two routes on their own, for a surface that already states the branch itself — the task Changes
 *  drawer carries its own push-state header, so repeating the reading there would be noise. */
export function CodeRoutes({ subject, origin }: { subject: { kind: CodeSubjectKind; id: string }; origin: CodeOrigin }) {
  const key = codeKey(subject.kind, subject.id);
  const context = useStore((s) => s.codeContexts[key]);
  const loadCodeContext = useStore((s) => s.loadCodeContext);
  const openInIde = useStore((s) => s.openInIde);
  const openGitConsole = useStore((s) => s.openGitConsole);

  useEffect(() => {
    loadCodeContext(subject.kind, subject.id);
  }, [subject.kind, subject.id, loadCodeContext]);

  if (!context) return null;
  const ideTarget = ideWorkspaceTarget(context);
  return (
    <div className="codectx-actions">
      {canOpenIde(context) && ideTarget ? (
        <button
          className="codectx-btn"
          title={`Open ${context.workspaceName ?? "this workspace"} in the IDE`}
          onClick={() => openInIde(ideTarget, origin)}
        >
          <CodeIcon />
          <span>Code</span>
        </button>
      ) : null}
      {canOpenGit(context) ? (
        <button
          className="codectx-btn"
          title={`Open ${context.repoName ?? "this repository"} in the Git console`}
          onClick={() =>
            openGitConsole({
              forThread: subject.kind === "thread" ? subject.id : null,
              repoPath: context.repoPath,
              origin,
            })
          }
        >
          <BranchIcon />
          <span>Git</span>
        </button>
      ) : null}
    </div>
  );
}

/** Branch, repo and remote standing — or the reason there is none. */
function RepoReading({ context }: { context: CodeContext }) {
  if (!context.repoPath) {
    return (
      <span className="codectx-note" title={context.workspace ?? undefined}>
        {context.error ?? "No repository resolved for this workspace."}
      </span>
    );
  }
  return (
    <span className="codectx-reading" title={context.repoPath}>
      <BranchIcon />
      <b className={context.detached ? "detached" : undefined}>{branchLabel(context)}</b>
      {context.repoName ? <span className="codectx-repo">{context.repoName}</span> : null}
      {context.unpushed > 0 ? (
        <span className="codectx-count" title={`${context.unpushed} local commit${context.unpushed === 1 ? "" : "s"} not on the push remote`}>
          ↑{context.unpushed}
        </span>
      ) : null}
      {context.behind > 0 ? (
        <span className="codectx-count" title={`${context.behind} commit${context.behind === 1 ? "" : "s"} to pull`}>
          ↓{context.behind}
        </span>
      ) : null}
      {context.pushState === "commit-only" ? (
        <span className="codectx-tag" title="This repository's policy is commit-only — GGO never pushes it">
          commit-only
        </span>
      ) : null}
      {context.hasUncommitted ? <span className="codectx-dot" title="The working tree has uncommitted changes" /> : null}
    </span>
  );
}

/**
 * "Open this exact file in the editor" — the task→code link a changed-file row or a diff header
 * carries. It renders NOTHING when the destination isn't known: an unregistered workspace, a repo the
 * IDE can't address, or a path that wouldn't resolve inside the workspace. That silence is the
 * feature; a button that opens the wrong file is worse than no button.
 */
export function OpenInIde({
  subject,
  origin,
  path,
  line,
  label = "Open in IDE",
}: {
  subject: { kind: CodeSubjectKind; id: string };
  origin: CodeOrigin;
  /** Repo-relative path, as git reports it. */
  path: string;
  line?: number;
  label?: string;
}) {
  const key = codeKey(subject.kind, subject.id);
  const context = useStore((s) => s.codeContexts[key]);
  const loadCodeContext = useStore((s) => s.loadCodeContext);
  const openInIde = useStore((s) => s.openInIde);

  useEffect(() => {
    loadCodeContext(subject.kind, subject.id);
  }, [subject.kind, subject.id, loadCodeContext]);

  const target = context ? ideFileTarget(context, path, line) : null;
  if (!target) return null;
  return (
    <button
      className="codectx-btn"
      title={`Open ${path}${line ? ` at line ${line}` : ""} in the IDE`}
      onClick={() => openInIde(target, origin)}
    >
      <CodeIcon />
      <span>{label}</span>
    </button>
  );
}

/** The banner the IDE and the Git console show while a navigation has an origin — the return trip. */
export function ReturnToOrigin({ className = "" }: { className?: string }) {
  const origin = useStore((s) => s.codeOrigin);
  const returnToOrigin = useStore((s) => s.returnToOrigin);
  const clearCodeOrigin = useStore((s) => s.clearCodeOrigin);
  if (!origin) return null;
  return (
    <div className={("codectx-return " + className).trim()}>
      <button className="codectx-btn" onClick={returnToOrigin} title={`Back to ${origin.label}`}>
        <BackIcon />
        <span>{origin.label}</span>
      </button>
      <button className="codectx-return-x" aria-label="Forget where I came from" title="Forget where I came from" onClick={clearCodeOrigin}>
        ✕
      </button>
    </div>
  );
}

function BranchIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="6" cy="5" r="2.5" />
      <circle cx="6" cy="19" r="2.5" />
      <circle cx="18" cy="9" r="2.5" />
      <path d="M6 7.5v9M18 11.5c0 3-4 3.5-6 4.5" />
    </svg>
  );
}

function CodeIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="m9 17-5-5 5-5M15 7l5 5-5 5" />
    </svg>
  );
}

function BackIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M19 12H5M11 6l-6 6 6 6" />
    </svg>
  );
}
