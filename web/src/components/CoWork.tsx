import { useEffect, useMemo, useRef, useState } from "react";
import { useStore } from "../store.js";
import type { CoworkMessage, CoworkSession, CoworkSteeringMode, ImplementorProvider } from "../types.js";
import {
  CoworkAttachButton,
  CoworkComposerAttachments,
  useCoworkAttachments,
} from "../lib/attachments.js";
import { FolderPicker } from "./FolderPicker.js";
import { Markdown } from "./Markdown.js";
import { PathInput } from "./PathInput.js";
import { CodeContextBar } from "./CodeContextBar.js";
import { CoworkTranscript } from "./CoworkTranscript.js";
import { coworkOrigin } from "../lib/codeNav.js";

const EMPTY_COWORK_MESSAGES: CoworkMessage[] = [];

const repoLabel = (path: string): string => path.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || path;

function relativeTime(at: number): string {
  const minutes = Math.max(0, Math.round((Date.now() - at) / 60_000));
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}

function statusText(session: CoworkSession): string {
  switch (session.state) {
    case "running": return "working";
    case "stopping": return "stopping";
    case "error": return "needs input";
    case "idle": return "ready";
  }
}

/** `hidden` keeps this whole desk mounted while the owner is looking at another board area. The
 *  attribute (not a conditional render) is what preserves the transcript scroll position, expanded tool
 *  bursts, the draft and any staged attachments across a trip to the task board mid-turn. */
export function CoWork({ hidden = false }: { hidden?: boolean } = {}) {
  const sessionsById = useStore((state) => state.coworkSessions);
  const selectedId = useStore((state) => state.selectedCoworkId);
  const select = useStore((state) => state.selectCowork);
  const messages = useStore((state) => selectedId ? state.coworkMessages[selectedId] ?? EMPTY_COWORK_MESSAGES : EMPTY_COWORK_MESSAGES);
  const outbound = useStore((state) => state.outboundMessages);
  const send = useStore((state) => state.sendCowork);
  const stop = useStore((state) => state.stopCowork);
  const rename = useStore((state) => state.renameCowork);
  const remove = useStore((state) => state.deleteCowork);
  const actionError = useStore((state) => state.coworkActionError);
  const attachments = useCoworkAttachments();
  const [newOpen, setNewOpen] = useState(false);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [renaming, setRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState("");
  const [promoteOpen, setPromoteOpen] = useState(false);
  const openSummary = useStore((state) => state.openCoworkSummary);
  const summaryFor = useStore((state) => state.coworkSummaryFor);
  const attachmentSession = useRef(selectedId);

  const sessions = useMemo(
    () => Object.values(sessionsById).sort((a, b) => b.updatedAt - a.updatedAt || b.createdAt - a.createdAt),
    [sessionsById],
  );
  const selected = selectedId ? sessionsById[selectedId] : undefined;
  const pending = selectedId
    ? outbound.filter((message): message is Extract<typeof message, { surface: "cowork" }> =>
      message.surface === "cowork" && message.sessionId === selectedId)
    : [];
  useEffect(() => {
    if (selectedId && !sessionsById[selectedId]) select(null);
  }, [selectedId, sessionsById, select]);

  useEffect(() => {
    if (attachmentSession.current !== selectedId) {
      attachmentSession.current = selectedId;
      attachments.clear();
    }
  }, [selectedId, attachments.clear]);

  const submit = (mode: "turn" | CoworkSteeringMode = selected?.state === "running" ? "append" : "turn") => {
    if (!selected) return;
    const text = drafts[selected.id] ?? "";
    if ((!text.trim() && !attachments.files.length) || selected.state === "stopping") return;
    if (mode === "turn" && selected.state === "running") return;
    if (mode !== "turn" && selected.state !== "running") return;
    if (send(selected.id, text, mode, attachments.files)) {
      setDrafts((all) => ({ ...all, [selected.id]: "" }));
      attachments.clear();
    }
  };

  return (
    <section className={`cowork-shell${selected ? " has-session" : ""}`} hidden={hidden}>
      <aside className="cowork-session-list" aria-label="Co-work sessions">
        <div className="cowork-list-head">
          <div>
            <strong>Sessions</strong>
            <span>{sessions.length} saved</span>
          </div>
          <button className="btn primary sm cowork-new" onClick={() => setNewOpen(true)}>
            <PlusIcon /> New
          </button>
        </div>
        <div className="cowork-list-scroll">
          {sessions.map((session) => (
            <button
              key={session.id}
              className={`cowork-session-row${session.id === selectedId ? " active" : ""}`}
              onClick={() => select(session.id)}
            >
              <span className={`cowork-state-dot ${session.state}`} aria-hidden="true" />
              <span className="cowork-session-copy">
                <strong>{session.name}</strong>
                <span>{repoLabel(session.workspace)} · {session.model ?? session.requestedModel ?? "Auto model"}</span>
              </span>
              <span className="cowork-session-age mono">{relativeTime(session.updatedAt)}</span>
            </button>
          ))}
          {!sessions.length ? (
            <div className="cowork-list-empty">
              <div className="cowork-empty-mark"><SparkIcon /></div>
              <strong>No sessions yet</strong>
              <span>Start a direct coding conversation in any workspace.</span>
              <button className="btn primary" onClick={() => setNewOpen(true)}>Start Co-working</button>
            </div>
          ) : null}
        </div>
      </aside>

      <div className="cowork-conversation">
        {selected ? (
          <>
            <header className="cowork-chat-head">
              <button className="cowork-back" onClick={() => select(null)} aria-label="Back to sessions">‹</button>
              <div className="cowork-chat-identity">
                {renaming ? (
                  <input
                    className="cowork-rename-input"
                    value={renameValue}
                    autoFocus
                    onChange={(event) => setRenameValue(event.target.value)}
                    onBlur={() => {
                      if (renameValue.trim() && renameValue.trim() !== selected.name) rename(selected.id, renameValue);
                      setRenaming(false);
                    }}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") event.currentTarget.blur();
                      if (event.key === "Escape") setRenaming(false);
                    }}
                  />
                ) : (
                  <button
                    className="cowork-title-button"
                    title="Rename session"
                    onClick={() => { setRenameValue(selected.name); setRenaming(true); }}
                  >
                    {selected.name}
                  </button>
                )}
                <div className="cowork-chat-meta">
                  <span title={selected.workspace}>{repoLabel(selected.workspace)}</span>
                  <span className="cowork-meta-sep">/</span>
                  <span>{selected.provider
                    ? `${selected.provider} · ${selected.model}`
                    : selected.requestedProvider
                      ? `${selected.requestedProvider} · ${selected.requestedModel} · pinned`
                      : "Auto · resolves on first turn"}</span>
                </div>
                <CodeContextBar
                  subject={{ kind: "cowork", id: selected.id }}
                  origin={coworkOrigin(selected.id, selected.name)}
                />
              </div>
              <span className={`cowork-status ${selected.state}`}>
                <span className={`cowork-state-dot ${selected.state}`} />{statusText(selected)}
              </span>
              <button
                className="btn ghost sm cowork-head-action"
                title="What this conversation changed: files, commits and what was asked"
                onClick={() => openSummary(selected.id)}
              >
                <TrailIcon /> Summary
              </button>
              <button
                className="btn ghost sm cowork-head-action"
                title="Hand this exploration to the pipeline as a proper task"
                disabled={selected.state === "running" || selected.state === "stopping"}
                onClick={() => setPromoteOpen(true)}
              >
                <PromoteIcon /> Promote to task
              </button>
              <button
                className="cowork-delete"
                title="Delete session and conversation"
                aria-label="Delete session"
                disabled={selected.state === "running" || selected.state === "stopping"}
                onClick={() => {
                  if (confirm(`Delete “${selected.name}” and its conversation?`)) remove(selected.id);
                }}
              >
                <TrashIcon />
              </button>
            </header>

            {selected.error || actionError ? (
              <div className="cowork-error-banner" role="status">
                <strong>{selected.error ? "Turn stopped" : "Action not completed"}</strong>
                <span>{selected.error ?? actionError}</span>
                <small>{selected.error
                  ? "The conversation is intact. Send a new instruction when you’re ready."
                  : "Nothing was discarded. You can adjust the action or keep working in this session."}</small>
              </div>
            ) : null}

            <CoworkTranscript
              key={selected.id}
              sessionId={selected.id}
              messages={messages}
              pending={pending}
              empty={(
                <div className="cowork-chat-empty">
                  <div className="cowork-empty-mark"><SparkIcon /></div>
                  <h3>Work directly with your Co-worker</h3>
                  <p>Work in small, useful increments. Your Co-worker acts, verifies, and hands control back instead of disappearing into a solo project.</p>
                  <div className="cowork-start-facts">
                    <span><CheckIcon /> Persistent context</span>
                    <span><CheckIcon /> One bounded turn</span>
                    <span><CheckIcon /> You decide what’s next</span>
                  </div>
                </div>
              )}
              footer={selected.state === "running" && !messages.some((message) => message.turnId === selected.activeTurnId && message.role === "coworker") ? (
                <div className="cowork-working"><span /><span /><span /> Co-worker is working — steer it any time</div>
              ) : null}
            />

            <footer className="cowork-composer-wrap">
              <div
                className={`cowork-composer${selected.state === "running" ? " active" : ""}${attachments.dragging ? " dragging" : ""}`}
                {...attachments.dropHandlers}
              >
                <CoworkComposerAttachments files={attachments.files} onRemove={attachments.remove} />
                <div className="cowork-composer-main">
                  <CoworkAttachButton onPick={attachments.addFiles} disabled={selected.state === "stopping"} />
                  <textarea
                    value={drafts[selected.id] ?? ""}
                    placeholder={selected.state === "running" ? "Add direction or attach a file…" : "What should we work on next?"}
                    disabled={selected.state === "stopping"}
                    rows={1}
                    onPaste={attachments.onPaste}
                    onChange={(event) => {
                      setDrafts((all) => ({ ...all, [selected.id]: event.target.value }));
                      event.currentTarget.style.height = "auto";
                      event.currentTarget.style.height = `${Math.min(180, event.currentTarget.scrollHeight)}px`;
                    }}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" && !event.shiftKey) {
                        event.preventDefault();
                        submit(selected.state === "running" ? "append" : "turn");
                      }
                    }}
                  />
                  {selected.state === "stopping" ? (
                    <button className="cowork-stop" disabled>
                      <StopIcon /> Stopping
                    </button>
                  ) : selected.state !== "running" ? (
                    <button
                      className="cowork-send"
                      disabled={!drafts[selected.id]?.trim() && !attachments.files.length}
                      onClick={() => submit("turn")}
                      aria-label="Send instruction"
                    >
                      <SendIcon />
                    </button>
                  ) : null}
                </div>
              </div>
              {selected.state === "running" ? (
                <div className="cowork-steer-row" aria-label="Steer active Co-worker turn">
                  <span className="cowork-steer-label">Active direction</span>
                  <button
                    className="btn ghost sm cowork-steer queue"
                    disabled={!drafts[selected.id]?.trim() && !attachments.files.length}
                    onClick={() => submit("queue")}
                    title="Finish the current safe unit, then apply this before handing control back"
                  >
                    Queue
                  </button>
                  <button
                    className="btn primary sm cowork-steer inject"
                    disabled={!drafts[selected.id]?.trim() && !attachments.files.length}
                    onClick={() => submit("append")}
                    title="Apply this at the next safe point while preserving compatible progress"
                  >
                    Inject
                  </button>
                  <button
                    className="btn ghost sm cowork-steer interrupt"
                    disabled={!drafts[selected.id]?.trim() && !attachments.files.length}
                    onClick={() => submit("interrupt")}
                    title="Stop the current approach and apply this direction immediately"
                  >
                    Interrupt &amp; inject
                  </button>
                  <button className="cowork-stop" onClick={() => stop(selected.id)} title="Stop this work slice without another instruction">
                    <StopIcon /> Stop
                  </button>
                </div>
              ) : null}
              <div className="cowork-composer-note">
                <span>{selected.state === "running" ? "Enter injects · paste or drop files" : "Enter to send · paste or drop files"}</span>
                {selected.agentSessionId ? <span className="mono">context linked</span> : <span>new context</span>}
              </div>
            </footer>
          </>
        ) : (
          <div className="cowork-no-selection">
            <div className="cowork-empty-mark"><SparkIcon /></div>
            <h3>{sessions.length ? "Choose a Co-work session" : "Build together, one turn at a time"}</h3>
            <p>{sessions.length ? "Open a conversation from the left, or begin a new one." : "Direct coding sessions with durable context and no autonomous pipeline."}</p>
            <button className="btn primary" onClick={() => setNewOpen(true)}><PlusIcon /> New Co-work session</button>
          </div>
        )}
      </div>
      {newOpen ? <NewCoworkModal onClose={() => setNewOpen(false)} /> : null}
      {promoteOpen && selected ? <PromoteCoworkModal session={selected} onClose={() => setPromoteOpen(false)} /> : null}
      {summaryFor ? <CoworkSummaryModal sessionId={summaryFor} onClose={() => openSummary(null)} /> : null}
    </section>
  );
}

interface ModelOption {
  key: string;
  provider: ImplementorProvider;
  model: string;
  label: string;
}

export function NewCoworkModal({ onClose }: { onClose: () => void }) {
  const settings = useStore((state) => state.settings);
  const create = useStore((state) => state.createCowork);
  const creating = useStore((state) => state.coworkCreating);
  const error = useStore((state) => state.coworkActionError);
  const clearError = useStore((state) => state.clearCoworkError);
  const selectedId = useStore((state) => state.selectedCoworkId);
  const [name, setName] = useState("");
  const [workspace, setWorkspace] = useState(settings.recentRepos[0] ?? "");
  const [target, setTarget] = useState("auto");
  const [picker, setPicker] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const before = useRef(selectedId);

  const options = useMemo<ModelOption[]>(() => {
    const out: ModelOption[] = [];
    const add = (provider: ImplementorProvider, models: string[], enabled = true) => {
      if (!enabled) return;
      for (const model of models) out.push({ key: `${provider}\u0000${model}`, provider, model, label: `${provider === "zai" ? "z.ai" : provider} · ${model}` });
    };
    add("claude", settings.claudeModels.length ? settings.claudeModels : [settings.modelDefaults.implementor].filter((model): model is string => !!model));
    add("codex", settings.codexModels, settings.codexEnabled);
    add("grok", settings.grokModels, settings.grokEnabled);
    add("zai", settings.zaiModels, settings.zaiEnabled);
    return out;
  }, [settings]);

  useEffect(() => {
    clearError();
    return clearError;
  }, [clearError]);
  useEffect(() => {
    if (submitted && !creating && !error && selectedId && selectedId !== before.current) onClose();
  }, [submitted, creating, error, selectedId, onClose]);

  const submit = () => {
    const chosen = options.find((option) => option.key === target);
    const sent = create({
      name: name.trim() || undefined,
      workspace,
      provider: chosen?.provider ?? null,
      model: chosen?.model ?? null,
    });
    if (sent) setSubmitted(true);
  };

  return (
    <>
      <div className="scrim" onClick={onClose}>
        <div className="modal cowork-create-modal" onClick={(event) => event.stopPropagation()}>
        <div className="m-head cowork-create-head">
          <div className="cowork-empty-mark"><SparkIcon /></div>
          <div><div className="q-context">New Co-work session</div><p>A persistent coding conversation you lead turn by turn.</p></div>
        </div>
        <div className="m-body cowork-create-body">
          <label>
            <span>Workspace</span>
            <div className="cowork-workspace-field">
              <PathInput value={workspace} onChange={setWorkspace} placeholder="Absolute workspace path" />
              <button className="btn ghost" onClick={() => setPicker(true)} title="Browse folders"><FolderIcon /></button>
            </div>
            <small>The Co-worker runs with this folder as its working directory.</small>
          </label>
          <label>
            <span>Session name <em>optional</em></span>
            <input value={name} onChange={(event) => setName(event.target.value)} placeholder="Named from your first prompt" maxLength={120} />
          </label>
          <label>
            <span>Model</span>
            <select value={target} onChange={(event) => setTarget(event.target.value)}>
              <option value="auto">Auto · best available route</option>
              {options.map((option) => <option key={option.key} value={option.key}>{option.label}</option>)}
            </select>
            <small>{target === "auto" ? "The first turn resolves one model and keeps it for this session." : "This exact model is pinned. Capacity errors never substitute another."}</small>
          </label>
          {error ? <div className="cowork-create-error" role="alert">{error}</div> : null}
        </div>
        <div className="m-foot">
          <button className="btn ghost" onClick={onClose}>Cancel</button>
          <button className="btn primary" onClick={submit} disabled={creating || !workspace.trim()}>
            {creating ? "Creating…" : "Create session"}
          </button>
        </div>
        </div>
      </div>
      {picker ? <FolderPicker initialPath={workspace} onSelect={setWorkspace} onClose={() => setPicker(false)} /> : null}
    </>
  );
}

/** Hand this exploration to the pipeline. The brief the task starts from is composed SERVER-side from
 *  the durable transcript (repo, what was asked, files touched, commits made); the owner supplies only
 *  the objective, because that is the one thing the conversation cannot infer. */
function PromoteCoworkModal({ session, onClose }: { session: CoworkSession; onClose: () => void }) {
  const promote = useStore((state) => state.promoteCowork);
  const promoting = useStore((state) => state.coworkPromoting);
  const error = useStore((state) => state.coworkActionError);
  const promoted = useStore((state) => state.coworkPromoted);
  const clearPromotion = useStore((state) => state.clearCoworkPromotion);
  const selectThread = useStore((state) => state.select);
  const setBoardView = useStore((state) => state.setBoardView);
  const lastOwnerLine = useStore((state) => {
    const messages = state.coworkMessages[session.id] ?? [];
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const message = messages[i]!;
      if (message.role === "user" && message.kind === "text") return message.content;
    }
    return "";
  });
  const [objective, setObjective] = useState(lastOwnerLine);
  const landed = promoted?.sessionId === session.id ? promoted : null;

  const open = (): void => {
    if (!landed) return;
    clearPromotion();
    setBoardView("tasks");
    selectThread(landed.threadId);
    onClose();
  };

  return (
    <div className="scrim" onClick={onClose}>
      <div className="modal cowork-promote-modal" onClick={(event) => event.stopPropagation()}>
        <div className="m-head">
          <div className="q-context">Promote to task</div>
          <p>Starts an ordinary pipeline task in <span className="mono">{repoLabel(session.workspace)}</span>. This conversation stays exactly as it is.</p>
        </div>
        <div className="m-body">
          {landed ? (
            <div className="cowork-promote-done" role="status">
              <strong>Task dispatched.</strong>
              <span>It carries this session’s repo, instructions, touched files and commits as context to verify.</span>
            </div>
          ) : (
            <>
              <label>
                <span>What should the task do?</span>
                <textarea
                  value={objective}
                  rows={4}
                  autoFocus
                  maxLength={2000}
                  placeholder="Ship the responsive Co-work shell"
                  onChange={(event) => setObjective(event.target.value)}
                />
                <small>The rest of the brief is built from this conversation: what you asked, where it got to, which files it touched and what it committed.</small>
              </label>
              {error ? <div className="cowork-create-error" role="alert">{error}</div> : null}
            </>
          )}
        </div>
        <div className="m-foot">
          <button className="btn ghost" onClick={onClose}>{landed ? "Stay here" : "Cancel"}</button>
          {landed ? (
            <button className="btn primary" onClick={open}>Open the task</button>
          ) : (
            <button className="btn primary" disabled={promoting || !objective.trim()} onClick={() => promote(session.id, objective)}>
              {promoting ? "Dispatching…" : "Create task"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

/** The readable trail: what a session changed, for one you timeboxed, abandoned, or simply forgot.
 *  Derived server-side from the transcript itself, so opening it costs no agent turn. */
function CoworkSummaryModal({ sessionId, onClose }: { sessionId: string; onClose: () => void }) {
  const built = useStore((state) => state.coworkSummaries[sessionId]);
  const name = useStore((state) => state.coworkSessions[sessionId]?.name ?? "this session");
  return (
    <div className="scrim" onClick={onClose}>
      <div className="modal cowork-summary-modal" onClick={(event) => event.stopPropagation()}>
        <div className="m-head">
          <div className="q-context">Session trail</div>
          <p>{name}</p>
        </div>
        <div className="m-body cowork-summary-body">
          {built === undefined ? <p className="faint">Reading the conversation…</p>
            : built === null ? <p className="faint">That session is no longer available.</p>
              : <Markdown text={built.markdown} />}
        </div>
        <div className="m-foot">
          <button className="btn ghost" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}

function PlusIcon() { return <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"><path d="M12 5v14M5 12h14" /></svg>; }
function SendIcon() { return <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="m22 2-7 20-4-9-9-4Z" /><path d="M22 2 11 13" /></svg>; }
function StopIcon() { return <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><rect x="5" y="5" width="14" height="14" rx="2" /></svg>; }
function TrashIcon() { return <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6M10 11v5M14 11v5" /></svg>; }
function FolderIcon() { return <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 6h6l2 2h10v11H3Z" /></svg>; }
function CheckIcon() { return <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4"><path d="m5 12 4 4L19 6" /></svg>; }
function SparkIcon() { return <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="m12 3 1.7 4.3L18 9l-4.3 1.7L12 15l-1.7-4.3L6 9l4.3-1.7Z" /><path d="m19 15 .8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8Z" /></svg>; }
function TrailIcon() { return <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M4 6h11M4 12h16M4 18h9" /></svg>; }
function PromoteIcon() { return <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 19V5M6 11l6-6 6 6" /></svg>; }
