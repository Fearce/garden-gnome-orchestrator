import { type CSSProperties } from "react";
import { useStore } from "../store.js";
import type { AgentRun, FeedItem, Role, Thread } from "../types.js";
import { roleColor, runActive, stateColor, stateLabel } from "../lib/format.js";

const ROLES: Role[] = ["planner", "researcher", "implementor", "qa"];

export function Board() {
  const threads = useStore((s) => s.threads);
  const list = Object.values(threads).sort((a, b) => b.createdAt - a.createdAt);

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
        <div className="lanes">
          {list.map((t) => (
            <Card key={t.id} thread={t} />
          ))}
        </div>
      )}
    </main>
  );
}

function latestRun(runs: AgentRun[], role: Role): AgentRun | undefined {
  return runs.filter((r) => r.role === role).sort((a, b) => b.startedAt - a.startedAt)[0];
}

function Card({ thread }: { thread: Thread }) {
  const runs = useStore((s) => s.runs);
  const feeds = useStore((s) => s.threadFeeds);
  const draft = useStore((s) => s.threadDrafts[thread.id]);
  const findings = useStore((s) => s.findings);
  const selected = useStore((s) => s.selectedThreadId);
  const select = useStore((s) => s.select);

  const threadRuns = Object.values(runs).filter((r) => r.threadId === thread.id);
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
      <div className="ws-path">{thread.workspace}</div>
      <div className="pips">
        {ROLES.map((role) => {
          const r = latestRun(threadRuns, role);
          const active = r && runActive(r.state);
          const cls = active ? "active" : r ? "done" : "idle";
          return (
            <span key={role} className={"pip " + cls} style={{ "--role": roleColor(role) } as CSSProperties}>
              <span className="led" />
              {role[0]!.toUpperCase() + role.slice(1, 4)}
            </span>
          );
        })}
      </div>
      <div className="activity">{activity}</div>
      <div className="foot">
        <span className="badge" style={{ "--state-color": stateColor(thread.state) } as CSSProperties}>
          {stateLabel(thread.state)}
        </span>
        {findCount > 0 ? <span className="findcount">⚑ {findCount}</span> : <span />}
      </div>
    </div>
  );
}
