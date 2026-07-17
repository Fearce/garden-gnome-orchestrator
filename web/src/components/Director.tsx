import { useEffect, useRef, useState, type CSSProperties, type MouseEvent as ReactMouseEvent, type ReactNode } from "react";
import { useStore } from "../store.js";
import { apiUrl } from "../lib/base.js";
import { AttachButton, ComposerThumbs, MessageThumbs, useAttachments } from "../lib/attachments.js";
import { FolderPicker } from "./FolderPicker.js";
import { PathInput } from "./PathInput.js";
import { Gnome } from "./Gnome.js";
import { Markdown } from "./Markdown.js";
import { CODEX_EFFORTS, CODEX_SUB_ID, DEFAULT_SUB_ID, EFFORTS, type CodexEffort, type DirectorItem, type DirectorMessage, type Effort, type OrchestratorSettings, type Role } from "../types.js";
import { codexModelOptions } from "../lib/models.js";
import { modelLabel } from "../lib/format.js";
import { ModelSelect, useModelOverrides } from "./ModelSelect.js";

// The recent-repo chips and the skip-director mode are persisted SERVER-SIDE (in OrchestratorSettings),
// not localStorage — the console is served on both an HTTP and an HTTPS origin (the tablet Deck iframes
// the HTTPS port) and those origins don't share localStorage, so a client-only store wouldn't carry
// across surfaces. The list is capped at settings.maxRecentRepos. Trailing-separator-tolerant basename,
// cross-platform (handles / and \ paths):
const repoLabel = (p: string): string => p.replace(/[/\\]+$/, "").split(/[/\\]/).pop() || p;

export function Director() {
  const items = useStore((s) => s.director);
  const draft = useStore((s) => s.directorDraft);
  const busy = useStore((s) => s.directorBusy);
  const sendPrompt = useStore((s) => s.sendPrompt);
  const sendDirect = useStore((s) => s.sendDirect);
  const plannerEnabled = useStore((s) => s.settings.plannerEnabled);
  const directorName = useStore((s) => s.settings.directorName);
  // The director's model, resolved like the server's modelFor: the operator's default-layer override
  // (Settings → Agent models), else the built-in default. Per-sub overrides aren't resolvable here —
  // the console doesn't know which subscription the director run landed on.
  const directorModel = useStore(
    (s) => s.settings.modelOverrides?.[DEFAULT_SUB_ID]?.director?.trim() || s.settings.modelDefaults.director || "",
  );
  const setSettings = useStore((s) => s.setSettings);
  // Skip-director mode + the recent-repo list live in the server-persisted settings so they survive a
  // reload on ANY surface (see the repoLabel note above). setSettings is optimistic, so toggling/adding
  // reflects instantly and the server broadcast reconciles every connected client.
  const skip = useStore((s) => s.settings.skipDirector);
  const showModelPicker = useStore((s) => s.settings.showComposerModelPicker);
  const recentRepos = useStore((s) => s.settings.recentRepos);
  const maxRecentRepos = useStore((s) => s.settings.maxRecentRepos);
  const [text, setText] = useState("");
  const [ws, setWs] = useState("");
  const [pickerOpen, setPickerOpen] = useState(false);
  const [searchText, setSearchText] = useState("");
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

  // Drag the rail's right edge to resize, mirroring the detail panel. Width is clamped so the
  // board (and an open detail panel) always keep room; persisted via the store.
  const startResize = (e: ReactMouseEvent) => {
    e.preventDefault();
    const onMove = (ev: MouseEvent) => {
      const { selectedThreadId, detailWidth } = useStore.getState();
      const reserved = 320 + (selectedThreadId ? detailWidth : 0) + 16;
      const max = Math.min(760, window.innerWidth - reserved);
      setDirectorWidth(Math.min(Math.max(ev.clientX, 280), Math.max(280, max)));
    };
    const onUp = () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      document.body.classList.remove("col-resizing");
    };
    document.body.classList.add("col-resizing");
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  };

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [items.length, draft]);

  // In skip mode the message enters the pipeline at its first active stage — planner if it's on,
  // otherwise the implementor (the researcher only ever runs after the planner, never first).
  const firstStage = plannerEnabled ? "planner" : "implementor";
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
      <div className="resize-handle rail-resize" onMouseDown={startResize} title="Drag to resize the director panel" />
      <div className="rail-head">
        <div className="rail-head-row">
          <div className="who">
            <span className="pip active" style={{ "--role": "var(--role-director)" } as CSSProperties}>
              <Gnome role="director" size={28} />
            </span>
            <div className="rail-head-title">
              <h2>{directorName}</h2>
              <span className="dim mono" style={{ fontSize: 11 }}>
                {busy ? "director · thinking…" : "director" + (directorModel ? ` · ${modelLabel(directorModel).toLowerCase()}` : "")}
              </span>
            </div>
          </div>
          <AgentToggles />
        </div>
      </div>

      <div className="rail-search">
        <svg className="rail-search-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <circle cx="11" cy="11" r="7" />
          <path d="m20 20-3.2-3.2" />
        </svg>
        <input
          className="rail-search-input"
          type="search"
          value={searchText}
          placeholder="Search director messages across all tasks…"
          aria-label="Search director messages across all tasks"
          onChange={(e) => setSearchText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") setSearchText("");
          }}
        />
        {searchText && (
          <button className="rail-search-clear" type="button" aria-label="Clear search" title="Clear search" onClick={() => setSearchText("")}>
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
              dispatches a planned, researched task to an Opus 4.8 implementor.
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
        {recentRepos.length > 1 && (
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
        )}
        <div className="composer-mode">
          <button
            type="button"
            className={"mode-toggle" + (skip ? " on" : "")}
            role="switch"
            aria-checked={skip}
            title={
              skip
                ? `Skip-director ON — your message bypasses the director and dispatches straight to the ${firstStage}. Click to send via the director.`
                : "Skip-director OFF — your message goes to the director, which enriches and dispatches. Click to send straight to the pipeline."
            }
            onClick={() => setSettings({ skipDirector: !skip })}
          >
            <span className="mode-dot" aria-hidden="true" />
            Skip director
          </button>
          {skip && (
            <span className="mode-hint mono" title={`The first active pipeline stage is the ${firstStage}.`}>
              direct → {firstStage}
            </span>
          )}
        </div>
        {showModelPicker && <ComposerImplementorModelPickers />}
        {skip && <ComposerEffortPickers />}
        <textarea
          value={text}
          placeholder={
            skip
              ? `Direct to ${firstStage} — set the repo path below.  (⌘/Ctrl+Enter to send)`
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
  const xhighEnabled = useStore((s) => s.settings.xhighEnabled);
  const plannerEnabled = useStore((s) => s.settings.plannerEnabled);
  const setSettings = useStore((s) => s.setSettings);
  const claudeTiers = EFFORTS.filter((t) => t !== "xhigh" || xhighEnabled);
  const claudeTitle = `How hard the Claude implementor works on tasks dispatched directly. Auto = ${
    plannerEnabled ? "the planner's per-task pick" : "the built-in default (high) — the planner is off"
  }; a concrete tier overrides it.`;
  const codexTitle = "Codex CLI reasoning effort (model_reasoning_effort) — the same global setting as Settings → Subscriptions, applied to every Codex run.";

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
          <option value="auto">{plannerEnabled ? "Auto (planner decides)" : "Auto (high)"}</option>
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
            {CODEX_EFFORTS.map((t) => (
              <option key={t} value={t}>
                {t}
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

/** The per-task pipeline gates, in the Director header where tasks are composed/dispatched. Each
 *  gates a stage server-side (planner/researcher/QA) — flip them before sending to shape the next task. */
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
      onTitle: "Planner ON — click to skip planning and dispatch straight to the implementor",
      offTitle: "Planner OFF — tasks skip planning and go straight to the implementor. Click to re-enable.",
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
      onTitle: "QA ON — click to skip the QA review loop (implementor output becomes final)",
      offTitle: "QA OFF — the implementor's output is final, with no QA review loop. Click to re-enable.",
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

function DirectorBubble({ item }: { item: DirectorItem }) {
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
}

/** Whole-conversation search results, shown in place of the transcript while a query is active. Each hit
 *  renders a snippet centered on the match so a long director reply stays readable but the match is seen,
 *  plus a jump to the task its turn dispatched (when that task still exists). */
function DirectorSearchResults({
  search,
  directorName,
  onGoToTask,
}: {
  search: { query: string; results: DirectorMessage[]; searching: boolean };
  directorName: string;
  onGoToTask: (threadId: string) => void;
}) {
  const { query, results, searching } = search;
  const threads = useStore((s) => s.threads);
  const count = results.length;
  return (
    <div className="ds-results" role="region" aria-label="Director message search results">
      <div className="ds-status mono">
        {searching && count === 0 ? "Searching…" : `${count} ${count === 1 ? "match" : "matches"} for “${query}”`}
      </div>
      {!searching && count === 0 && (
        <div className="faint" style={{ fontSize: 13 }}>
          No director message across any task contains “{query}”.
        </div>
      )}
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

const resultDate = (ts: number): string =>
  new Date(ts).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });

// Build a snippet centered on the first case-insensitive match of `q`, wrapping every match inside the
// window in <mark>. A window (not the full body) keeps long director replies from dominating the list.
function highlightSnippet(text: string, q: string): ReactNode {
  const needle = q.toLowerCase();
  const first = text.toLowerCase().indexOf(needle);
  const anchor = first < 0 ? 0 : first;
  const WINDOW_BEFORE = 90;
  const WINDOW_AFTER = 240;
  const start = anchor > WINDOW_BEFORE ? anchor - WINDOW_BEFORE : 0;
  const end = Math.min(text.length, anchor + needle.length + WINDOW_AFTER);
  const slice = text.slice(start, end);
  const sliceLc = slice.toLowerCase();

  const nodes: ReactNode[] = [];
  let i = 0;
  while (i < slice.length) {
    const idx = sliceLc.indexOf(needle, i);
    if (idx < 0) {
      nodes.push(slice.slice(i));
      break;
    }
    if (idx > i) nodes.push(slice.slice(i, idx));
    nodes.push(
      <mark key={idx} className="ds-hit">
        {slice.slice(idx, idx + needle.length)}
      </mark>,
    );
    i = idx + needle.length;
  }
  return (
    <>
      {start > 0 && "…"}
      {nodes}
      {end < text.length && "…"}
    </>
  );
}
