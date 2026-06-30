import { useState, useEffect, type CSSProperties } from "react";
import { useStore, login } from "./store.js";
import { notifyEnabled, setNotifyEnabled } from "./lib/notify.js";
import { Director } from "./components/Director.js";
import { Board } from "./components/Board.js";
import { ThreadDetail } from "./components/ThreadDetail.js";
import { QuestionModal } from "./components/QuestionModal.js";
import { Accounts } from "./components/Accounts.js";
import { Office } from "./components/Office.js";
import { SettingsPanel } from "./components/SettingsPanel.js";
import { NoticeBanner } from "./components/NoticeBanner.js";
import { runActive } from "./lib/format.js";
import { apiUrl } from "./lib/base.js";

type MobilePane = "director" | "board";

export function App() {
  const connected = useStore((s) => s.connected);
  const authRequired = useStore((s) => s.authRequired);
  const authed = useStore((s) => s.authed);
  const selected = useStore((s) => s.selectedThreadId);
  // Subscribe to the derived SCALARS, not the whole threads/runs maps — these compare equal under
  // Object.is, so the topbar only re-renders when a displayed count actually changes, not on every
  // run/thread upsert that replaces those maps by reference.
  const taskCount = useStore((s) => Object.keys(s.threads).length);
  const liveAgents = useStore((s) => Object.values(s.runs).filter((r) => runActive(r.state)).length);
  const railHidden = useStore((s) => s.railHidden);
  const detailWidth = useStore((s) => s.detailWidth);
  const directorWidth = useStore((s) => s.directorWidth);
  const [mobilePane, setMobilePane] = useState<MobilePane>("board");
  const [settingsOpen, setSettingsOpen] = useState(false);

  if (authRequired && !authed) return <Login />;

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <BuildTag />
          <div className="wordmark">
            Claude&nbsp;<em>Orchestrator</em>
            <span className="sub">director&nbsp;console</span>
          </div>
        </div>
        <RailToggle />
        <SettingsButton open={settingsOpen} onToggle={() => setSettingsOpen((o) => !o)} />
        <Office />
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
      <div
        className={"workbench pane-" + mobilePane + (selected ? " detail-open" : "") + (railHidden ? " rail-hidden" : "")}
        style={{ "--detail-w": detailWidth + "px", "--rail-w": directorWidth + "px" } as CSSProperties}
      >
        <Director />
        <Board />
        {selected ? <ThreadDetail key={selected} /> : null}
      </div>
      <MobileNav pane={mobilePane} setPane={setMobilePane} />
      <QuestionModal />
      <NoticeBanner />
      {settingsOpen ? <SettingsPanel onClose={() => setSettingsOpen(false)} /> : null}
    </div>
  );
}

function SettingsButton({ open, onToggle }: { open: boolean; onToggle: () => void }) {
  return (
    <button
      className={"settings-btn" + (open ? " on" : "")}
      title="Settings"
      aria-label="Open settings"
      aria-expanded={open}
      onClick={onToggle}
    >
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="12" cy="12" r="3" />
        <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
      </svg>
    </button>
  );
}

function BuildTag() {
  const built = new Date(__BUILD_TIME__);
  const title = `v${__APP_VERSION__} · ${__BUILD_SHA__}\nbuilt ${built.toLocaleString()}`;
  return (
    <span className="build-tag" title={title}>
      v{__APP_VERSION__}<span className="sha">{__BUILD_SHA__}</span>
    </span>
  );
}

function Login() {
  const authGoogle = useStore((s) => s.authGoogle);
  const authPassword = useStore((s) => s.authPassword);
  const authError = useStore((s) => s.authError);
  const [pw, setPw] = useState("");
  const [err, setErr] = useState(false);
  const [busy, setBusy] = useState(false);
  const [cooldownUntil, setCooldownUntil] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (cooldownUntil <= Date.now()) return;
    const t = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(t);
  }, [cooldownUntil]);
  const remaining = Math.max(0, Math.ceil((cooldownUntil - now) / 1000));
  const submit = async () => {
    const p = pw.trim();
    if (!p || busy || remaining > 0) return;
    setBusy(true);
    setErr(false);
    const r = await login(p);
    setBusy(false);
    if (!r.ok) {
      setPw("");
      if (r.retryMs) {
        setNow(Date.now());
        setCooldownUntil(Date.now() + r.retryMs);
      } else {
        setErr(true);
      }
    }
  };
  return (
    <div className="scrim">
      <div className="modal login">
        <div className="m-head">
          <h3>Claude Orchestrator</h3>
        </div>
        <div className="login-body">
          {authError === "forbidden" ? (
            <p className="login-err">That Google account isn't allowed — only the owner can open this console.</p>
          ) : authError ? (
            <p className="login-err">Google sign-in didn't complete — try again.</p>
          ) : null}

          {authGoogle ? (
            <a className="btn google" href={apiUrl(authError === "forbidden" ? "/api/auth/google?select=1" : "/api/auth/google")}>
              <svg width="16" height="16" viewBox="0 0 48 48" aria-hidden="true">
                <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z" />
                <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z" />
                <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z" />
                <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z" />
              </svg>
              Sign in with Google
            </a>
          ) : null}

          {authGoogle && authPassword ? (
            <div className="or-sep">
              <span>or</span>
            </div>
          ) : null}

          {authPassword ? (
            <>
              <input
                type="password"
                value={pw}
                placeholder="password"
                autoFocus
                onChange={(e) => setPw(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void submit();
                }}
              />
              {err ? <div className="login-err">Wrong password.</div> : null}
              {remaining > 0 ? <div className="login-err">Too many tries — wait {remaining}s.</div> : null}
              <button className="btn primary" onClick={() => void submit()} disabled={busy || !pw.trim() || remaining > 0}>
                {busy ? "Checking…" : remaining > 0 ? `Wait ${remaining}s` : "Enter"}
              </button>
            </>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function RailToggle() {
  const hidden = useStore((s) => s.railHidden);
  const toggle = useStore((s) => s.toggleRail);
  return (
    <button
      className={"rail-toggle" + (hidden ? " off" : "")}
      title={hidden ? "Show the director chat" : "Hide the director chat"}
      aria-label="Toggle director chat panel"
      onClick={toggle}
    >
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <rect x="3" y="3" width="18" height="18" rx="2" />
        <path d="M9 3v18" />
        {hidden ? null : <rect x="3" y="3" width="6" height="18" rx="2" fill="currentColor" stroke="none" opacity="0.32" />}
      </svg>
    </button>
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

function MobileNav({ pane, setPane }: { pane: MobilePane; setPane: (p: MobilePane) => void }) {
  return (
    <nav className="mobile-nav">
      <button
        className={"mnav-btn" + (pane === "director" ? " on" : "")}
        aria-current={pane === "director" ? "page" : undefined}
        onClick={() => setPane("director")}
      >
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
        </svg>
        Director
      </button>
      <button
        className={"mnav-btn" + (pane === "board" ? " on" : "")}
        aria-current={pane === "board" ? "page" : undefined}
        onClick={() => setPane("board")}
      >
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <rect width="7" height="7" x="3" y="3" rx="1" />
          <rect width="7" height="7" x="14" y="3" rx="1" />
          <rect width="7" height="7" x="14" y="14" rx="1" />
          <rect width="7" height="7" x="3" y="14" rx="1" />
        </svg>
        Tasks
      </button>
    </nav>
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
