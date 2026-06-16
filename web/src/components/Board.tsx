import { useEffect, useState, type CSSProperties } from "react";
import { useStore } from "../store.js";
import type { AgentRun, FeedItem, Role, Thread } from "../types.js";
import { roleColor, runActive, stateColor, stateLabel, threadRunning } from "../lib/format.js";
import { Elapsed } from "../lib/timing.js";

// Pipeline order for laying out the role pips. The path is agent-routed, so which of these
// actually run varies (the researcher is conditional) — pips are derived from real runs below.
const PIPELINE_ORDER: Role[] = ["planner", "researcher", "implementor", "qa"];
const PER_PAGE = 15;

export function Board() {
  const threads = useStore((s) => s.threads);
  const list = Object.values(threads).sort((a, b) => b.createdAt - a.createdAt);
  const [page, setPage] = useState(0);

  const pageCount = Math.max(1, Math.ceil(list.length / PER_PAGE));
  useEffect(() => {
    if (page > pageCount - 1) setPage(pageCount - 1);
  }, [pageCount, page]);
  const cur = Math.min(page, pageCount - 1);
  const pageItems = list.slice(cur * PER_PAGE, cur * PER_PAGE + PER_PAGE);

  return (
    <main className="board">
      <div className="board-head">
        <h2>Tasks</h2>
        <span className="faint mono" style={{ fontSize: 11 }}>
          {list.length} total
        </span>
      </div>
      {list.length === 0 ? (
        <div className="empty">
          <div className="big">No tasks running</div>
          <div className="faint">Dispatch one from the Director on the left.</div>
        </div>
      ) : (
        <>
          <div className="lanes">
            {pageItems.map((t) => (
              <Card key={t.id} thread={t} />
            ))}
          </div>
          {pageCount > 1 ? (
            <div className="pager">
              <button className="btn ghost sm" onClick={() => setPage((p) => Math.max(0, p - 1))} disabled={cur === 0}>
                ‹ Prev
              </button>
              <span className="pager-info mono">
                {cur * PER_PAGE + 1}–{Math.min((cur + 1) * PER_PAGE, list.length)} of {list.length} · page {cur + 1}/{pageCount}
              </span>
              <button className="btn ghost sm" onClick={() => setPage((p) => Math.min(pageCount - 1, p + 1))} disabled={cur >= pageCount - 1}>
                Next ›
              </button>
            </div>
          ) : null}
        </>
      )}
    </main>
  );
}

function latestRun(runs: AgentRun[], role: Role): AgentRun | undefined {
  return runs.filter((r) => r.role === role).sort((a, b) => b.startedAt - a.startedAt)[0];
}

/** The roles to show as pips: the ones that actually ran, in pipeline order (so the researcher pip
 *  appears only when the planner routed to it). Before any run exists, show the planner — it's
 *  always next — so a just-dispatched card isn't blank. */
function pipRoles(runs: AgentRun[]): Role[] {
  const ran = PIPELINE_ORDER.filter((role) => runs.some((r) => r.role === role));
  return ran.length ? ran : ["planner"];
}

/** Split a workspace path into its parent and its last segment (the repo folder). The leaf carries
 *  its leading separator so it reads naturally, and it's the part the user scans for — so it's never
 *  truncated; the parent is what gives way when space is tight. */
function splitWorkspace(p: string): { parent: string; leaf: string } {
  const norm = p.replace(/[\\/]+$/, "");
  const i = Math.max(norm.lastIndexOf("\\"), norm.lastIndexOf("/"));
  return i < 0 ? { parent: "", leaf: norm } : { parent: norm.slice(0, i), leaf: norm.slice(i) };
}

/** The target repo, foregrounded on the card — it's how you tell tasks apart at a glance (and decide
 *  which to resume). Repo folder is bold/bright and always shown; the parent path dims and truncates. */
function WorkspacePath({ path }: { path: string }) {
  const { parent, leaf } = splitWorkspace(path);
  return (
    <div className="ws-path" title={path}>
      <svg className="ws-ico" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" />
      </svg>
      {parent ? <span className="ws-parent">{parent}</span> : null}
      <span className="ws-leaf">{leaf}</span>
    </div>
  );
}

function Card({ thread }: { thread: Thread }) {
  const runs = useStore((s) => s.runs);
  const feeds = useStore((s) => s.threadFeeds);
  const draft = useStore((s) => s.threadDrafts[thread.id]);
  const findings = useStore((s) => s.findings);
  const selected = useStore((s) => s.selectedThreadId);
  const select = useStore((s) => s.select);

  const threadRuns = Object.values(runs).filter((r) => r.threadId === thread.id);
  const impl = latestRun(threadRuns, "implementor");
  const findCount = findings.filter((f) => f.threadId === thread.id).length;
  const feed = feeds[thread.id] ?? [];
  const lastText = [...feed].reverse().find((f): f is Extract<FeedItem, { kind: "text" }> => f.kind === "text");
  const activity = draft?.text || lastText?.text || thread.brief.split("\n")[0] || "—";

  return (
    <div
      className={"card" + (selected === thread.id ? " sel" : "")}
      style={{ "--state-color": stateColor(thread.state) } as CSSProperties}
      onClick={() => select(thread.id)}
    >
      <div className="title">{thread.title}</div>
      <WorkspacePath path={thread.workspace} />
      <div className="pips">
        {pipRoles(threadRuns).map((role) => {
          const r = latestRun(threadRuns, role);
          const active = r && runActive(r.state);
          const cls = active ? "active" : r ? "done" : "idle";
          return (
            <span key={role} className={"pip " + cls} style={{ "--role": roleColor(role) } as CSSProperties}>
              <span className="led" />
              {role[0]!.toUpperCase() + role.slice(1, 4)}
              {r ? <Elapsed className="pip-time" startMs={r.startedAt} endMs={r.endedAt} running={!!active} /> : null}
            </span>
          );
        })}
      </div>
      <div className="activity">{activity}</div>
      <div className="foot">
        <span style={{ display: "inline-flex", gap: 6, alignItems: "center" }}>
          <span className="badge" style={{ "--state-color": stateColor(thread.state) } as CSSProperties}>
            {stateLabel(thread.state)}
          </span>
          {impl?.effort ? (
            <span className={"effort-badge eff-" + impl.effort} title="Implementor effort (planner-chosen)">
              {impl.effort}
            </span>
          ) : null}
        </span>
        <span className="foot-right">
          <Elapsed
            className="task-elapsed"
            startMs={thread.createdAt}
            endMs={thread.updatedAt}
            running={threadRunning(thread.state)}
            title="Time since the task was dispatched"
          />
          {findCount > 0 ? <span className="findcount">⚑ {findCount}</span> : null}
        </span>
      </div>
    </div>
  );
}
