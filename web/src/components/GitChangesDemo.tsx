import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import ggLogo from "../assets/gg-logo.png";

/**
 * Git / Changes — a self-contained, mock-data PREVIEW of a proposed per-task Git surface. It's mounted on
 * its own hash route (#git-changes, see main.tsx) so it never touches the live board, store, WebSocket, or
 * any real repo — it renders entirely from the fixtures below and its own local state. Every mutation is
 * simulated: switching branch or pushing raises a toast ("would switch / would push"). Nothing is executed;
 * NO real git command ever runs.
 *
 * The concept — replace what the owner opens GitHub Desktop for, brought into the task card:
 *   • ANTI-BLOAT / progressive disclosure — the card face shows only a tiny "Changes" chip (file count,
 *     ±lines, and a subtle status dot). The heavy stuff (file list, diffs, commit log, branch + push
 *     status, branch switcher) lives in a right-side DRAWER that opens when you click the chip — never
 *     inline on the already-dense card.
 *   • Diffs — the files this task touched, add/remove counts, expandable per-file unified diff.
 *   • Commits — the commit(s) this task made (hash, subject, when).
 *   • Push / branch status — current branch, ahead/behind, and a clear "committed, not pushed" state.
 *     myaccount repos are commit-only by policy, so "not pushed" is their NORMAL steady state — shown neutrally,
 *     never as a nag.
 *   • Branch switching — a switcher that is LOCKED while the task's implementor is running (switching would
 *     collide with the agent's own git work) and enabled once the task is idle / done.
 */

// The task's git sync situation, derived from its fixture. Each maps to a distinct header treatment so the
// four canonical cases — up-to-date, committed-not-pushed, commit-only-by-policy, agent-still-working —
// read differently at a glance.
type Sync = "pushed" | "unpushed" | "commit-only" | "working";

type DemoState = "done" | "review" | "implementing";

interface DiffLine {
  t: "ctx" | "add" | "del";
  text: string;
}

interface Hunk {
  /** 1-based start line of this hunk on the OLD and NEW side; per-line numbers are derived while rendering. */
  oldStart: number;
  newStart: number;
  /** Optional trailing context on the @@ header line (e.g. the enclosing function), like real git output. */
  label?: string;
  lines: DiffLine[];
}

interface FileChange {
  path: string;
  status: "A" | "M" | "D";
  hunks: Hunk[];
}

interface Commit {
  hash: string;
  subject: string;
  /** Pre-rendered relative time — kept static so the demo is deterministic. */
  when: string;
  author: string;
  /** False for a commit that hasn't reached the remote yet (drives the per-commit "local" tag). */
  pushed: boolean;
}

interface DemoTask {
  id: string;
  title: string;
  /** Full workspace path — the card foregrounds its last segment (the repo), exactly like the real board. */
  workspace: string;
  state: DemoState;
  /** The active branch, plus the other local branches the switcher offers. */
  branch: string;
  branches: string[];
  /** Commits this task's work is ahead of the remote by (0 once pushed). */
  ahead: number;
  /** myaccount policy: origin is a myaccount repo, so this repo is committed-only and never pushed — by design. */
  commitOnly: boolean;
  /** The implementor is live and doing its own git work — every mutating control locks. */
  running: boolean;
  /** A running task may have edits in the working tree not yet committed; surfaced as an "uncommitted" note. */
  workingNote?: string;
  commits: Commit[];
  files: FileChange[];
}

// The mock board — the owner's actual recent tasks, so the preview reads as their real work, one per
// canonical git state:
//   1. example deploy   → pushed, up to date (main).
//   2. WoW SelfRotation    → committed, NOT pushed — a normal repo, shown with a normal Push affordance.
//   3. myaccount fleet board    → committed, not pushed — the commit-only steady state, shown neutrally.
//   4. AmeisenBotX nav     → implementor RUNNING — working-tree edits, no commit yet, controls LOCKED.
const TASKS: DemoTask[] = [
  {
    id: "example",
    title: "example → Vercel deploy",
    workspace: "C:\\Users\\Mikkel\\projects\\prediction-market-bot",
    state: "done",
    branch: "main",
    branches: ["main", "deploy/vercel", "paper-background"],
    ahead: 0,
    commitOnly: false,
    running: false,
    commits: [
      {
        hash: "a1b2c3d",
        subject: "feat: Vercel deploy config + serverless API entry",
        when: "2 hours ago",
        author: "implementor",
        pushed: true,
      },
    ],
    files: [
      {
        path: "vercel.json",
        status: "A",
        hunks: [
          {
            oldStart: 0,
            newStart: 1,
            lines: [
              { t: "add", text: "{" },
              { t: "add", text: '  "version": 2,' },
              { t: "add", text: '  "builds": [' },
              { t: "add", text: '    { "src": "api/index.py", "use": "@vercel/python" }' },
              { t: "add", text: "  ]," },
              { t: "add", text: '  "routes": [' },
              { t: "add", text: '    { "src": "/(.*)", "dest": "api/index.py" }' },
              { t: "add", text: "  ]," },
              { t: "add", text: '  "env": { "POLY_ENV": "prod" }' },
              { t: "add", text: "}" },
            ],
          },
        ],
      },
      {
        path: "api/index.py",
        status: "M",
        hunks: [
          {
            oldStart: 12,
            newStart: 12,
            label: "def handler(request):",
            lines: [
              { t: "ctx", text: "from bot.dashboard import render_dashboard" },
              { t: "ctx", text: "" },
              { t: "del", text: "def handler(request):" },
              { t: "del", text: "    return render_dashboard()" },
              { t: "add", text: "def handler(request):" },
              { t: "add", text: "    # Vercel wraps this module as a single serverless function." },
              { t: "add", text: "    if request.path.startswith('/api/health'):" },
              { t: "add", text: "        return {'statusCode': 200, 'body': 'ok'}" },
              { t: "add", text: "    return render_dashboard()" },
            ],
          },
        ],
      },
      {
        path: "bot/config.py",
        status: "M",
        hunks: [
          {
            oldStart: 4,
            newStart: 4,
            lines: [
              { t: "ctx", text: "import os" },
              { t: "ctx", text: "" },
              { t: "del", text: "BASE_URL = 'http://localhost:8000'" },
              { t: "add", text: "BASE_URL = os.environ.get('POLY_BASE_URL', 'http://localhost:8000')" },
            ],
          },
        ],
      },
    ],
  },
  {
    id: "wow-selfrotation",
    title: "WoW SelfRotation",
    workspace: "C:\\Users\\Mikkel\\projects\\wow\\world of warcraft 3.3.5a hd",
    state: "review",
    branch: "master",
    branches: ["master", "self-rotation", "party-cast"],
    ahead: 2,
    commitOnly: false,
    running: false,
    commits: [
      {
        hash: "7f3e9a1",
        subject: "feat: SelfRotation combat priority + cast queue",
        when: "18 minutes ago",
        author: "implementor",
        pushed: false,
      },
      {
        hash: "3c1d80b",
        subject: "chore: lua_unlock helper to patch the signed client",
        when: "34 minutes ago",
        author: "implementor",
        pushed: false,
      },
    ],
    files: [
      {
        path: "lua_unlock.py",
        status: "A",
        hunks: [
          {
            oldStart: 0,
            newStart: 1,
            lines: [
              { t: "add", text: '"""Patch the 3.3.5a client so unsigned Lua (SetAutoloot etc.) is allowed."""' },
              { t: "add", text: "import pathlib, shutil, struct" },
              { t: "add", text: "" },
              { t: "add", text: "CLIENT = pathlib.Path('Wow.exe')" },
              { t: "add", text: "PATCH_OFFSET = 0x4C7A10" },
              { t: "add", text: "" },
              { t: "add", text: "def unlock():" },
              { t: "add", text: "    shutil.copy(CLIENT, 'Wow-unlocked.exe')" },
              { t: "add", text: "    buf = bytearray(pathlib.Path('Wow-unlocked.exe').read_bytes())" },
              { t: "add", text: "    buf[PATCH_OFFSET:PATCH_OFFSET + 2] = b'\\x90\\x90'  # NOP the signed-only guard" },
              { t: "add", text: "    pathlib.Path('Wow-unlocked.exe').write_bytes(buf)" },
            ],
          },
        ],
      },
      {
        path: "Interface/AddOns/SelfRotation/SelfRotation.lua",
        status: "M",
        hunks: [
          {
            oldStart: 1,
            newStart: 1,
            label: "SelfRotation bootstrap",
            lines: [
              { t: "ctx", text: "local SelfRotation = CreateFrame('Frame', 'SelfRotation')" },
              { t: "del", text: "local SPELL_HEAL = 2050" },
              { t: "add", text: "local SPELL_HEAL = 2050  -- Lesser Heal" },
              { t: "add", text: "local SPELL_SHIELD = 17" },
              { t: "add", text: "local LOW_HP = 0.55" },
            ],
          },
          {
            oldStart: 40,
            newStart: 42,
            label: "function SelfRotation:Pulse()",
            lines: [
              { t: "ctx", text: "function SelfRotation:Pulse()" },
              { t: "del", text: "  if UnitHealth('player') < 100 then" },
              { t: "del", text: "    CastSpellByID(SPELL_HEAL)" },
              { t: "del", text: "  end" },
              { t: "add", text: "  local hp = UnitHealth('player') / UnitHealthMax('player')" },
              { t: "add", text: "  if hp < LOW_HP and not self:HasBuff(SPELL_SHIELD) then" },
              { t: "add", text: "    CastSpellByID(SPELL_SHIELD)" },
              { t: "add", text: "  elseif hp < LOW_HP then" },
              { t: "add", text: "    CastSpellByID(SPELL_HEAL)" },
              { t: "add", text: "  end" },
              { t: "ctx", text: "end" },
            ],
          },
        ],
      },
    ],
  },
  {
    id: "myaccount-fleet",
    title: "myaccount fleet — live PnL sparkline",
    workspace: "C:\\Users\\Mikkel\\projects\\myaccount-fleet-dashboard",
    state: "done",
    branch: "main",
    branches: ["main", "sparkline"],
    ahead: 1,
    commitOnly: true,
    running: false,
    commits: [
      {
        hash: "b90ff21",
        subject: "feat: live PnL sparkline on the fleet dashboard",
        when: "1 hour ago",
        author: "implementor",
        pushed: false,
      },
    ],
    files: [
      {
        path: "dashboard/live.tsx",
        status: "M",
        hunks: [
          {
            oldStart: 22,
            newStart: 22,
            label: "function FleetRow({ fleet })",
            lines: [
              { t: "ctx", text: "  const pnl = useLivePnl(fleet.id);" },
              { t: "del", text: "  return <td className=\"pnl\">{fmt(pnl.total)}</td>;" },
              { t: "add", text: "  return (" },
              { t: "add", text: "    <td className=\"pnl\">" },
              { t: "add", text: "      <Sparkline points={pnl.series} width={72} height={18} />" },
              { t: "add", text: "      <span>{fmt(pnl.total)}</span>" },
              { t: "add", text: "    </td>" },
              { t: "add", text: "  );" },
            ],
          },
        ],
      },
      {
        path: "config/pairs.yaml",
        status: "M",
        hunks: [
          {
            oldStart: 8,
            newStart: 8,
            lines: [
              { t: "ctx", text: "  poll_ms: 2000" },
              { t: "del", text: "  sparkline: false" },
              { t: "add", text: "  sparkline: true" },
            ],
          },
        ],
      },
    ],
  },
  {
    id: "ameisen-nav",
    title: "AmeisenBotX navigation integration",
    workspace: "C:\\Users\\Mikkel\\projects\\wow\\world of warcraft 3.3.5a hd",
    state: "implementing",
    branch: "nav-integration",
    branches: ["nav-integration", "master"],
    ahead: 0,
    commitOnly: false,
    running: true,
    workingNote: "The implementor is editing these files right now — they'll be committed when the phase finishes.",
    commits: [],
    files: [
      {
        path: "bot/Navigation/AmeisenNavClient.cs",
        status: "M",
        hunks: [
          {
            oldStart: 30,
            newStart: 30,
            label: "public Vector3[] GetPath(Vector3 from, Vector3 to)",
            lines: [
              { t: "ctx", text: "public Vector3[] GetPath(Vector3 from, Vector3 to)" },
              { t: "del", text: "    => _client.Request(from, to);" },
              { t: "add", text: "{" },
              { t: "add", text: "    var path = _client.Request(from, to);" },
              { t: "add", text: "    return path.Length > 0 ? path : Fallback(from, to);" },
              { t: "add", text: "}" },
            ],
          },
        ],
      },
      {
        path: "bot/Profiles/GrindProfile.cs",
        status: "M",
        hunks: [
          {
            oldStart: 15,
            newStart: 15,
            lines: [
              { t: "ctx", text: "  UseNavmesh = true," },
              { t: "add", text: "  NavmeshServerPort = 47110," },
            ],
          },
        ],
      },
    ],
  },
];

/** The sync state for a task, derived from its fixture — see the Sync type. */
function syncOf(t: DemoTask): Sync {
  if (t.running) return "working";
  if (t.commitOnly) return "commit-only";
  if (t.ahead > 0) return "unpushed";
  return "pushed";
}

/** Count added / removed lines across every hunk of a file — so the file's ±badge and the card chip's
 *  totals are always derived from the real diff content, never a number that can drift out of sync. */
function fileStat(f: FileChange): { add: number; del: number } {
  let add = 0;
  let del = 0;
  for (const h of f.hunks)
    for (const l of h.lines) {
      if (l.t === "add") add++;
      else if (l.t === "del") del++;
    }
  return { add, del };
}

function taskStat(t: DemoTask): { files: number; add: number; del: number } {
  let add = 0;
  let del = 0;
  for (const f of t.files) {
    const s = fileStat(f);
    add += s.add;
    del += s.del;
  }
  return { files: t.files.length, add, del };
}

/** Split a workspace into parent + repo leaf, mirroring Board.splitWorkspace so the card path reads the same. */
function splitWorkspace(p: string): { parent: string; leaf: string } {
  const norm = p.replace(/[\\/]+$/, "");
  const i = Math.max(norm.lastIndexOf("\\"), norm.lastIndexOf("/"));
  return i < 0 ? { parent: "", leaf: norm } : { parent: norm.slice(0, i), leaf: norm.slice(i) };
}

// State → the card's accent colour + badge label, mirroring the live board's stateColor/stateLabel.
const STATE: Record<DemoState, { color: string; label: string }> = {
  done: { color: "var(--ok)", label: "done" },
  review: { color: "var(--warn)", label: "review" },
  implementing: { color: "var(--role-implementor)", label: "implementing" },
};

type Toast = { id: number; text: string };

export function GitChangesDemo() {
  // The task whose Git drawer is open (null = closed). This is the whole progressive-disclosure hinge:
  // the card face stays minimal, and ALL the git detail lives in the drawer this opens.
  const [openId, setOpenId] = useState<string | null>(null);
  const [toast, setToast] = useState<Toast | null>(null);

  const showToast = (text: string) => setToast({ id: Date.now(), text });
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast((cur) => (cur && cur.id === toast.id ? null : cur)), 3200);
    return () => clearTimeout(timer);
  }, [toast]);

  const openTask = openId ? TASKS.find((t) => t.id === openId) ?? null : null;
  const totals = useMemo(() => TASKS.reduce((n, t) => n + t.files.length, 0), []);

  return (
    <div className="app git-demo">
      <header className="topbar">
        <div className="brand">
          <span className="build-tag">
            preview<span className="sha">mock</span>
          </span>
          <div className="wordmark">
            <img className="brand-logo" src={ggLogo} alt="GG Orchestrator" />
            <span className="sub">git&nbsp;/&nbsp;changes&nbsp;·&nbsp;preview</span>
          </div>
        </div>
        <span className="demo-pill" title="This is a design preview built from mock data — nothing here touches your real repos or runs any git command.">
          <DotIcon /> Preview · mock data
        </span>
        <div className="spacer" />
        <span className="stat">
          <b>{TASKS.length}</b> tasks · <b>{totals}</b> changed files
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
            {TASKS.length} total · click a Changes chip to open the Git view
          </span>
        </div>

        <div className="board-hint">
          <span className="board-hint-ico">
            <ForkIcon size={16} />
          </span>
          <div className="board-hint-text">
            <div className="board-hint-title">Git / Changes — see what each task changed, without leaving the board</div>
            <div className="board-hint-sub">
              Cards stay minimal: each shows a small <b>Changes</b> chip. Click it to open the full view — file diffs, commit log,
              branch &amp; push status, and a branch switcher — in a side drawer. Replaces opening GitHub Desktop per task.
            </div>
          </div>
        </div>

        <div className="lanes">
          {TASKS.map((t) => (
            <ChangesCard key={t.id} task={t} onOpen={() => setOpenId(t.id)} isOpen={openId === t.id} />
          ))}
        </div>

        <p className="demo-foot-note">
          Preview only — mock data, not wired to real git. Diffs, commits and branches are fixtures; the branch switch and push
          buttons simulate (toast), no command runs. Load this any time at <code>/#git-changes</code>.
        </p>
      </main>

      {openTask ? <GitPanel task={openTask} onClose={() => setOpenId(null)} onSimulate={showToast} /> : null}

      {toast ? <div className="demo-toast">{toast.text}</div> : null}
    </div>
  );
}

/** One board task, styled as a native card. The ONLY git affordance on the card face is the collapsed
 *  Changes chip — everything heavy lives in the drawer it opens. This is the anti-bloat contract. */
function ChangesCard({ task, onOpen, isOpen }: { task: DemoTask; onOpen: () => void; isOpen: boolean }) {
  const { parent, leaf } = splitWorkspace(task.workspace);
  const st = STATE[task.state];
  return (
    <div className={"card" + (isOpen ? " sel" : "") + (task.running ? " live" : "")} style={{ "--state-color": st.color } as CSSProperties}>
      {task.running ? <span className="live-dot" title="Active — an agent is working on this task right now" /> : null}
      <div className="title">{task.title}</div>
      <div className="ws-path" title={task.workspace}>
        <svg className="ws-ico" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" />
        </svg>
        {parent ? <span className="ws-parent">{parent}</span> : null}
        <span className="ws-leaf">{leaf}</span>
      </div>

      <ChangesChip task={task} onOpen={onOpen} />

      <div className="foot">
        <span className="badge" style={{ "--state-color": st.color } as CSSProperties}>
          {st.label}
        </span>
      </div>
    </div>
  );
}

/** The collapsed summary affordance — the card's entire git footprint. A branch-fork glyph, the changed
 *  file count and ±line totals (both derived from the real diff), then a single status marker: a subtle
 *  "not pushed" dot for a normal unpushed repo, a neutral "commit-only" tag for a myaccount repo, or a live
 *  pulse while the agent is still working. A clean/pushed task shows no marker at all. */
function ChangesChip({ task, onOpen }: { task: DemoTask; onOpen: () => void }) {
  const { files, add, del } = taskStat(task);
  const sync = syncOf(task);
  return (
    <button
      className="changes-chip"
      onClick={onOpen}
      title="Open the Git / Changes view — diffs, commits, branch & push status"
      aria-label={`Changes: ${files} files, ${add} added, ${del} removed. Open Git view.`}
    >
      <ForkIcon size={13} />
      <span className="cc-files">
        {files} file{files === 1 ? "" : "s"}
      </span>
      <span className="cc-stat">
        <span className="cc-add">+{add}</span>
        <span className="cc-del">−{del}</span>
      </span>
      {sync === "unpushed" ? <span className="cc-dot unpushed" title="Committed, not pushed" /> : null}
      {sync === "commit-only" ? <span className="cc-tag">commit-only</span> : null}
      {sync === "working" ? <span className="cc-dot working" title="Agent is working — uncommitted changes" /> : null}
      <ChevronIcon />
    </button>
  );
}

/** The Git / Changes drawer: everything the card deliberately withholds. A right-side sheet (mirrors the
 *  file/deliverable panels) with the branch + push header, the branch switcher, the commit log, and the
 *  expandable per-file diffs. All mutations simulate. */
function GitPanel({ task, onClose, onSimulate }: { task: DemoTask; onClose: () => void; onSimulate: (t: string) => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const { parent, leaf } = splitWorkspace(task.workspace);

  return (
    <div className="git-scrim" onClick={onClose}>
      <aside className="git-panel" role="dialog" aria-label={`Git changes — ${task.title}`} onClick={(e) => e.stopPropagation()}>
        <div className="git-head">
          <div className="git-head-title">
            <span className="git-head-ico">
              <ForkIcon size={16} />
            </span>
            <div className="git-head-text">
              <h3>{task.title}</h3>
              <div className="git-head-sub" title={task.workspace}>
                {parent ? <span className="git-head-parent">{parent}</span> : null}
                <span className="git-head-leaf">{leaf}</span>
              </div>
            </div>
          </div>
          <button className="settings-x" aria-label="Close Git view" onClick={onClose}>
            ✕
          </button>
        </div>

        <BranchBar task={task} onSimulate={onSimulate} />

        <div className="git-body">
          <CommitLog task={task} />
          <FileList task={task} />
        </div>
      </aside>
    </div>
  );
}

/** The branch + push header: the current branch (with a switcher), ahead/behind, and the push status. The
 *  switcher and push button LOCK while the implementor runs — switching or pushing under the agent would
 *  collide with its own git work. myaccount repos are commit-only: their "not pushed" is the intended steady
 *  state, so it's shown neutrally with no push button and no nag. */
function BranchBar({ task, onSimulate }: { task: DemoTask; onSimulate: (t: string) => void }) {
  const sync = syncOf(task);
  const locked = task.running;
  const lockReason =
    "Locked while the implementor is running — switching branches or pushing now would collide with the agent's own git work. Available once the task is idle or done.";

  return (
    <div className="branch-bar">
      <div className="branch-row">
        <BranchSwitcher task={task} disabled={locked} disabledReason={lockReason} onSimulate={onSimulate} />
        <PushStatus sync={sync} ahead={task.ahead} />
      </div>

      <div className="branch-actions">
        <SyncNote task={task} sync={sync} />
        {sync === "unpushed" ? (
          <button
            className="btn primary sm"
            onClick={() => onSimulate(`Would push ${task.ahead} commit${task.ahead === 1 ? "" : "s"} → origin/${task.branch}  (simulated — no command runs)`)}
          >
            <UploadIcon /> Push {task.ahead} commit{task.ahead === 1 ? "" : "s"}
          </button>
        ) : null}
      </div>

      {locked ? (
        <div className="branch-lock" title={lockReason}>
          <LockIcon /> Branch controls are locked while the agent is committing.
        </div>
      ) : null}
    </div>
  );
}

/** The current-branch control. When idle it opens a small listbox to switch branch (simulated); when the
 *  implementor is running it renders as an inert, locked pill with an explanatory tooltip. */
function BranchSwitcher({
  task,
  disabled,
  disabledReason,
  onSimulate,
}: {
  task: DemoTask;
  disabled: boolean;
  disabledReason: string;
  onSimulate: (t: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  if (disabled) {
    return (
      <span className="branch-switch locked" title={disabledReason} aria-disabled="true">
        <BranchIcon />
        <span className="branch-name">{task.branch}</span>
        <LockIcon />
      </span>
    );
  }

  return (
    <div className="branch-switch-wrap" ref={ref}>
      <button
        className={"branch-switch" + (open ? " open" : "")}
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="listbox"
        aria-expanded={open}
        title="Switch branch"
      >
        <BranchIcon />
        <span className="branch-name">{task.branch}</span>
        <span className="branch-caret" aria-hidden="true">
          ▾
        </span>
      </button>
      {open ? (
        <ul className="ws-menu branch-list" role="listbox" aria-label="Switch branch">
          {task.branches.map((b) => (
            <li
              key={b}
              role="option"
              aria-selected={b === task.branch}
              className={"ws-opt branch-opt" + (b === task.branch ? " hi" : "")}
              onClick={() => {
                setOpen(false);
                if (b === task.branch) return;
                onSimulate(`Would switch branch → ${b}  (simulated — no checkout runs)`);
              }}
            >
              <BranchIcon />
              <span className="nm">{b}</span>
              {b === task.branch ? <span className="branch-current">current</span> : null}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

/** The push-state pill on the right of the branch row — the at-a-glance answer to "did this reach the
 *  remote?". Deliberately neutral for the commit-only case: it's a status, not a warning. */
function PushStatus({ sync, ahead }: { sync: Sync; ahead: number }) {
  if (sync === "pushed")
    return (
      <span className="push-pill pushed" title="Up to date with origin">
        <CheckIcon /> Up to date
      </span>
    );
  if (sync === "unpushed")
    return (
      <span className="push-pill unpushed" title="Committed locally, not yet pushed">
        <UpArrowIcon /> {ahead} ahead
      </span>
    );
  if (sync === "commit-only")
    return (
      <span className="push-pill commit-only" title="myaccount repo — commit-only by policy, never pushed">
        <ShieldIcon /> commit-only
      </span>
    );
  return (
    <span className="push-pill working" title="The implementor is committing its work">
      <span className="push-spinner" /> working
    </span>
  );
}

/** The one-line explanation under the branch row, keyed off the sync state. This is where the commit-only
 *  policy is spelled out neutrally, and where a running task's uncommitted-changes note lands. */
function SyncNote({ task, sync }: { task: DemoTask; sync: Sync }) {
  if (sync === "pushed") return <span className="sync-note">All commits are on <code>origin/{task.branch}</code>.</span>;
  if (sync === "unpushed")
    return (
      <span className="sync-note">
        {task.ahead} commit{task.ahead === 1 ? "" : "s"} committed locally, not yet on the remote.
      </span>
    );
  if (sync === "commit-only")
    return (
      <span className="sync-note">
        This is a <b>myaccount</b> repo — commit-only by policy. Changes are committed but <b>never pushed</b>; this is the intended
        steady state, not a pending action.
      </span>
    );
  return <span className="sync-note">{task.workingNote}</span>;
}

/** The commit log — the commit(s) this task made: short hash, subject, author, when. A local (not-yet-
 *  pushed) commit carries a quiet "local" tag so you can see exactly which commits haven't reached origin. */
function CommitLog({ task }: { task: DemoTask }) {
  return (
    <section className="git-section">
      <div className="git-section-head">
        <CommitIcon />
        <h4>Commits</h4>
        <span className="git-section-count">{task.commits.length}</span>
      </div>
      {task.commits.length === 0 ? (
        <div className="commit-empty">
          No commits yet — the implementor is still working. Its edits are in the working tree below and will be committed when the
          phase finishes.
        </div>
      ) : (
        <ol className="commit-list">
          {task.commits.map((c) => (
            <li key={c.hash} className="commit-row">
              <span className="commit-node" aria-hidden="true" />
              <div className="commit-main">
                <div className="commit-subject">{c.subject}</div>
                <div className="commit-meta">
                  <span className="commit-hash mono">{c.hash}</span>
                  <span className="commit-dot">·</span>
                  <span className="commit-author">{c.author}</span>
                  <span className="commit-dot">·</span>
                  <span className="commit-when">{c.when}</span>
                  {!c.pushed ? <span className="commit-local" title="Not yet pushed to origin">local</span> : null}
                </div>
              </div>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

/** The changed-file list — one expandable row per file. Collapsed it's the status glyph, path and ±badge;
 *  expanded it reveals the unified diff. Starts with the first file open so the drawer never lands empty. */
function FileList({ task }: { task: DemoTask }) {
  const uncommitted = task.running;
  return (
    <section className="git-section">
      <div className="git-section-head">
        <FileDiffIcon />
        <h4>{uncommitted ? "Working tree" : "Changed files"}</h4>
        <span className="git-section-count">{task.files.length}</span>
      </div>
      <div className="file-list">
        {task.files.map((f, i) => (
          <FileRow key={f.path} file={f} defaultOpen={i === 0} uncommitted={uncommitted} />
        ))}
      </div>
    </section>
  );
}

const STATUS_META: Record<FileChange["status"], { label: string; cls: string; full: string }> = {
  A: { label: "A", cls: "added", full: "Added" },
  M: { label: "M", cls: "modified", full: "Modified" },
  D: { label: "D", cls: "deleted", full: "Deleted" },
};

function FileRow({ file, defaultOpen, uncommitted }: { file: FileChange; defaultOpen: boolean; uncommitted: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  const { add, del } = fileStat(file);
  const meta = STATUS_META[file.status];
  const { dir, name } = splitPath(file.path);
  return (
    <div className={"file-row" + (open ? " open" : "")}>
      <button className="file-row-head" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        <span className={"file-caret" + (open ? " open" : "")} aria-hidden="true">
          ›
        </span>
        <span className={"file-status " + meta.cls} title={uncommitted ? `${meta.full} (uncommitted)` : meta.full}>
          {meta.label}
        </span>
        <span className="file-path" title={file.path}>
          {dir ? <span className="file-dir">{dir}</span> : null}
          <span className="file-name">{name}</span>
        </span>
        <span className="file-stat">
          {add > 0 ? <span className="file-add">+{add}</span> : null}
          {del > 0 ? <span className="file-del">−{del}</span> : null}
        </span>
      </button>
      {open ? <Diff hunks={file.hunks} /> : null}
    </div>
  );
}

/** A unified diff, rendered from hunks. Line numbers on both the old and new sides are computed while
 *  walking each hunk (context advances both, an add advances only new, a del only old) so the gutters are
 *  self-consistent — no hand-numbered lines to drift. Add/remove lines get the conventional green/red
 *  tint; the @@ header shows the hunk range plus any enclosing-scope label, like real git output. */
function Diff({ hunks }: { hunks: Hunk[] }) {
  return (
    <div className="diff">
      {hunks.map((h, hi) => {
        let oldNo = h.oldStart;
        let newNo = h.newStart;
        const oldLen = h.lines.filter((l) => l.t !== "add").length;
        const newLen = h.lines.filter((l) => l.t !== "del").length;
        return (
          <div className="diff-hunk" key={hi}>
            <div className="diff-hunk-head">
              <span className="diff-range">
                @@ -{h.oldStart},{oldLen} +{h.newStart},{newLen} @@
              </span>
              {h.label ? <span className="diff-label">{h.label}</span> : null}
            </div>
            {h.lines.map((l, li) => {
              const oldCell = l.t === "add" ? "" : String(oldNo++);
              const newCell = l.t === "del" ? "" : String(newNo++);
              const sign = l.t === "add" ? "+" : l.t === "del" ? "−" : " ";
              return (
                <div className={"diff-line " + l.t} key={li}>
                  <span className="diff-gutter old">{oldCell}</span>
                  <span className="diff-gutter new">{newCell}</span>
                  <span className="diff-sign" aria-hidden="true">
                    {sign}
                  </span>
                  <span className="diff-text">{l.text || " "}</span>
                </div>
              );
            })}
          </div>
        );
      })}
    </div>
  );
}

/** Split a file path into its directory prefix (dimmed) and filename (foregrounded) — the filename is what
 *  you scan for, mirroring how the board treats the repo leaf. */
function splitPath(p: string): { dir: string; name: string } {
  const i = p.lastIndexOf("/");
  return i < 0 ? { dir: "", name: p } : { dir: p.slice(0, i + 1), name: p.slice(i + 1) };
}

/* ---- icons (inline, matched to the app's 24-grid stroke style) ---- */

function ForkIcon({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="6" cy="4" r="2" />
      <circle cx="6" cy="20" r="2" />
      <circle cx="18" cy="8" r="2" />
      <path d="M6 6v12" />
      <path d="M18 10a5 5 0 0 1-5 5H8" />
    </svg>
  );
}

function BranchIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <line x1="6" y1="3" x2="6" y2="15" />
      <circle cx="18" cy="6" r="3" />
      <circle cx="6" cy="18" r="3" />
      <path d="M18 9a9 9 0 0 1-9 9" />
    </svg>
  );
}

function CommitIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="3" />
      <line x1="3" y1="12" x2="9" y2="12" />
      <line x1="15" y1="12" x2="21" y2="12" />
    </svg>
  );
}

function FileDiffIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <path d="M14 2v6h6" />
      <line x1="12" y1="12" x2="12" y2="18" />
      <line x1="9" y1="15" x2="15" y2="15" />
    </svg>
  );
}

function UploadIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 19V6" />
      <path d="m6 11 6-6 6 6" />
      <path d="M5 21h14" />
    </svg>
  );
}

function UpArrowIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 19V5" />
      <path d="m6 11 6-6 6 6" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="m5 12 5 5L20 6" />
    </svg>
  );
}

function ShieldIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z" />
    </svg>
  );
}

function LockIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="4" y="11" width="16" height="10" rx="2" />
      <path d="M8 11V7a4 4 0 0 1 8 0v4" />
    </svg>
  );
}

function ChevronIcon() {
  return (
    <svg className="cc-chevron" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="m9 18 6-6-6-6" />
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
