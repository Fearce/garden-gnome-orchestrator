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
  const mode = useStore((s) => s.authMode);
  const authError = useStore((s) => s.authError);
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
          {mode === "google" ? (
            <>
              {authError === "forbidden" ? (
                <p className="login-err">That Google account isn't allowed — only the owner can open this console.</p>
              ) : authError ? (
                <p className="login-err">Sign-in didn't complete — try again.</p>
              ) : (
                <p className="faint">Sign in with Google to continue.</p>
              )}
              <a className="btn google" href={authError === "forbidden" ? "/api/auth/google?select=1" : "/api/auth/google"}>
                <svg width="16" height="16" viewBox="0 0 48 48" aria-hidden="true">
                  <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z" />
                  <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z" />
                  <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z" />
                  <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z" />
                </svg>
                Sign in with Google
              </a>
              {authError === "forbidden" ? (
                <a className="faint switch-acct" href="/api/auth/google?select=1">
                  use a different account
                </a>
              ) : null}
            </>
          ) : (
            <>
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
            </>
          )}
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
