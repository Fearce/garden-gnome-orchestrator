import { memo, useCallback, useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { useStore } from "../store.js";
import { apiUrl } from "../lib/base.js";
import { AttachButton, ComposerThumbs, MessageThumbs, useAttachments } from "../lib/attachments.js";
import { FolderPicker } from "./FolderPicker.js";
import { PathInput } from "./PathInput.js";
import { Gnome } from "./Gnome.js";
import { Markdown } from "./Markdown.js";
import { CLAUDE_EFFORTS, CODEX_SUB_ID, DEFAULT_SUB_ID, codexEffortsForModel, type CodexEffort, type DirectorItem, type DirectorMessage, type DirectorStatus, type Effort, type OrchestratorSettings, type Role, type TaskSearchHit } from "../types.js";
import { codexModelOptions } from "../lib/models.js";
import { effortLabel, modelLabel, stateColor, stateLabel } from "../lib/format.js";
import { ModelSelect, useModelOverrides } from "./ModelSelect.js";
import { columnDragMax, useColumnResize } from "./useColumnResize.js";

// The recent-repo chips and the skip-director mode are persisted SERVER-SIDE (in OrchestratorSettings),
// not localStorage — the console is served on both an HTTP and an HTTPS origin (the tablet Deck iframes
// the HTTPS port) and those origins don't share localStorage, so a client-only store wouldn't carry
// across surfaces. The list is capped at settings.maxRecentRepos. Trailing-separator-tolerant basename,
// cross-platform (handles / and \ paths):
const repoLabel = (p: string): string => p.replace(/[/\\]+$/, "").split(/[/\\]/).pop() || p;

export function directorRuntimeLabel(status: DirectorStatus | null, busy: boolean): string {
  const provider = status ? ({ claude: "Claude", codex: "Codex", grok: "Grok", zai: "z.ai" } as const)[status.provider] : "";
  const running = status ? `director · ${provider} · ${modelLabel(status.model).toLowerCase()}` : "director · selecting model";
  return busy ? `${running} · thinking…` : running;
}

// Tracks "this rail has no room to spare" (mirrors the CSS bands — keep the two in step) so a few
// controls can swap to a space-frugal layout: the wrapping recent-repo chips become a single dropdown
// row. Re-renders on viewport crossings (rotate / resize).
//
// The second clause is not decoration. Nine remembered repos wrap to FOUR rows of chips — 162px of a
// 679px rail — and at 1280×800 landscape that left the transcript 149px, i.e. no visible conversation
// at all. Width alone never catches it: the rail is ~384px wide whatever the viewport is, so the
// chips wrap exactly the same at 1280 as at 800. A coarse pointer means a tablet means the rail's
// height is the scarce thing, and the dropdown is one row instead of four.
const COMPACT_MQ = "(max-width: 899.98px), (pointer: coarse) and (max-width: 1365.98px)";

function useIsCompact(): boolean {
  const [compact, setCompact] = useState(
    () => typeof window !== "undefined" && window.matchMedia(COMPACT_MQ).matches,
  );
  useEffect(() => {
    const mq = window.matchMedia(COMPACT_MQ);
    const onChange = () => setCompact(mq.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);
  return compact;
}

export function Director() {
  const items = useStore((s) => s.director);
  const draft = useStore((s) => s.directorDraft);
  const busy = useStore((s) => s.directorBusy);
  const sendPrompt = useStore((s) => s.sendPrompt);
  const sendDirect = useStore((s) => s.sendDirect);
  const cancelDirector = useStore((s) => s.cancelDirector);
  const directorName = useStore((s) => s.settings.directorName);
  // Runtime truth from the server. The director can move between Claude, Codex, Grok and z.ai when a
  // subscription caps, so deriving this label from the default Claude setting would immediately lie.
  const directorStatus = useStore((s) => s.directorStatus);
  const setSettings = useStore((s) => s.setSettings);
  // Skip-director mode + the recent-repo list live in the server-persisted settings so they survive a
  // reload on ANY surface (see the repoLabel note above). setSettings is optimistic, so toggling/adding
  // reflects instantly and the server broadcast reconciles every connected client.
  const skip = useStore((s) => s.settings.skipDirector);
  const showPickers = useStore((s) => s.settings.showComposerPickers);
  const recentRepos = useStore((s) => s.settings.recentRepos);
  const maxRecentRepos = useStore((s) => s.settings.maxRecentRepos);
  const isCompact = useIsCompact();
  const [text, setText] = useState("");
  const [ws, setWs] = useState("");
  const [pickerOpen, setPickerOpen] = useState(false);
  const [searchText, setSearchText] = useState("");
  // Mobile only: the search bar is collapsed behind a header icon so the transcript gets that row back
  // (the "so much up top" complaint). Desktop CSS keeps it always visible regardless of this flag.
  const [searchOpen, setSearchOpen] = useState(false);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const directorSearch = useStore((s) => s.directorSearch);
  const searchDirector = useStore((s) => s.searchDirector);
  const clearDirectorSearch = useStore((s) => s.clearDirectorSearch);
  const setDirectorWidth = useStore((s) => s.setDirectorWidth);
  const selectedThreadId = useStore((s) => s.selectedThreadId);
  const select = useStore((s) => s.select);
  const att = useAttachments();

  // Jump from a search hit to the task its conversation turn dispatched: open the task, then clear the
  // search so the rail returns to the transcript (the task's detail panel is now open on the right).
  // Best-effort scroll the task's board lane into view too, so the jump is anchored — a no-op if that
  // lane isn't currently rendered (paginated/filtered off the board).
  const goToTask = (threadId: string) => {
    select(threadId);
    setSearchText("");
    requestAnimationFrame(() => {
      document.querySelector(`[data-thread-id="${threadId}"]`)?.scrollIntoView({ block: "nearest", behavior: "smooth" });
    });
  };

  // Debounce the query so a live search doesn't hit the server on every keystroke; an empty box clears
  // the results (and hands the transcript back). The store drops any reply whose query has since changed.
  useEffect(() => {
    const q = searchText.trim();
    if (!q) {
      clearDirectorSearch();
      return;
    }
    const t = setTimeout(() => searchDirector(q), 200);
    return () => clearTimeout(t);
  }, [searchText, searchDirector, clearDirectorSearch]);

  // Selecting a task pre-fills the repo path from that task's workspace. Keyed on the id
  // alone so manual edits and same-task re-selects never re-fire — only a different task wins.
  useEffect(() => {
    if (!selectedThreadId) return;
    const t = useStore.getState().threads[selectedThreadId];
    if (t?.workspace) setWs(t.workspace);
  }, [selectedThreadId]);
  const scrollRef = useRef<HTMLDivElement>(null);
  const lastSentRef = useRef(""); // last sent prompt, recalled with ↑ when the field is empty

  // Drag the rail's right edge to resize, mirroring the detail panel. Persisted via the store.
  // 760 is the rail's own ceiling; everything about how it shares the row with the board and the
  // detail lives in `columnDragMax`, which the detail's handle uses too so the two cannot drift.
  const startResize = useColumnResize(
    useCallback(
      (clientX: number) => {
        const { selectedThreadId, detailWidth } = useStore.getState();
        const max = Math.min(760, columnDragMax(selectedThreadId ? detailWidth : null));
        setDirectorWidth(Math.min(Math.max(clientX, 280), Math.max(280, max)));
      },
      [setDirectorWidth],
    ),
  );

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [items.length, draft]);

  // The rail is `display:none` on mobile while the board pane is up, so the autoscroll effect above
  // fires against a zero-height container and lands nowhere — switch to the director pane and the long
  // transcript sits at the top. Re-pin to the newest message the moment the container regains height
  // (the pane becomes visible), matching desktop where the rail is never hidden. Fires only on the
  // hidden→visible transition so it never fights a user who has scrolled up mid-conversation.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    let wasVisible = el.clientHeight > 0;
    const ro = new ResizeObserver(() => {
      const visible = el.clientHeight > 0;
      if (visible && !wasVisible) el.scrollTo({ top: el.scrollHeight });
      wasVisible = visible;
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const directNeedsWs = skip && !ws.trim();

  // Promote a just-dispatched repo to the front (deduped, capped) and persist server-side; remove drops
  // one chip. Both send the whole new list — setSettings is optimistic and the server re-caps/dedupes.
  const pushRepo = (path: string) => {
    const p = path.trim();
    if (!p) return;
    setSettings({ recentRepos: [p, ...recentRepos.filter((x) => x !== p)].slice(0, maxRecentRepos) });
  };
  const removeRepo = (path: string) => setSettings({ recentRepos: recentRepos.filter((x) => x !== path) });

  const submit = () => {
    const t = text.trim();
    if (!t || directNeedsWs) return;
    lastSentRef.current = t;
    const w = ws.trim();
    if (w) pushRepo(w);
    if (skip) sendDirect(t, w || undefined, att.images);
    else sendPrompt(t, w || undefined, att.images);
    setText("");
    att.clear();
  };

  return (
    <>
    <aside className="rail">
      <div className="resize-handle rail-resize" onPointerDown={startResize} title="Drag to resize the director panel" />
      <div className="rail-head">
        <div className="rail-head-row">
          <div className="who">
            <span className="pip active" style={{ "--role": "var(--role-director)" } as CSSProperties}>
              <Gnome role="director" size={28} />
            </span>
            <div className="rail-head-title">
              <h2>{directorName}</h2>
              <span className="dim mono" style={{ fontSize: 11 }}>
                {directorRuntimeLabel(directorStatus, busy)}
              </span>
            </div>
          </div>
          <div className="rail-head-actions">
            {/* Only offered while the director is thinking: a hard stop for a turn that's spinning —
                busy but neither streaming a reply nor dispatching. Cancels the turn and settles to
                idle; the conversation is preserved so the next message resumes with full context. */}
            {busy && (
              <button
                type="button"
                className="btn danger sm director-stop"
                aria-label="Stop the director"
                title="Stop the director — cancels the current turn if it's stuck looping without replying or dispatching"
                onClick={cancelDirector}
              >
                <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                  <rect x="5" y="5" width="14" height="14" rx="2" />
                </svg>
                Stop
              </button>
            )}
            <AgentToggles />
            {/* Mobile-only search affordance — collapses the full-width search row into one tap. */}
            <button
              type="button"
              className={"rail-search-toggle" + (searchOpen || searchText ? " on" : "")}
              aria-label={searchOpen ? "Hide search" : "Search tasks and the director conversation"}
              aria-expanded={searchOpen || !!searchText}
              title="Search tasks and the director conversation"
              onClick={() => {
                setSearchOpen((o) => {
                  const next = !o;
                  if (next) requestAnimationFrame(() => searchInputRef.current?.focus());
                  return next;
                });
              }}
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <circle cx="11" cy="11" r="7" />
                <path d="m20 20-3.2-3.2" />
              </svg>
            </button>
          </div>
        </div>
      </div>

      <div className={"rail-search" + (searchOpen || searchText ? " open" : "")}>
        <svg className="rail-search-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <circle cx="11" cy="11" r="7" />
          <path d="m20 20-3.2-3.2" />
        </svg>
        <input
          ref={searchInputRef}
          className="rail-search-input"
          type="search"
          value={searchText}
          placeholder="Search tasks and the director conversation…"
          aria-label="Search tasks and the director conversation"
          onChange={(e) => setSearchText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              setSearchText("");
              setSearchOpen(false);
            }
          }}
        />
        {searchText && (
          <button className="rail-search-clear" type="button" aria-label="Clear search" title="Clear search" onClick={() => { setSearchText(""); searchInputRef.current?.focus(); }}>
            ×
          </button>
        )}
      </div>

      {directorSearch ? (
        <DirectorSearchResults search={directorSearch} directorName={directorName} onGoToTask={goToTask} />
      ) : (
        <div className="transcript" ref={scrollRef}>
          {items.length === 0 && (
            <div className="faint" style={{ fontSize: 13 }}>
              Tell the Director what you want. It pulls your memories, asks anything it needs to avoid steering wrong, then
              dispatches the smallest capable route for the task.
            </div>
          )}
          {items.map((it) => (
            <DirectorBubble key={it.id} item={it} />
          ))}
          {draft && (
            <div className="msg director draft">
              <div className="by">{directorName}</div>
              <div className="bubble">{draft}</div>
            </div>
          )}
        </div>
      )}

      <div className={"composer" + (att.dragging ? " dragging" : "") + (skip ? " direct" : "")} {...att.dropHandlers}>
        {recentRepos.length > 1 &&
          (isCompact ? (
            <RecentReposSelect
              repos={recentRepos.slice(0, maxRecentRepos)}
              active={ws.trim()}
              onPick={setWs}
              onRemove={removeRepo}
            />
          ) : (
            <div className="recent-repos" role="group" aria-label="Recent repositories">
              <span className="recent-repos-label mono">repos</span>
              {recentRepos.slice(0, maxRecentRepos).map((p) => {
                const active = p === ws.trim();
                return (
                  <span key={p} className={"repo-chip" + (active ? " on" : "")} title={p}>
                    <button
                      type="button"
                      className="repo-chip-pick"
                      aria-pressed={active}
                      onClick={() => setWs(p)}
                    >
                      {repoLabel(p)}
                    </button>
                    <button
                      type="button"
                      className="repo-chip-x"
                      aria-label={`Remove ${p} from recent repos`}
                      title="Remove from recents"
                      onClick={() => removeRepo(p)}
                    >
                      ×
                    </button>
                  </span>
                );
              })}
            </div>
          ))}
        <div className="composer-mode">
          <button
            type="button"
            className={"mode-toggle" + (skip ? " on" : "")}
            role="switch"
            aria-checked={skip}
            title={
              skip
                ? 'Skip-director ON — your message bypasses the director and dispatches straight to the task-aware pipeline. The task history shows the selected route. Click to send via the director.'
                : "Skip-director OFF — your message goes to the director, which enriches and dispatches. Click to send straight to the pipeline."
            }
            onClick={() => setSettings({ skipDirector: !skip })}
          >
            <span className="mode-dot" aria-hidden="true" />
            Skip director
          </button>
          {skip && (
            <span className="mode-hint mono" title="The server selects the smallest capable route after dispatch.">
              direct → routed
            </span>
          )}
        </div>
        <ComposerTaskMode />
        {showPickers && <ComposerImplementorModelPickers />}
        {showPickers && skip && <ComposerEffortPickers />}
        <textarea
          value={text}
          placeholder={
            skip
              ? "Direct to task-aware route — set the repo path below.  (⌘/Ctrl+Enter to send)"
              : "Describe a task…  (paste or drop images · ⌘/Ctrl+Enter to send)"
          }
          onChange={(e) => setText(e.target.value)}
          onPaste={att.onPaste}
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
              e.preventDefault();
              submit();
            } else if (e.key === "ArrowUp" && !text && lastSentRef.current) {
              e.preventDefault();
              setText(lastSentRef.current);
            }
          }}
        />
        <ComposerThumbs images={att.images} onRemove={att.remove} />
        <div className="row">
          <MicToggle />
          <AttachButton onPick={att.addFiles} />
          <PathInput
            className="ws"
            value={ws}
            onChange={setWs}
            placeholder="exact repo path (optional — used as-is)  e.g. /Users/you/project"
            title="If set, this exact path is the dispatch workspace — the director uses it verbatim instead of resolving a path itself. Leave blank to let the director find the repo from your description."
          />
          <button
            className="btn ghost sm attach-btn"
            type="button"
            title="Browse for a folder"
            aria-label="Browse for a folder"
            onClick={() => setPickerOpen(true)}
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" />
            </svg>
          </button>
          <button
            className="btn primary"
            onClick={submit}
            disabled={!text.trim() || directNeedsWs}
            title={directNeedsWs ? "Skip-director needs a repo path — there's no director to resolve one." : undefined}
          >
            Send
          </button>
        </div>
      </div>
    </aside>
    {pickerOpen && (
      <FolderPicker initialPath={ws} onSelect={setWs} onClose={() => setPickerOpen(false)} />
    )}
    </>
  );
}


/** The two task-MODE picks: a wall-clock work window, and how many agents work the objective at once.
 *
 *  Both are off by default and both are expensive when on — an 8h window keeps an implementor working
 *  all day; 3 agents spend three subscriptions at once. So the row is deliberately loud when active (a
 *  lit chip stating the actual choice) and almost invisible when not: a forgotten setting here costs
 *  real quota, and the app already persists composer picks server-side, so "I set that yesterday" is a
 *  real failure mode rather than a hypothetical one.
 *
 *  They apply to the task the next send produces — through the director or straight past it. */
function ComposerTaskMode() {
  const minutes = useStore((s) => s.settings.taskDurationMinutes);
  const agents = useStore((s) => s.settings.taskAgentCount);
  const setSettings = useStore((s) => s.setSettings);
  const active = minutes > 0 || agents > 1;

  return (
    <div className={"composer-taskmode" + (active ? " on" : "")} aria-label="Task mode">
      <label className="taskmode-field">
        <span className="taskmode-label mono">for</span>
        <select
          className={"taskmode-select" + (minutes > 0 ? " lit" : "")}
          value={String(minutes)}
          aria-label="Work window"
          title={
            minutes > 0
              ? `Timed task: the implementor keeps finding useful work on this objective for ${DURATIONS.find((d) => d.min === minutes)?.label ?? minutes + "m"}, then hands off to review. It stops early if it genuinely finishes.`
              : "Timed task — give this one task a wall-clock work window (it keeps working the same objective until the window closes, then goes to review). Off = an ordinary task."
          }
          onChange={(e) => setSettings({ taskDurationMinutes: Number(e.target.value) })}
        >
          {DURATIONS.map((d) => (
            <option key={d.min} value={d.min}>
              {d.label}
            </option>
          ))}
        </select>
      </label>
      <label className="taskmode-field">
        <span className="taskmode-label mono">with</span>
        <select
          className={"taskmode-select" + (agents > 1 ? " lit" : "")}
          value={String(agents)}
          aria-label="Agents"
          title={
            agents > 1
              ? `Shotgun task: ${agents} agents work this objective at once, each owning separate files, then one agent reconciles their work and QA reviews the result. If it can't be split safely it quietly runs as a single agent.`
              : "Shotgun task — run several agents on this one objective at the same time, each owning separate files. Off = a single agent."
          }
          onChange={(e) => setSettings({ taskAgentCount: Number(e.target.value) })}
        >
          {AGENT_COUNTS.map((n) => (
            <option key={n} value={n}>
              {n === 1 ? "1 agent" : `${n} agents`}
            </option>
          ))}
        </select>
      </label>
      {active ? (
        <button
          type="button"
          className="taskmode-clear"
          title="Back to an ordinary task"
          aria-label="Clear task mode"
          onClick={() => setSettings({ taskDurationMinutes: 0, taskAgentCount: 1 })}
        >
          ×
        </button>
      ) : null}
    </div>
  );
}

/** The window presets. Minutes, matching the server's `taskDurationMinutes`. Deliberately a short list
 *  of real working spans rather than a free-text field — the durations people actually ask for are a
 *  handful, and a typo in a free field ("80" meaning 8h) is an expensive mistake to make silently. */
const DURATIONS: { min: number; label: string }[] = [
  { min: 0, label: "no time limit" },
  { min: 30, label: "30 min" },
  { min: 60, label: "1 hour" },
  { min: 120, label: "2 hours" },
  { min: 240, label: "4 hours" },
  { min: 480, label: "8 hours" },
  { min: 720, label: "12 hours" },
  { min: 1440, label: "24 hours" },
];

/** Mirrors MIN_AGENTS/MAX_AGENTS on the server (orchestrator/shotgun.ts); the server clamps anyway. */
const AGENT_COUNTS = [1, 2, 3, 4, 5, 6];

/** Mobile substitute for the wrapping recent-repo chips: a single dropdown row. The chips flex-wrap into
 *  several rows on a phone (a long list ate most of the composer's vertical space, pushing the transcript
 *  off-screen), so on mobile the same list collapses to a native `<select>` plus a remove button that
 *  drops whichever repo is currently selected. Picking an entry fills the workspace path exactly like a
 *  chip does. */
function RecentReposSelect({
  repos,
  active,
  onPick,
  onRemove,
}: {
  repos: string[];
  active: string;
  onPick: (p: string) => void;
  onRemove: (p: string) => void;
}) {
  const selected = repos.includes(active) ? active : "";
  return (
    <div className="recent-repos-select" role="group" aria-label="Recent repositories">
      <span className="recent-repos-label mono">repos</span>
      <select
        className="repo-select"
        value={selected}
        aria-label="Pick a recent repository"
        onChange={(e) => {
          if (e.target.value) onPick(e.target.value);
        }}
      >
        <option value="">Recent repos…</option>
        {repos.map((p) => (
          <option key={p} value={p}>
            {repoLabel(p)}
          </option>
        ))}
      </select>
      <button
        type="button"
        className="repo-select-x"
        disabled={!selected}
        aria-label={selected ? `Remove ${selected} from recent repos` : "Remove selected repo from recents"}
        title="Remove the selected repo from recents"
        onClick={() => selected && onRemove(selected)}
      >
        ×
      </button>
    </div>
  );
}

/** Compact shortcuts for the implementor backends. Claude writes the global implementor default that
 *  subscriptions inherit unless overridden; Codex writes codex.implementor for OpenAI failover/routing.
 *  The Codex picker only exists while Codex is enabled — the server hard-gates routing on that toggle,
 *  so on a Claude-only deployment the control would configure a backend that can never run. */
function ComposerImplementorModelPickers() {
  const settings = useStore((s) => s.settings);
  const { overrides, setModel } = useModelOverrides();
  const claudeValue = overrides[DEFAULT_SUB_ID]?.implementor ?? "";
  const codexValue = overrides[CODEX_SUB_ID]?.implementor ?? settings.codexModel;
  const defaultLabel = `Built-in (${settings.modelDefaults.implementor ?? "n/a"})`;

  return (
    <div className="composer-model-row" aria-label="Implementor models">
      <ComposerModelField
        label="Claude"
        provider="Anthropic"
        value={claudeValue}
        options={settings.claudeModels}
        allowInherit
        defaultLabel={defaultLabel}
        ariaLabel="Claude implementor model"
        title="Pick the default Claude model used by future implementor runs."
        onChange={(model) => setModel(DEFAULT_SUB_ID, "implementor", model)}
      />
      {settings.codexEnabled && (
        <ComposerModelField
          label="Codex"
          provider="OpenAI"
          value={codexValue}
          options={codexModelOptions(settings.codexModels)}
          allowInherit={false}
          ariaLabel="Codex implementor model"
          title="Pick the Codex model used when Codex implements or Claude fails over to Codex."
          onChange={(model) => setModel(CODEX_SUB_ID, "implementor", model)}
        />
      )}
    </div>
  );
}

/** Effort dropdowns, shown only in skip-director mode — with no director in the loop the owner picks how
 *  hard the implementor works. The Claude pick is snapshotted onto each direct dispatch and beats the
 *  planner's per-task choice ("Auto" leaves the planner — or the high default — in charge); the Codex pick
 *  binds the same global reasoning effort as Settings → Subscriptions, applied to every Codex run.
 *  Like the model picker, the Codex select is omitted while Codex is disabled. */
function ComposerEffortPickers() {
  const effort = useStore((s) => s.settings.skipDirectorEffort);
  const codexEffort = useStore((s) => s.settings.codexEffort);
  const codexEnabled = useStore((s) => s.settings.codexEnabled);
  const codexModel = useStore((s) => s.settings.codexModel);
  const codexModelEfforts = useStore((s) => s.settings.codexModelEfforts);
  const xhighEnabled = useStore((s) => s.settings.xhighEnabled);
  const plannerEnabled = useStore((s) => s.settings.plannerEnabled);
  const setSettings = useStore((s) => s.setSettings);
  const claudeTiers = CLAUDE_EFFORTS.filter((t) => t !== "xhigh" || xhighEnabled);
  const claudeTitle = `How hard the Claude implementor works on tasks dispatched directly. Auto = ${
    plannerEnabled ? "the planner's per-task pick when planning runs; otherwise the built-in default (high)" : "the built-in default (high) — the planner is off"
  }; a concrete tier overrides it.`;
  const codexTiers = codexModelEfforts[codexModel] ?? codexEffortsForModel(codexModel);
  const codexTitle = codexTiers.includes("ultra")
    ? "Codex CLI effort cap. Ultra adds automatic delegation for this model; the cap applies to every Codex run."
    : codexTiers.includes("max")
      ? "Codex CLI reasoning effort cap. This model supports Max."
    : "Codex CLI reasoning effort (model_reasoning_effort). This model supports up to Extra High; pick GPT-5.6 to enable Max.";

  return (
    <div className="composer-model-row" aria-label="Implementor effort">
      <div className="composer-model" title={claudeTitle}>
        <div className="composer-model-meta">
          <span className="composer-model-label mono">Effort</span>
          <span className="composer-model-provider">Claude</span>
        </div>
        <select
          className={"model-select" + (effort === "auto" ? " inherited" : "")}
          value={effort}
          aria-label="Claude implementor effort"
          title={claudeTitle}
          onChange={(e) => setSettings({ skipDirectorEffort: e.target.value as Effort | "auto" })}
        >
          <option value="auto">{plannerEnabled ? "Auto (route decides)" : "Auto (high)"}</option>
          {claudeTiers.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
      </div>
      {codexEnabled && (
        <div className="composer-model" title={codexTitle}>
          <div className="composer-model-meta">
            <span className="composer-model-label mono">Effort</span>
            <span className="composer-model-provider">Codex</span>
          </div>
          <select
            className="model-select"
            value={codexEffort}
            aria-label="Codex reasoning effort"
            title={codexTitle}
            onChange={(e) => setSettings({ codexEffort: e.target.value as CodexEffort })}
          >
            {codexTiers.map((t) => (
              <option key={t} value={t}>
                {effortLabel(t)}
              </option>
            ))}
          </select>
        </div>
      )}
    </div>
  );
}

function ComposerModelField({
  label,
  provider,
  value,
  options,
  onChange,
  allowInherit = true,
  defaultLabel,
  ariaLabel,
  title,
}: {
  label: string;
  provider: string;
  value: string;
  options: readonly string[];
  onChange: (model: string) => void;
  allowInherit?: boolean;
  defaultLabel?: string;
  ariaLabel: string;
  title: string;
}) {
  return (
    <div className="composer-model" title={title}>
      <div className="composer-model-meta">
        <span className="composer-model-label mono">{label}</span>
        <span className="composer-model-provider">{provider}</span>
      </div>
      <ModelSelect
        value={value}
        options={options}
        allowInherit={allowInherit}
        defaultLabel={defaultLabel}
        ariaLabel={ariaLabel}
        title={title}
        onChange={onChange}
      />
    </div>
  );
}

interface VoiceStatus {
  up: boolean;
  wake?: { enabled: boolean; conversing?: boolean; capturing?: boolean; buffer?: string; phrase?: string };
}

/** Hands-free voice mode toggle, bridged to the desk's voice-gateway (:3960) via this server.
 *  ON = the desk mic listens for the wake phrase; saying it opens a spoken CONVERSATION with the
 *  director — a pause sends what was said, her spoken reply keeps it open, "that's all" (or
 *  silence) ends it. The gateway not running renders as a dimmed, disabled mic. Polled state
 *  (3.5s) — conversation flashes are fine to arrive a beat late. */
function MicToggle() {
  const [voice, setVoice] = useState<VoiceStatus | null>(null);
  const [flipping, setFlipping] = useState(false);

  useEffect(() => {
    let live = true;
    const tick = async () => {
      try {
        const r = await fetch(apiUrl("/api/voice/status"), { cache: "no-store" });
        const j = (await r.json()) as VoiceStatus;
        if (live) setVoice(j);
      } catch {
        if (live) setVoice({ up: false });
      }
    };
    void tick();
    const t = setInterval(tick, 3500);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, []);

  const up = !!voice?.up;
  const on = up && !!voice?.wake?.enabled;
  const conversing = on && !!voice?.wake?.conversing;
  const phrase = voice?.wake?.phrase || "hey claude";

  const toggle = async () => {
    if (!up || flipping) return;
    setFlipping(true);
    try {
      await fetch(apiUrl("/api/voice/wake"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ on: !on }),
      });
      setVoice((v) => (v ? { ...v, wake: { ...v.wake, enabled: !on, conversing: false, capturing: false, buffer: "" } } : v));
    } catch {
      /* next poll shows the truth */
    } finally {
      setFlipping(false);
    }
  };

  const heard = voice?.wake?.buffer;
  const title = !up
    ? "Voice mode unavailable — the voice-gateway isn't running (start it in Script Hub, or use PTT there)."
    : conversing
      ? `In conversation${heard ? ` — heard: “${heard}”` : ""} — just talk; a pause sends it. “Cancel that” discards, “That's all” ends the conversation. Click to turn voice mode off.`
      : on
        ? `Voice mode ON — say “${phrase}” and just talk with the director: a pause sends, replies keep the conversation going, “That's all” ends it. Click to turn off. (Desk mic)`
        : `Voice mode — click, then say “${phrase}” to open a hands-free conversation with the director from the desk mic.`;

  return (
    <button
      type="button"
      className={"btn ghost sm mic-toggle" + (on ? " on" : "") + (conversing ? " capturing" : "") + (up ? "" : " offline")}
      role="switch"
      aria-checked={on}
      aria-label="Voice mode"
      disabled={!up}
      title={title}
      onClick={toggle}
    >
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z" />
        <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
        <line x1="12" x2="12" y1="19" y2="22" />
      </svg>
      <span className="mic-dot" aria-hidden="true" />
    </button>
  );
}

/** The per-task pipeline gates, in the Director header where tasks are composed/dispatched. ON makes a
 *  stage AVAILABLE — not mandatory: the server still picks the smallest route a given task actually
 *  needs (implementor-only for a narrow, low-risk change; QA without planning for contained explicit
 *  verification; planning + QA for anything broader or riskier),
 *  and explains that pick in the task's own history. OFF is the only true "never" — it removes the stage
 *  from every task regardless of what routing would have picked. Flip OFF before sending to hard-disable
 *  a stage for the next task; leave ON (the default) and trust the per-task routing otherwise. */
function AgentToggles() {
  const settings = useStore((s) => s.settings);
  const setSettings = useStore((s) => s.setSettings);
  const toggle = (key: keyof OrchestratorSettings, on: boolean) =>
    setSettings({ [key]: !on } as Partial<OrchestratorSettings>);

  const items: { key: keyof OrchestratorSettings; role: Role; label: string; onTitle: string; offTitle: string }[] = [
    {
      key: "plannerEnabled",
      role: "planner",
      label: "Plan",
      onTitle: "Planner AVAILABLE — the pipeline runs it only for tasks that benefit (see the task's own \"Route selected\" note). Click to disable it entirely, for every task.",
      offTitle: "Planner DISABLED — never runs, even for a task that would benefit. Click to make it available again (routing still decides per task).",
    },
    {
      key: "researcherEnabled",
      role: "researcher",
      label: "Research",
      onTitle: "Researcher ON — click to never run the research step",
      offTitle: "Researcher OFF — the research step is skipped even if the planner asks for it. Click to re-enable.",
    },
    {
      key: "qaEnabled",
      role: "qa",
      label: "QA",
      onTitle: "QA AVAILABLE — the pipeline runs it only for tasks that benefit (see the task's own \"Route selected\" note). Click to disable it entirely, for every task.",
      offTitle: "QA DISABLED — never runs, even for a task that would benefit. Click to make it available again (routing still decides per task).",
    },
  ];

  return (
    <div className="agent-toggles" role="group" aria-label="Pipeline agents">
      {items.map((it) => {
        const on = !!settings[it.key];
        return (
          <button
            key={it.key}
            className={"agent-toggle" + (on ? " on" : " off")}
            style={{ "--role": `var(--role-${it.role})` } as CSSProperties}
            aria-pressed={on}
            title={on ? it.onTitle : it.offTitle}
            onClick={() => toggle(it.key, on)}
          >
            <span className="agent-dot" aria-hidden="true" />
            {it.label}
          </button>
        );
      })}
    </div>
  );
}

// Memoized so a keystroke in the composer (or a streaming `draft` delta), both of which re-render the
// Director, doesn't re-render the whole transcript. `item` references are stable in the store, so a
// bubble only re-renders when its own message changes. Mirrors `FeedRow` in ThreadDetail.tsx.
const DirectorBubble = memo(function DirectorBubble({ item }: { item: DirectorItem }) {
  const directorName = useStore((s) => s.settings.directorName);
  if (item.kind === "tool") {
    return (
      <div className="tool-chip" title={item.toolName + (item.text ? ` · ${item.text}` : "")}>
        <span className="k">{item.toolName}</span>
        {item.text ? <span className="arg">· {item.text}</span> : null}
      </div>
    );
  }
  return (
    <div className={"msg " + item.kind}>
      <div className="by">{item.kind === "user" ? "you" : directorName}</div>
      <div className="bubble">
        {item.kind === "user" ? item.text : <Markdown text={item.text} />}
        <MessageThumbs refs={item.attachments} />
      </div>
    </div>
  );
});

/** Search results, shown in place of the transcript while a query is active. Two sections: the tasks
 *  that match — first, because "which task was I doing X in?" is the question that brings anyone here —
 *  then the director conversation. Each hit renders a snippet centered on the match, so a long reply or
 *  a screenful of tool output stays readable but the match is seen. */
function DirectorSearchResults({
  search,
  directorName,
  onGoToTask,
}: {
  search: { query: string; results: DirectorMessage[]; tasks: TaskSearchHit[]; searching: boolean };
  directorName: string;
  onGoToTask: (threadId: string) => void;
}) {
  const { query, results, tasks, searching } = search;
  const threads = useStore((s) => s.threads);
  const count = results.length;
  const empty = count === 0 && tasks.length === 0;
  // Mirrors Db.conversationPlan: a query shorter than a trigram can't be indexed and matches nearly
  // every task anyway, so the server searches titles and briefs only. Say that rather than quietly
  // returning less — the whole point of searching conversations is that people rely on it.
  const titlesOnly = [...query].length < CONVERSATION_MIN_CHARS;
  return (
    <div className="ds-results" role="region" aria-label="Search results">
      <div className="ds-status mono">
        {searching && empty ? "Searching…" : `${resultTally(tasks.length, count)} for “${query}”`}
      </div>
      {titlesOnly && (
        <div className="ds-scope-note faint">
          Titles and briefs only — type {CONVERSATION_MIN_CHARS - [...query].length} more character
          {CONVERSATION_MIN_CHARS - [...query].length === 1 ? "" : "s"} to search inside conversations.
        </div>
      )}
      {!searching && empty && (
        <div className="faint" style={{ fontSize: 13 }}>
          {titlesOnly
            ? `Nothing in the director conversation, and no task’s title or brief, contains “${query}”.`
            : `Nothing in the director conversation, and no task’s title, brief or conversation, contains “${query}”.`}
        </div>
      )}
      {tasks.length > 0 && (
        <>
          <div className="ds-section mono">Tasks</div>
          {tasks.map((t) => (
            <TaskHit key={t.threadId} hit={t} query={query} onGoToTask={onGoToTask} />
          ))}
        </>
      )}
      {count > 0 && tasks.length > 0 && <div className="ds-section mono">Director conversation</div>}
      {results.map((m) => {
        const task = m.threadId ? threads[m.threadId] : undefined;
        return (
          <div key={m.id} className={"ds-result " + m.role}>
            <div className="ds-meta">
              <span className="ds-role">{m.role === "user" ? "you" : directorName}</span>
              <span className="ds-date">{resultDate(m.createdAt)}</span>
            </div>
            <div className="ds-snippet">{highlightSnippet(m.content, query)}</div>
            {task ? (
              <button type="button" className="ds-goto" title={`Open task “${task.title}”`} onClick={() => onGoToTask(m.threadId!)}>
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M7 17 17 7" />
                  <path d="M8 7h9v9" />
                </svg>
                <span className="ds-goto-title">{task.title}</span>
              </button>
            ) : m.threadId ? (
              <span className="ds-goto-gone">task no longer exists</span>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

/** One matching task: click it to open the task, with the evidence for why it matched underneath. The
 *  snippet arrives pre-windowed from the server — the message behind it is routinely megabytes. */
function TaskHit({
  hit,
  query,
  onGoToTask,
}: {
  hit: TaskSearchHit;
  query: string;
  onGoToTask: (threadId: string) => void;
}) {
  return (
    <button
      type="button"
      className="ds-task"
      title={`Open task “${hit.title}”`}
      onClick={() => onGoToTask(hit.threadId)}
    >
      {/* Spans, not divs: flow content inside a <button> is invalid HTML, and the card is a flex
          column either way. */}
      <span className="ds-meta">
        <span className="ds-task-state">
          <span className="ds-task-pip" style={{ background: stateColor(hit.state) }} />
          {stateLabel(hit.state)}
        </span>
        <span className="ds-date">{resultDate(hit.createdAt)}</span>
      </span>
      <span className="ds-task-title">{highlightAll(hit.title, query)}</span>
      {hit.snippet && <span className="ds-snippet">{highlightAll(hit.snippet, query)}</span>}
      <span className="ds-task-foot mono">
        <span className="ds-task-where">{matchLabel(hit)}</span>
        {hit.workspace && (
          <span className="ds-task-repo" title={hit.workspace}>
            {repoLabel(hit.workspace)}
          </span>
        )}
      </span>
    </button>
  );
}

/** Shortest query the server will search conversations for — the trigram index's window, mirrored
 *  from `TRIGRAM_LEN` in server/src/db/searchIndex.ts. */
const CONVERSATION_MIN_CHARS = 3;

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? "" : "s"}`;

function resultTally(tasks: number, messages: number): string {
  const parts: string[] = [];
  if (tasks) parts.push(plural(tasks, "task"));
  if (messages) parts.push(plural(messages, "director message"));
  return parts.length ? parts.join(" · ") : "No matches";
}

/** Why this task matched, in the owner's terms. The conversation count is kept even when the brief or
 *  title also matched: it's what tells the task that did the work apart from one that name-dropped it. */
function matchLabel(hit: TaskSearchHit): string {
  const conversation = hit.messageHits ? `${plural(hit.messageHits, "message")} in the conversation` : "";
  if (hit.where === "conversation") return conversation;
  const site = hit.where === "brief" ? "in the brief" : "in the title";
  return conversation ? `${site} · ${conversation}` : site;
}

const resultDate = (ts: number): string =>
  new Date(ts).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });

// Wrap every case-insensitive match of `q` in <mark>. For text that is already the right length — a
// task title, or a snippet the server has windowed for us.
function highlightAll(text: string, q: string): ReactNode[] {
  const needle = q.toLowerCase();
  const lc = text.toLowerCase();
  const nodes: ReactNode[] = [];
  let i = 0;
  while (i < text.length) {
    const idx = needle ? lc.indexOf(needle, i) : -1;
    if (idx < 0) {
      nodes.push(text.slice(i));
      break;
    }
    if (idx > i) nodes.push(text.slice(i, idx));
    nodes.push(
      <mark key={idx} className="ds-hit">
        {text.slice(idx, idx + needle.length)}
      </mark>,
    );
    i = idx + needle.length;
  }
  return nodes;
}

// Build a snippet centered on the first case-insensitive match of `q`, with every match inside the
// window highlighted. A window (not the full body) keeps long director replies from dominating the list.
function highlightSnippet(text: string, q: string): ReactNode {
  const first = text.toLowerCase().indexOf(q.toLowerCase());
  const anchor = first < 0 ? 0 : first;
  const WINDOW_BEFORE = 90;
  const WINDOW_AFTER = 240;
  const start = anchor > WINDOW_BEFORE ? anchor - WINDOW_BEFORE : 0;
  const end = Math.min(text.length, anchor + q.length + WINDOW_AFTER);
  return (
    <>
      {start > 0 && "…"}
      {highlightAll(text.slice(start, end), q)}
      {end < text.length && "…"}
    </>
  );
}
