import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useStore } from "../store.js";
import type { CoworkMessage } from "../types.js";
import { CoworkComposerAttachments, CoworkMessageAttachments } from "../lib/attachments.js";
import { Markdown } from "./Markdown.js";
import {
  groupCoworkTranscript,
  toolBurstLabel,
  toolBurstTools,
  toolCallSummary,
  toolResultSummary,
  type CoworkToolCall,
  type CoworkTranscriptItem,
} from "../lib/coworkTranscript.js";

/** The Co-work transcript: a conversation with the tool noise folded away, that stays where you left it.
 *
 *  Three behaviours, all of which existed as pain before:
 *   - It STICKS to the bottom while the Co-worker streams, and stops sticking the instant the owner
 *     scrolls up to read something. A "jump to latest" pill is then the way back, so live output never
 *     yanks the view out from under them.
 *   - The position is remembered PER SESSION in the store, not in this component, because leaving the
 *     Co-work board view unmounts it (and `display: none` resets scrollTop anyway).
 *   - Tool calls collapse to one row each and consecutive ones fold into a single burst accordion.
 *     Expansion is remembered in the store for the same reason as the scroll position. */

/** How close to the bottom still counts as "following along". Roughly one message. */
const STICK_SLACK = 180;

interface Props {
  sessionId: string;
  messages: CoworkMessage[];
  pending: { id: string; content: string; attachments?: { name: string }[]; status?: string; mode?: string; error?: string }[];
  /** Rendered under the transcript while a turn is live, e.g. the working indicator. */
  footer?: ReactNode;
  /** Rendered instead of everything else when the conversation is empty. */
  empty?: ReactNode;
}

export function CoworkTranscript({ sessionId, messages, pending, footer, empty }: Props) {
  const remember = useStore((state) => state.rememberCoworkScroll);
  const scrollRef = useRef<HTMLDivElement>(null);
  // The live truth about whether we are following the stream. Kept in a ref, not state: it changes on
  // every scroll event and must never cause a render of a transcript that is mid-scroll.
  const stuck = useRef(true);
  const restoredFor = useRef<string | null>(null);
  // Coalesces the position write to one per frame. Scroll fires far faster than that, and each write is
  // a store update every other subscriber's selector then re-runs.
  const pendingWrite = useRef(0);
  // The pill's visibility is the one piece of scroll state that has to render; everything else the
  // scroll handler touches lives in refs and the store, so following a stream costs no re-renders.
  const [showPill, setShowPill] = useState(false);

  const items = useMemo(() => groupCoworkTranscript(messages), [messages]);
  // A cheap signature of everything that can change the transcript's height. Streaming appends to one
  // message's content rather than adding a row, so a length-only dependency would never fire.
  const signature = `${items.length}:${messages.reduce((chars, message) => chars + message.content.length, 0)}:${pending.length}`;

  const toBottom = useCallback((behavior: ScrollBehavior = "smooth") => {
    const node = scrollRef.current;
    if (!node) return;
    stuck.current = true;
    setShowPill(false);
    node.scrollTo({ top: node.scrollHeight, behavior });
  }, [setShowPill]);

  // Opening a session restores where the owner deliberately left it; a session they were following
  // opens at the bottom. Read ONCE, imperatively: subscribing to the saved position would re-render
  // this component on every scroll event, since scrolling is what writes it.
  useEffect(() => {
    const node = scrollRef.current;
    if (!node || restoredFor.current === sessionId) return;
    restoredFor.current = sessionId;
    const saved = useStore.getState().coworkScroll[sessionId];
    stuck.current = saved?.stuck ?? true;
    node.scrollTop = stuck.current || !saved ? node.scrollHeight : saved.top;
    setShowPill(!stuck.current);
  }, [sessionId, setShowPill]);

  useEffect(() => () => cancelAnimationFrame(pendingWrite.current), []);

  useEffect(() => {
    if (stuck.current) toBottom(items.length > 40 ? "auto" : "smooth");
  }, [signature, toBottom, items.length]);

  const onScroll = (): void => {
    const node = scrollRef.current;
    if (!node) return;
    const nearBottom = node.scrollHeight - node.scrollTop - node.clientHeight < STICK_SLACK;
    const top = node.scrollTop;
    stuck.current = nearBottom;
    setShowPill(!nearBottom);
    cancelAnimationFrame(pendingWrite.current);
    pendingWrite.current = requestAnimationFrame(() => remember(sessionId, { top, stuck: nearBottom }));
  };

  const conversation = !messages.length && !pending.length;
  return (
    <div className="cowork-transcript-wrap">
      <div className="cowork-transcript" ref={scrollRef} onScroll={onScroll}>
        {conversation ? empty : null}
        {items.map((item) => <TranscriptItem key={item.key} item={item} />)}
        {pending.map((message) => (
          <div key={message.id} className="cowork-message user pending">
            <div className="cowork-bubble">{message.content}</div>
            <CoworkComposerAttachments files={(message.attachments ?? []) as never[]} />
            <span className={message.status === "failed" ? "delivery-failed" : "delivery-sending"}>
              {message.status === "failed"
                ? message.error ?? "Not delivered"
                : message.mode === "queue"
                  ? "queueing…"
                  : message.mode === "interrupt"
                    ? "interrupting…"
                    : message.mode === "append"
                      ? "injecting…"
                      : "sending…"}
            </span>
          </div>
        ))}
        {footer}
      </div>
      {showPill ? (
        <button className="cowork-jump" onClick={() => toBottom()} aria-label="Jump to the latest message">
          <ArrowDownIcon /> Jump to latest
        </button>
      ) : null}
    </div>
  );
}

function TranscriptItem({ item }: { item: CoworkTranscriptItem }) {
  if (item.kind === "tools") return <CoworkToolBurst item={item} />;
  return <CoworkBubble message={item.message} />;
}

/** A run of consecutive tool calls, folded to one row. Opening it lists each call; opening a call shows
 *  its input and full output. Nothing here is destroyed by collapsing, only hidden. */
function CoworkToolBurst({ item }: { item: Extract<CoworkTranscriptItem, { kind: "tools" }> }) {
  const open = useStore((state) => !!state.coworkOpenTools[item.key]);
  const toggle = useStore((state) => state.toggleCoworkTool);
  const failures = item.calls.filter((call) => call.failed).length;
  const running = item.calls.some((call) => call.result == null);
  return (
    <div className={`cowork-tools${open ? " open" : ""}${failures ? " has-error" : ""}`}>
      <button className="cowork-tools-head" onClick={() => toggle(item.key)} aria-expanded={open}>
        <ChevronIcon />
        <ToolIcon />
        <span className="cowork-tools-label">{toolBurstLabel(item)}</span>
        <span className="cowork-tools-tools">{toolBurstTools(item).slice(0, 4).join(" · ")}</span>
        {failures ? <span className="cowork-tools-failed">{failures} failed</span> : null}
        {running ? <span className="cowork-tools-running">running</span> : null}
      </button>
      {open ? (
        <div className="cowork-tools-body">
          {item.calls.map((call) => <CoworkToolRow key={call.id} call={call} />)}
        </div>
      ) : null}
    </div>
  );
}

/** One call: name, a one-line "what" and a one-line "what came back". Click for the whole thing. */
function CoworkToolRow({ call }: { call: CoworkToolCall }) {
  const open = useStore((state) => !!state.coworkOpenTools[call.id]);
  const toggle = useStore((state) => state.toggleCoworkTool);
  return (
    <div className={`cowork-tool${call.failed ? " error" : ""}${open ? " open" : ""}`}>
      <button className="cowork-tool-row" onClick={() => toggle(call.id)} aria-expanded={open}>
        <span className="cowork-tool-name mono">{call.name}</span>
        <span className="cowork-tool-arg mono">{toolCallSummary(call)}</span>
        <span className="cowork-tool-result mono">{toolResultSummary(call)}</span>
      </button>
      {open ? (
        <div className="cowork-tool-detail">
          <pre>{typeof call.input === "string" ? call.input : JSON.stringify(call.input ?? {}, null, 2)}</pre>
          {call.result != null ? <pre className="cowork-tool-output">{call.result}</pre> : null}
        </div>
      ) : null}
    </div>
  );
}

/** A system line is normally one quiet centred rule. The session-summary trail is the exception: it is
 *  a document the owner reads, so it renders as markdown in its own card. */
function CoworkSystemLine({ message }: { message: CoworkMessage }) {
  const meta = message.meta && typeof message.meta === "object" ? (message.meta as Record<string, unknown>) : null;
  if (meta?.event === "cowork_session_summary") {
    return (
      <details className="cowork-trail" open>
        <summary>Session trail</summary>
        <Markdown text={message.content} />
      </details>
    );
  }
  return <div className="cowork-system-message"><span>{message.content}</span></div>;
}

export function CoworkBubble({ message }: { message: CoworkMessage }) {
  const meta = message.meta && typeof message.meta === "object" ? message.meta as Record<string, unknown> : null;
  if (message.kind === "thinking") {
    return (
      <details className="cowork-detail thinking">
        <summary>{message.partial ? "Thinking…" : "Reasoning"}</summary>
        <Markdown text={message.content} />
      </details>
    );
  }
  // A tool row reaching this point has no provider tool id to pair on; show it rather than drop it.
  if (message.kind === "tool" || message.kind === "tool_result") {
    return (
      <details className={`cowork-detail tool${meta?.isError ? " error" : ""}`}>
        <summary><ToolIcon /> {message.kind === "tool" ? String(meta?.name ?? message.content) : "Tool result"}</summary>
        <pre>{message.kind === "tool" ? JSON.stringify(meta?.input ?? meta, null, 2) : message.content}</pre>
      </details>
    );
  }
  if (message.role === "system" || message.kind === "system") return <CoworkSystemLine message={message} />;
  const steeringMode = message.role === "user" && typeof meta?.steeringMode === "string" ? meta.steeringMode : null;
  const steeringDelivery = typeof meta?.delivery === "string" ? meta.delivery : null;
  const steeringLabel = steeringDelivery === "failed"
    ? "Delivery failed"
    : steeringDelivery === "pending"
      ? "Delivery unconfirmed"
      : steeringMode === "queue"
        ? "Queued"
        : steeringMode === "append"
          ? "Injected"
          : steeringMode === "interrupt"
            ? "Interrupted + injected"
            : null;
  return (
    <article className={`cowork-message ${message.role}${message.partial ? " partial" : ""}`}>
      <div className="cowork-speaker">
        {message.role === "user" ? "You" : "Co-worker"}
        {steeringLabel ? <span className={`cowork-steering-badge ${steeringMode} ${steeringDelivery ?? ""}`}>{steeringLabel}</span> : null}
      </div>
      <div className="cowork-bubble">
        {message.role === "coworker" ? <Markdown text={message.content} /> : message.content}
        <CoworkMessageAttachments refs={message.attachments} />
        {message.partial ? <span className="cowork-caret" /> : null}
      </div>
    </article>
  );
}

function ToolIcon() { return <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M14.7 6.3a4 4 0 0 0-5-5l2.1 2.1-2.8 2.8L6.9 4.1a4 4 0 0 0 5 5L19 16.2a2 2 0 1 1-2.8 2.8l-7.1-7.1" /></svg>; }
function ChevronIcon() { return <svg className="cowork-chevron" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6"><path d="m9 6 6 6-6 6" /></svg>; }
function ArrowDownIcon() { return <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4"><path d="M12 5v14M6 13l6 6 6-6" /></svg>; }
