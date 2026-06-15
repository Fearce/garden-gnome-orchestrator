import { useState } from "react";
import { useStore, login } from "./store.js";
import { notifyEnabled, setNotifyEnabled } from "./lib/notify.js";
import { Director } from "./components/Director.js";
import { Board } from "./components/Board.js";
import { ThreadDetail } from "./components/ThreadDetail.js";
import { QuestionModal } from "./components/QuestionModal.js";
import { Accounts } from "./components/Accounts.js";
import { runActive } from "./lib/format.js";

export function App() {
  const connected = useStore((s) => s.connected);
  const authRequired = useStore((s) => s.authRequired);
  const authed = useStore((s) => s.authed);
  const selected = useStore((s) => s.selectedThreadId);
  const threads = useStore((s) => s.threads);
  const runs = useStore((s) => s.runs);

  if (authRequired && !authed) return <Login />;

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
        <Accounts />
        <span className="stat">
          <b>{taskCount}</b> {taskCount === 1 ? "task" : "tasks"} · <b>{liveAgents}</b> {liveAgents === 1 ? "agent" : "agents"} live
        </span>
        <ApprovalToggle />
        <NotifyBell />
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

function Login() {
  const [token, setToken] = useState("");
  const [err, setErr] = useState(false);
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    const t = token.trim();
    if (!t || busy) return;
    setBusy(true);
    setErr(false);
    const ok = await login(t);
    setBusy(false);
    if (!ok) setErr(true);
  };
  return (
    <div className="scrim">
      <div className="modal login">
        <div className="m-head">
          <h3>Claude Orchestrator</h3>
        </div>
        <div className="login-body">
          <p className="faint">Enter the access token to connect.</p>
          <input
            type="password"
            value={token}
            placeholder="access token"
            autoFocus
            onChange={(e) => setToken(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void submit();
            }}
          />
          {err ? <div className="login-err">Invalid token — try again.</div> : null}
          <button className="btn primary" onClick={() => void submit()} disabled={busy || !token.trim()}>
            {busy ? "Connecting…" : "Connect"}
          </button>
        </div>
      </div>
    </div>
  );
}

function ApprovalToggle() {
  const on = useStore((s) => s.approvalMode);
  const setApproval = useStore((s) => s.setApproval);
  return (
    <button
      className={"gate" + (on ? " on" : "")}
      title={on ? "Plan approval ON — tasks pause for your OK before building" : "Plan approval OFF — tasks build autonomously after planning"}
      aria-label="Toggle plan approval"
      onClick={() => setApproval(!on)}
    >
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z" />
        <path d="m9 12 2 2 4-4" />
      </svg>
      <span>gate</span>
    </button>
  );
}

function NotifyBell() {
  const [on, setOn] = useState(notifyEnabled());
  return (
    <button
      className={"bell" + (on ? " on" : "")}
      title={on ? "Notifications on — click to mute" : "Notify me (desktop + sound) when a task needs me or finishes"}
      aria-label="Toggle notifications"
      onClick={async () => setOn(await setNotifyEnabled(!on))}
    >
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M10.268 21a2 2 0 0 0 3.464 0" />
        <path d="M3.262 15.326A1 1 0 0 0 4 17h16a1 1 0 0 0 .74-1.673C19.41 13.956 18 12.5 18 8A6 6 0 0 0 6 8c0 4.5-1.411 5.956-2.738 7.326" />
        {on ? null : <line x1="2" y1="2" x2="22" y2="22" />}
      </svg>
    </button>
  );
}
