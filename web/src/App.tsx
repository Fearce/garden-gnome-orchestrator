import { useStore } from "./store.js";
import { Director } from "./components/Director.js";
import { Board } from "./components/Board.js";
import { ThreadDetail } from "./components/ThreadDetail.js";
import { QuestionModal } from "./components/QuestionModal.js";
import { runActive } from "./lib/format.js";

export function App() {
  const connected = useStore((s) => s.connected);
  const selected = useStore((s) => s.selectedThreadId);
  const threads = useStore((s) => s.threads);
  const runs = useStore((s) => s.runs);

  const taskCount = Object.keys(threads).length;
  const liveAgents = Object.values(runs).filter((r) => runActive(r.state)).length;

  return (
    <div className="app">
      <header className="topbar">
        <div className="wordmark">
          Claude&nbsp;<em>Orchestrator</em>
          <span className="sub">director&nbsp;console</span>
        </div>
        <div className="spacer" />
        <span className="stat">
          <b>{taskCount}</b> {taskCount === 1 ? "task" : "tasks"} · <b>{liveAgents}</b> {liveAgents === 1 ? "agent" : "agents"} live
        </span>
        <div className="conn">
          <span className={"dot " + (connected ? "on" : "off")} />
          {connected ? "live" : "reconnecting…"}
        </div>
      </header>
      <div className={"workbench" + (selected ? " detail-open" : "")}>
        <Director />
        <Board />
        {selected ? <ThreadDetail key={selected} /> : null}
      </div>
      <QuestionModal />
    </div>
  );
}
