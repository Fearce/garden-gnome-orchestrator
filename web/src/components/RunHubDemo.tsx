import { useEffect, useMemo, useState, type CSSProperties, type ReactNode } from "react";
import ggLogo from "../assets/gg-logo.png";

/**
 * Run Hub — a self-contained, mock-data PREVIEW of a proposed "run actions" feature. It's mounted on its
 * own hash route (#run-hub, see main.tsx) so it never touches the live board, store, or WebSocket — it
 * renders entirely from the fixtures below and its own local state. Every action is simulated: URLs open
 * for real, everything else raises a toast ("would run / would reveal"). Nothing is executed.
 *
 * The concept: extend deliverables (passive files) into ACTIONS you can run from the card — three types
 * cover almost everything (open a URL, open/launch a file or folder, run a shell command). Only actions
 * QA has verified appear as live buttons; unverified ones show gated. A top-bar Hub aggregates every
 * runnable action across all tasks (including archived) into one launcher. The whole feature sits behind
 * a settings toggle, default off.
 */

type ActionKind = "url" | "folder" | "file" | "shell";

interface RunAction {
  id: string;
  kind: ActionKind;
  /** The button label, verb-first — "Open dashboard", "Run bot once", "Launch unlocked client". */
  label: string;
  /** The URL, path, or command this action targets. */
  target: string;
  /** Working directory for a shell action — shown in the confirm dialog so you see exactly where it runs. */
  cwd?: string;
  /** QA-verified. Only tested actions run; untested ones render gated ("not verified"). */
  tested: boolean;
}

type DemoState = "done" | "review" | "closed";

interface DemoTask {
  id: string;
  title: string;
  /** Full workspace path — the card foregrounds its last segment (the repo), like the real board. */
  workspace: string;
  /** The repo leaf, lower-cased — the key the Hub filters by. */
  project: string;
  state: DemoState;
  /** Archived tasks are kept off the board but still aggregate into the Hub. */
  archived?: boolean;
  /** Drives the Hub's "recent" sort (larger = more recent). */
  recency: number;
  actions: RunAction[];
}

// Per-kind presentation: the accent colour of the leading icon, and the noun shown in the Hub's kind tag.
// Colours are pulled from the app's existing role palette so the buttons read as native, not bolted on.
const KIND: Record<ActionKind, { color: string; tag: string; icon: ReactNode }> = {
  url: { color: "var(--role-researcher)", tag: "URL", icon: <UrlIcon /> },
  folder: { color: "var(--accent)", tag: "Folder", icon: <FolderIcon /> },
  file: { color: "var(--role-implementor)", tag: "File", icon: <FileIcon /> },
  shell: { color: "var(--warn)", tag: "Command", icon: <ShellIcon /> },
};

// State → the card's accent colour + badge label, mirroring the live board's stateColor/stateLabel.
const STATE: Record<DemoState, { color: string; label: string }> = {
  done: { color: "var(--ok)", label: "done" },
  review: { color: "var(--warn)", label: "review" },
  closed: { color: "var(--text-faint)", label: "closed" },
};

// The mock board — the owner's actual recent tasks, so the preview reads as their real work. Two board
// tasks are fully verified, one (WoW) carries an unverified action to show the tested-gate, and an
// archived task demonstrates that the Hub still surfaces actions from tasks off the board.
const TASKS: DemoTask[] = [
  {
    id: "example",
    title: "example dashboard",
    workspace: "C:\\Users\\Mikkel\\projects\\prediction-market-bot",
    project: "prediction-market-bot",
    state: "done",
    recency: 6,
    actions: [
      { id: "pm-url", kind: "url", label: "Open dashboard", target: "https://example-dashboard.vercel.app", tested: true },
      {
        id: "pm-run",
        kind: "shell",
        label: "Run bot once",
        target: "python -m bot.main --once",
        cwd: "C:\\Users\\Mikkel\\projects\\prediction-market-bot",
        tested: true,
      },
      { id: "pm-public", kind: "folder", label: "Open public/ folder", target: "C:\\Users\\Mikkel\\projects\\prediction-market-bot\\public", tested: true },
    ],
  },
  {
    id: "wow",
    title: "WoW SelfRotation",
    workspace: "C:\\Users\\Mikkel\\projects\\wow\\world of warcraft 3.3.5a hd",
    project: "wow 3.3.5a hd",
    state: "review",
    recency: 5,
    actions: [
      {
        id: "wow-launch",
        kind: "file",
        label: "Launch unlocked client",
        target: "C:\\Users\\Mikkel\\projects\\wow\\world of warcraft 3.3.5a hd\\Wow-unlocked.exe",
        tested: false,
      },
      {
        id: "wow-addon",
        kind: "folder",
        label: "Open SelfRotation addon folder",
        target: "C:\\Users\\Mikkel\\projects\\wow\\world of warcraft 3.3.5a hd\\Interface\\AddOns\\SelfRotation",
        tested: true,
      },
    ],
  },
  {
    id: "mtext",
    title: "mtext release",
    workspace: "C:\\Users\\Mikkel\\projects\\mtext",
    project: "mtext",
    state: "done",
    recency: 3,
    actions: [
      { id: "mt-launch", kind: "file", label: "Launch mtext", target: "C:\\Users\\Mikkel\\projects\\mtext\\release\\mtext.exe", tested: true },
      { id: "mt-release", kind: "folder", label: "Open release folder", target: "C:\\Users\\Mikkel\\projects\\mtext\\release", tested: true },
    ],
  },
  {
    id: "pm-audit",
    title: "example resolver audit",
    workspace: "C:\\Users\\Mikkel\\projects\\prediction-market-bot",
    project: "prediction-market-bot",
    state: "closed",
    archived: true,
    recency: 1,
    actions: [
      { id: "au-report", kind: "file", label: "Open audit report", target: "C:\\Users\\Mikkel\\projects\\prediction-market-bot\\reports\\resolver-audit.md", tested: true },
    ],
  },
];

/** Split a workspace into parent + repo leaf, mirroring Board.splitWorkspace so the card path reads the same. */
function splitWorkspace(p: string): { parent: string; leaf: string } {
  const norm = p.replace(/[\\/]+$/, "");
  const i = Math.max(norm.lastIndexOf("\\"), norm.lastIndexOf("/"));
  return i < 0 ? { parent: "", leaf: norm } : { parent: norm.slice(0, i), leaf: norm.slice(i) };
}

type Toast = { id: number; text: string };

export function RunHubDemo() {
  // The feature toggle — DEFAULT OFF. Off hides every run button and the Hub entry; on reveals them.
  const [enabled, setEnabled] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [hubOpen, setHubOpen] = useState(false);
  // The shell action awaiting confirmation (its command + cwd is shown before it's "run").
  const [confirm, setConfirm] = useState<RunAction | null>(null);
  const [toast, setToast] = useState<Toast | null>(null);

  // Enabling flips the feature on; disabling also tears down anything the feature opened.
  const setFeature = (on: boolean) => {
    setEnabled(on);
    if (!on) {
      setHubOpen(false);
      setConfirm(null);
    }
  };

  const showToast = (text: string) => setToast({ id: Date.now(), text });
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast((cur) => (cur && cur.id === toast.id ? null : cur)), 2800);
    return () => clearTimeout(t);
  }, [toast]);

  // Run an action for real-enough: URLs open in a new tab; a shell command routes through the confirm
  // dialog first; everything else raises a "would…" toast. Nothing is ever actually executed.
  const run = (a: RunAction) => {
    if (!a.tested) return;
    switch (a.kind) {
      case "url":
        window.open(a.target, "_blank", "noopener,noreferrer");
        showToast(`Opened ${a.label.replace(/^open\s+/i, "")} — ${a.target}`);
        break;
      case "folder":
        showToast(`Would reveal in Explorer — ${a.target}`);
        break;
      case "file":
        showToast(`Would launch — ${a.target}`);
        break;
      case "shell":
        setConfirm(a);
        break;
    }
  };

  const confirmRun = () => {
    if (!confirm) return;
    const where = confirm.cwd ? `  (in ${confirm.cwd})` : "";
    showToast(`Would run — ${confirm.target}${where}`);
    setConfirm(null);
  };

  const board = TASKS.filter((t) => !t.archived);
  const verifiedCount = TASKS.reduce((n, t) => n + t.actions.filter((a) => a.tested).length, 0);

  return (
    <div className="app runhub-demo">
      <header className="topbar">
        <div className="brand">
          <span className="build-tag">
            preview<span className="sha">mock</span>
          </span>
          <div className="wordmark">
            <img className="brand-logo" src={ggLogo} alt="GG Orchestrator" />
            <span className="sub">run&nbsp;hub&nbsp;·&nbsp;preview</span>
          </div>
        </div>
        <span className="demo-pill" title="This is a design preview built from mock data — nothing here touches your real tasks.">
          <DotIcon /> Preview · mock data
        </span>
        <div className="spacer" />
        {enabled ? <HubButton count={verifiedCount} onClick={() => setHubOpen(true)} /> : null}
        <button
          className={"settings-btn" + (settingsOpen ? " on" : "")}
          title="Settings"
          aria-label="Open settings"
          aria-expanded={settingsOpen}
          onClick={() => setSettingsOpen((o) => !o)}
        >
          <GearIcon />
        </button>
        <span className="stat">
          <b>{board.length}</b> tasks · <b>{verifiedCount}</b> actions
        </span>
        <div className="conn">
          <span className="dot on" />
          preview
        </div>
      </header>

      <main className="board">
        <div className="board-head">
          <h2>Tasks</h2>
          <span className="faint mono" style={{ fontSize: 11 }}>
            {board.length} total · run actions {enabled ? "on" : "off"}
          </span>
        </div>

        {!enabled ? (
          <div className="board-hint">
            <span className="board-hint-ico">
              <SparkIcon />
            </span>
            <div className="board-hint-text">
              <div className="board-hint-title">Run actions are off</div>
              <div className="board-hint-sub">
                Turn on <b>Run actions (Hub)</b> in Settings to preview per-card Run/Open buttons and the aggregate Hub launcher.
              </div>
            </div>
            <button className="btn sm" onClick={() => setSettingsOpen(true)}>
              Open settings
            </button>
          </div>
        ) : null}

        <div className="lanes">
          {board.map((t) => (
            <TaskCard key={t.id} task={t} enabled={enabled} onRun={run} />
          ))}
        </div>

        <p className="demo-foot-note">
          Preview only — mock data, not wired to real execution. URLs open for real; Run / Open / Launch are simulated. Load this
          any time at <code>/#run-hub</code>.
        </p>
      </main>

      {settingsOpen ? (
        <SettingsPreview enabled={enabled} onToggle={setFeature} onClose={() => setSettingsOpen(false)} />
      ) : null}

      {confirm ? <ConfirmDialog action={confirm} onCancel={() => setConfirm(null)} onConfirm={confirmRun} /> : null}

      {hubOpen ? <HubPanel onRun={run} onClose={() => setHubOpen(false)} /> : null}

      {toast ? <div className="demo-toast">{toast.text}</div> : null}
    </div>
  );
}

/** The top-bar Hub entry — a labelled launcher chip, present only while the feature is on. */
function HubButton({ count, onClick }: { count: number; onClick: () => void }) {
  return (
    <button className="hub-btn" onClick={onClick} title="Open the Run Hub — every runnable action across all tasks">
      <GridIcon />
      <span>Hub</span>
      <span className="hub-btn-n">{count}</span>
    </button>
  );
}

/** One board task, styled as a native card. When the feature is on, its verified actions become live
 *  Run/Open buttons and its unverified ones show gated below the workspace path. */
function TaskCard({ task, enabled, onRun }: { task: DemoTask; enabled: boolean; onRun: (a: RunAction) => void }) {
  const { parent, leaf } = splitWorkspace(task.workspace);
  const st = STATE[task.state];
  return (
    <div className="card" style={{ "--state-color": st.color } as CSSProperties}>
      <div className="title">{task.title}</div>
      <div className="ws-path" title={task.workspace}>
        <svg className="ws-ico" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" />
        </svg>
        {parent ? <span className="ws-parent">{parent}</span> : null}
        <span className="ws-leaf">{leaf}</span>
      </div>

      {enabled ? <RunActions actions={task.actions} onRun={onRun} /> : null}

      <div className="foot">
        <span className="badge" style={{ "--state-color": st.color } as CSSProperties}>
          {st.label}
        </span>
      </div>
    </div>
  );
}

/** The card's run-actions strip: a quiet "run" label with a QA-verified marker, then one button per
 *  action. Verified actions are live; unverified ones are gated (dashed, inert, "not verified"). */
function RunActions({ actions, onRun }: { actions: RunAction[]; onRun: (a: RunAction) => void }) {
  return (
    <div className="run-actions">
      <span className="run-actions-label">
        run
        <span className="run-verified" title="Only actions QA has verified appear as live buttons.">
          <ShieldCheckIcon /> verified
        </span>
      </span>
      <div className="run-strip">
        {actions.map((a) => (
          <RunButton key={a.id} action={a} onRun={onRun} />
        ))}
      </div>
    </div>
  );
}

function RunButton({ action, onRun }: { action: RunAction; onRun: (a: RunAction) => void }) {
  const meta = KIND[action.kind];
  if (!action.tested) {
    return (
      <span
        className="run-btn gated"
        title={`Not yet verified by QA — actions become runnable here once QA tests them.\n\n${action.kind === "shell" ? action.target : action.target}`}
      >
        <span className="run-btn-ico">
          <ShieldOffIcon />
        </span>
        <span className="run-btn-label">{action.label}</span>
        <span className="run-btn-tag">not verified</span>
      </span>
    );
  }
  return (
    <button
      className="run-btn"
      style={{ "--k": meta.color } as CSSProperties}
      onClick={() => onRun(action)}
      title={action.kind === "shell" ? `Runs: ${action.target}` : action.target}
    >
      <span className="run-btn-ico">{meta.icon}</span>
      <span className="run-btn-label">{action.label}</span>
    </button>
  );
}

/** A trimmed settings popover carrying the one toggle this feature introduces — anchored under the
 *  top bar like the real Settings, with a click-outside backdrop. Default off. */
function SettingsPreview({ enabled, onToggle, onClose }: { enabled: boolean; onToggle: (v: boolean) => void; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="settings-scrim" onClick={onClose}>
      <div className="settings-pop" role="dialog" aria-label="Settings" onClick={(e) => e.stopPropagation()}>
        <div className="settings-head">
          <h3>Settings</h3>
          <button className="settings-x" aria-label="Close settings" onClick={onClose}>
            ✕
          </button>
        </div>
        <div className="settings-group">
          <div className="settings-group-label">Run actions</div>
          <div className="settings-row">
            <div className="settings-row-text">
              <div className="settings-row-label">Run actions (Hub)</div>
              <div className="settings-row-hint">
                On: task cards show verified Run / Open buttons and a top-bar Hub aggregates every runnable action across all tasks.
                Off by default.
              </div>
            </div>
            <button
              className={"switch" + (enabled ? " on" : "")}
              role="switch"
              aria-checked={enabled}
              aria-label="Run actions (Hub)"
              onClick={() => onToggle(!enabled)}
            >
              <span className="switch-knob" />
            </button>
          </div>
        </div>
        <p className="settings-note">Preview toggle — flips the mock feature on and off so you can see both states.</p>
      </div>
    </div>
  );
}

/** The safety gate for shell actions: before a command "runs", show it verbatim — command and working
 *  directory — so there's no ambiguity about what's about to execute. URL / folder actions skip this. */
function ConfirmDialog({ action, onCancel, onConfirm }: { action: RunAction; onCancel: () => void; onConfirm: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
      if (e.key === "Enter") onConfirm();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onCancel, onConfirm]);
  return (
    <div className="scrim" onClick={onCancel}>
      <div className="modal confirm-run" role="dialog" aria-label="Confirm run command" onClick={(e) => e.stopPropagation()}>
        <div className="m-head">
          <span className="chip warn">Run command</span>
          <h3>Run this command?</h3>
        </div>
        <div className="m-body">
          <div className="cmd-block">
            <div className="cmd-line">
              <span className="cmd-prompt">$</span>
              <span className="cmd-text">{action.target}</span>
            </div>
            {action.cwd ? (
              <div className="cmd-cwd">
                <FolderIcon /> {action.cwd}
              </div>
            ) : null}
          </div>
          <p className="confirm-note">
            Shell actions always confirm before running so you see exactly what executes and where. In this preview it's simulated —
            nothing actually runs.
          </p>
          <div className="m-foot">
            <button className="btn ghost" onClick={onCancel}>
              Cancel
            </button>
            <button className="btn primary" onClick={onConfirm}>
              Run command
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

type HubSort = "recent" | "name";

interface HubItem {
  action: RunAction;
  task: DemoTask;
}

/** The aggregate Hub: every runnable action across every task — board and archived — as one launcher
 *  list, filterable by project and sortable by recency or name. Verified actions run; unverified ones
 *  show gated, so the tested-gate is visible here too. A right-side drawer, so it reads as a launcher. */
function HubPanel({ onRun, onClose }: { onRun: (a: RunAction) => void; onClose: () => void }) {
  const [project, setProject] = useState<string>("all");
  const [sort, setSort] = useState<HubSort>("recent");

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const projects = useMemo(() => Array.from(new Set(TASKS.map((t) => t.project))), []);

  const items = useMemo(() => {
    const all: HubItem[] = [];
    for (const task of TASKS) for (const action of task.actions) all.push({ action, task });
    const filtered = project === "all" ? all : all.filter((i) => i.task.project === project);
    const sorted = [...filtered].sort((a, b) =>
      sort === "recent"
        ? b.task.recency - a.task.recency || a.action.label.localeCompare(b.action.label)
        : a.action.label.localeCompare(b.action.label),
    );
    return sorted;
  }, [project, sort]);

  const verified = items.filter((i) => i.action.tested).length;

  return (
    <div className="hub-scrim" onClick={onClose}>
      <aside className="hub-panel" role="dialog" aria-label="Run Hub" onClick={(e) => e.stopPropagation()}>
        <div className="hub-head">
          <div className="hub-head-title">
            <span className="hub-head-ico">
              <GridIcon />
            </span>
            <div>
              <h3>Run Hub</h3>
              <div className="hub-head-sub">Everything your tasks have made — one launcher.</div>
            </div>
          </div>
          <button className="settings-x" aria-label="Close Run Hub" onClick={onClose}>
            ✕
          </button>
        </div>

        <div className="hub-controls">
          <div className="hub-filter" role="tablist" aria-label="Filter by project">
            <button className={"hub-chip" + (project === "all" ? " on" : "")} onClick={() => setProject("all")}>
              All projects
            </button>
            {projects.map((p) => (
              <button key={p} className={"hub-chip" + (project === p ? " on" : "")} onClick={() => setProject(p)}>
                {p}
              </button>
            ))}
          </div>
          <div className="hub-sort">
            <span className="hub-sort-label">Sort</span>
            <div className="segment">
              <button className={sort === "recent" ? "on" : ""} onClick={() => setSort("recent")}>
                Recent
              </button>
              <button className={sort === "name" ? "on" : ""} onClick={() => setSort("name")}>
                Name
              </button>
            </div>
          </div>
        </div>

        <div className="hub-count mono">
          {items.length} action{items.length === 1 ? "" : "s"} · {verified} verified
        </div>

        <div className="hub-list">
          {items.map(({ action, task }) => (
            <HubRow key={task.id + ":" + action.id} action={action} task={task} onRun={onRun} />
          ))}
          {items.length === 0 ? <div className="hub-empty">No actions for this project yet.</div> : null}
        </div>
      </aside>
    </div>
  );
}

function HubRow({ action, task, onRun }: { action: RunAction; task: DemoTask; onRun: (a: RunAction) => void }) {
  const meta = KIND[action.kind];
  const gated = !action.tested;
  return (
    <div className={"hub-row" + (gated ? " gated" : "")}>
      <span className="hub-row-ico" style={{ "--k": meta.color } as CSSProperties}>
        {meta.icon}
      </span>
      <div className="hub-row-main">
        <div className="hub-row-label">{action.label}</div>
        <div className="hub-row-meta">
          <span className="hub-row-project" title={task.workspace}>
            {task.project}
          </span>
          {task.archived ? <span className="hub-tag archived">archived</span> : null}
          <span className="hub-tag kind">{meta.tag}</span>
        </div>
      </div>
      {gated ? (
        <span className="hub-row-gated" title="Not yet verified by QA.">
          <ShieldOffIcon /> not verified
        </span>
      ) : (
        <button className="btn ghost sm hub-row-run" onClick={() => onRun(action)}>
          {action.kind === "url" ? "Open" : action.kind === "shell" ? "Run" : action.kind === "file" ? "Launch" : "Open"}
        </button>
      )}
    </div>
  );
}

/* ---- icons (inline, matched to the app's 24-grid stroke style) ---- */

function GearIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  );
}

function GridIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect width="7" height="7" x="3" y="3" rx="1.5" />
      <rect width="7" height="7" x="14" y="3" rx="1.5" />
      <rect width="7" height="7" x="14" y="14" rx="1.5" />
      <rect width="7" height="7" x="3" y="14" rx="1.5" />
    </svg>
  );
}

function UrlIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M15 3h6v6" />
      <path d="M10 14 21 3" />
      <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
    </svg>
  );
}

function FolderIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" />
    </svg>
  );
}

function FileIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <path d="M14 2v6h6" />
      <path d="m10 12 4 2.5-4 2.5z" fill="currentColor" stroke="none" />
    </svg>
  );
}

function ShellIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="m7 9 3 3-3 3" />
      <path d="M13 15h4" />
    </svg>
  );
}

function ShieldCheckIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z" />
      <path d="m9 12 2 2 4-4" />
    </svg>
  );
}

function ShieldOffIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M19.7 14A9.5 9.5 0 0 0 20 12V6a1 1 0 0 0-1-1c-1.5 0-3.3-.66-4.8-1.6" />
      <path d="M4.7 4.7A1 1 0 0 0 4 6v6c0 5 3.5 7.5 7.66 8.95a1 1 0 0 0 .67 0 12.7 12.7 0 0 0 3-1.6" />
      <path d="M2 2l20 20" />
    </svg>
  );
}

function SparkIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="m12 3 1.9 4.8L18.7 9.7l-4.8 1.9L12 16.4l-1.9-4.8L5.3 9.7l4.8-1.9z" />
    </svg>
  );
}

function DotIcon() {
  return (
    <svg width="7" height="7" viewBox="0 0 8 8" aria-hidden="true">
      <circle cx="4" cy="4" r="4" fill="currentColor" />
    </svg>
  );
}
