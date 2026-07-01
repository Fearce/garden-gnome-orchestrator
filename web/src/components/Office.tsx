import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { useShallow } from "zustand/react/shallow";
import { useStore } from "../store.js";
import type { ChatMessage, Role } from "../types.js";
import { agentName, GENERAL_ROOM, normalizeWorkspace, repoRoom } from "../types.js";
import { clock, pacePeriodForModel, roleColor } from "../lib/format.js";
import { Gnome } from "./Gnome.js";
import { Markdown } from "./Markdown.js";

// One active task = one gnome in the office. The latest active run gives it its role (the gnome's hat
// color + tool); the task gives it its repo (which decides who huddles with whom).
interface Worker {
  runId: string;
  threadId: string;
  role: Role;
  model: string; // drives the walker's pacing tempo — a more capable model struts a quicker lap
  title: string;
  workspace: string;
}

// A cluster of workers in the same repo. A `room` (≥2 distinct tasks) is a real project chatroom —
// the gnomes stand still together; a lone worker paces on its own.
interface Group {
  key: string;
  workspace: string;
  room: string | null; // repo room key when ≥2 tasks share the repo, else null (solo, general only)
  workers: Worker[];
}

// How long a freshly-posted message floats as a bubble above its gnome.
const BUBBLE_MS = 9000;

// A pacing gnome doesn't march non-stop — after some laps it stops and takes a breather. We decide this
// in JS (not a fixed CSS cycle) so each gnome idles independently rather than all resting in lockstep.
const IDLE_CHANCE = 0.22; // odds of resting at any given lap boundary — low, so they mostly keep strolling
const IDLE_MIN_MS = 2000; // a breather lasts a random 2–7s
const IDLE_MAX_MS = 7000;

/** Gives a walker its own random idle rhythm: at each lap boundary (the gnome is back in its upright home
 *  pose) it may pause for a random 2–7s before setting off again. Pausing only at the boundary means it
 *  always rests standing still, never frozen mid-stride. Returns a ref to attach to the `.office-pacer`. */
function useRandomIdle(active: boolean) {
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el || !active) return;
    let resumeTimer: ReturnType<typeof setTimeout> | undefined;
    const onIteration = () => {
      if (el.classList.contains("resting") || Math.random() >= IDLE_CHANCE) return;
      el.classList.add("resting"); // stands in the home pose (CSS pauses the animation)
      const rest = IDLE_MIN_MS + Math.random() * (IDLE_MAX_MS - IDLE_MIN_MS);
      resumeTimer = setTimeout(() => el.classList.remove("resting"), rest);
    };
    el.addEventListener("animationiteration", onIteration);
    return () => {
      el.removeEventListener("animationiteration", onIteration);
      if (resumeTimer) clearTimeout(resumeTimer);
      el.classList.remove("resting");
    };
  }, [active]);
  return ref;
}

/** A single pacing gnome (director or a lone agent). `active` gates the random-idle rhythm — pass the
 *  director's busy flag, or `true` for a live agent. */
function Pacer({ role, active }: { role: Role; active: boolean }) {
  const ref = useRandomIdle(active);
  return (
    <span className="office-pacer" ref={ref}>
      <Gnome role={role} size={20} />
    </span>
  );
}

function leaf(p: string): string {
  const norm = p.replace(/[\\/]+$/, "");
  const i = Math.max(norm.lastIndexOf("\\"), norm.lastIndexOf("/"));
  return i < 0 ? norm : norm.slice(i + 1);
}

function trim(s: string, n: number): string {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > n ? one.slice(0, n - 1) + "…" : one;
}

function useNow(active: boolean, ms: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(id);
  }, [active, ms]);
  return now;
}

/** The office: the strip of working gnomes in the top bar, plus the expandable chatroom panel. One
 *  gnome per active task paces the strip; 2+ tasks in the same repo huddle together (a project room)
 *  and clicking them opens that room. Clicking a lone gnome opens the general office. */
export function Office() {
  const runs = useStore(useShallow((s) => Object.values(s.runs).filter((r) => r.state === "starting" || r.state === "running")));
  const threads = useStore((s) => s.threads);
  const chat = useStore((s) => s.chat);
  const officeRoom = useStore((s) => s.officeRoom);
  const openOffice = useStore((s) => s.openOffice);
  const directorBusy = useStore((s) => s.directorBusy);
  const nameOverrides = useStore((s) => s.nameOverrides);
  // A worker's name is per (thread, role) — the running role IS the agent, so the gnome carries that
  // agent's name, and it advances as the pipeline hands off (planner → implementor → …).
  const nameOf = (threadId: string, role: Role) => agentName(nameOverrides, threadId, role);

  // One worker per active task (latest active run wins), then grouped by normalized repo.
  const groups = useMemo<Group[]>(() => {
    const perThread = new Map<string, Worker>();
    for (const r of [...runs].sort((a, b) => a.startedAt - b.startedAt)) {
      const t = threads[r.threadId];
      if (!t) continue;
      perThread.set(r.threadId, { runId: r.id, threadId: r.threadId, role: r.role, model: r.model, title: t.title, workspace: t.workspace });
    }
    const byRepo = new Map<string, Worker[]>();
    for (const w of perThread.values()) {
      const k = normalizeWorkspace(w.workspace);
      const arr = byRepo.get(k);
      if (arr) arr.push(w);
      else byRepo.set(k, [w]);
    }
    return [...byRepo.entries()]
      .map(([k, workers]) => ({
        key: k,
        workspace: workers[0]!.workspace,
        room: workers.length >= 2 ? repoRoom(workers[0]!.workspace) : null,
        workers,
      }))
      .sort((a, b) => (b.room ? 1 : 0) - (a.room ? 1 : 0) || a.key.localeCompare(b.key));
  }, [runs, threads]);

  const liveCount = groups.reduce((n, g) => n + g.workers.length, 0);
  const now = useNow(liveCount > 0, 1000);

  // Latest message per run and per project room, for the floating bubbles.
  const { byRun, byRoom } = useMemo(() => {
    const byRun = new Map<string, ChatMessage>();
    const byRoom = new Map<string, ChatMessage>();
    for (const m of chat) {
      if (m.kind !== "chat") continue;
      if (m.runId) byRun.set(m.runId, m);
      if (m.scope === "project") byRoom.set(m.room, m);
    }
    return { byRun, byRoom };
  }, [chat]);

  const bubbleFor = (m: ChatMessage | undefined): string | null =>
    m && now - m.createdAt < BUBBLE_MS ? trim(m.body, 64) : null;

  // The director is always "in the office": it gets a persistent walker at the head of the strip even
  // when no task agents are live, so the strip never collapses (which used to let the usage chips slide
  // to the left) and the director is always one click from its chat.
  return (
    <div className="office">
      <div className="office-strip" title="The office — the director and any agents working right now. Click to open the chat.">
        <button
          className={"office-walker office-director" + (directorBusy ? " working" : "")}
          // The director is a Sonnet — pace it at the same model-driven medium lap as any Sonnet worker.
          style={{ "--pace-dur": `${pacePeriodForModel("claude-sonnet")}s`, "--pace-delay": "0s" } as CSSProperties}
          onClick={() => openOffice(GENERAL_ROOM)}
          title={directorBusy ? "The director is working — click to open the office chat" : "The director — click to open the office chat"}
        >
          <Pacer role="director" active={directorBusy} />
        </button>
        {liveCount > 0
          ? groups.map((g) =>
            g.room ? (
              <button
                key={g.key}
                className="office-huddle"
                onClick={() => openOffice(g.room!)}
                title={`${g.workers.map((w) => nameOf(w.threadId, w.role)).join(", ")} collaborating in ${leaf(g.workspace)} — click to open their chatroom`}
              >
                <span className="office-huddle-gnomes">
                  {g.workers.slice(0, 4).map((w) => (
                    <Gnome key={w.threadId} role={w.role} size={20} />
                  ))}
                </span>
                <span className="office-huddle-tag">{leaf(g.workspace)}</span>
                {bubbleFor(byRoom.get(g.room)) ? <span className="office-bubble team">{bubbleFor(byRoom.get(g.room))}</span> : null}
              </button>
            ) : (
              g.workers.map((w, i) => (
                <button
                  key={w.threadId}
                  className="office-walker"
                  style={{ "--pace-dur": `${pacePeriodForModel(w.model)}s`, "--pace-delay": `${(i % 4) * 0.6}s` } as CSSProperties}
                  onClick={() => openOffice(GENERAL_ROOM)}
                  title={`${nameOf(w.threadId, w.role)} (${w.role}) on "${w.title}" — click to open the office chat`}
                >
                  <Pacer role={w.role} active={true} />
                  {bubbleFor(byRun.get(w.runId)) ? <span className="office-bubble">{bubbleFor(byRun.get(w.runId))}</span> : null}
                </button>
              ))
            ),
          )
          : null}
      </div>
      {officeRoom != null ? <OfficePanel /> : null}
    </div>
  );
}

function OfficePanel() {
  const officeRoom = useStore((s) => s.officeRoom)!;
  const close = useStore((s) => s.closeOffice);
  const open = useStore((s) => s.openOffice);
  const rooms = useStore((s) => s.chatRooms);
  const chat = useStore((s) => s.chat);
  const roomHistory = useStore((s) => s.roomHistory);
  const threads = useStore((s) => s.threads);
  const nameOverrides = useStore((s) => s.nameOverrides);
  const postChat = useStore((s) => s.postChat);
  const [draft, setDraft] = useState("");

  // Full history if it's been fetched; otherwise fall back to the recent cross-room slice we hold.
  const messages = useMemo(() => {
    const loaded = roomHistory[officeRoom];
    const base = loaded ?? chat.filter((m) => m.room === officeRoom);
    return [...base].sort((a, b) => a.createdAt - b.createdAt);
  }, [roomHistory, chat, officeRoom]);

  const bodyRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = bodyRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages.length, officeRoom]);

  // Project rooms (≥2 participants) are the real collaborations worth a tab; the general room is always shown.
  const projectRooms = rooms.filter((r) => r.threadIds.length >= 2);

  const send = () => {
    const text = draft.trim();
    if (!text) return;
    postChat(officeRoom, text);
    setDraft("");
  };

  return (
    <>
      <div className="office-scrim" onClick={close} />
      <div className="office-panel" role="dialog" aria-label="Office chat">
        <div className="office-panel-head">
          <div className="office-tabs">
            <button className={"office-tab" + (officeRoom === GENERAL_ROOM ? " on" : "")} onClick={() => open(GENERAL_ROOM)}>
              Office
            </button>
            {projectRooms.map((r) => (
              <button
                key={r.room}
                className={"office-tab" + (officeRoom === r.room ? " on" : "")}
                onClick={() => open(r.room)}
                title={`${r.workspace} · ${r.threadIds.length} tasks`}
              >
                {leaf(r.workspace)} <span className="office-tab-n">{r.threadIds.length}</span>
              </button>
            ))}
          </div>
          <button className="close-x" onClick={close} aria-label="Close" title="Close">
            ✕
          </button>
        </div>
        <div className="office-panel-sub">
          {officeRoom === GENERAL_ROOM
            ? "The general office — every active agent can talk here."
            : "Project room — agents sharing this repository coordinate here."}
        </div>
        <div className="office-msgs" ref={bodyRef}>
          {messages.length === 0 ? (
            <div className="office-empty">No messages yet{officeRoom === GENERAL_ROOM ? "" : " — they just grouped up"}.</div>
          ) : (
            messages.map((m) => (
              <OfficeMsg
                key={m.id}
                m={m}
                title={m.threadId ? threads[m.threadId]?.title : undefined}
                name={m.senderName || (m.threadId && m.role !== "system" ? agentName(nameOverrides, m.threadId, m.role) : undefined)}
              />
            ))
          )}
        </div>
        <div className="office-composer">
          <textarea
            value={draft}
            placeholder={
              officeRoom === GENERAL_ROOM
                ? "Message the whole office as director… (Enter to send)"
                : "Message this repo's agents as director — they'll coordinate who takes it… (Enter to send)"
            }
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                send();
              }
            }}
          />
          <button className="btn primary sm" onClick={send} disabled={!draft.trim()}>
            Send
          </button>
        </div>
      </div>
    </>
  );
}

function OfficeMsg({ m, title, name }: { m: ChatMessage; title?: string; name?: string }) {
  if (m.kind === "system") {
    return <div className="office-sys">{m.body}</div>;
  }
  const role = m.role as Role;
  return (
    <div className="office-msg" style={{ "--role": roleColor(role) } as CSSProperties}>
      <Gnome role={role} size={22} />
      <div className="office-msg-main">
        <div className="office-msg-head">
          <span className="office-msg-role" style={{ color: roleColor(role) }}>
            {name ?? role}
          </span>
          <span className="office-msg-kind">{role}</span>
          {title ? <span className="office-msg-task">on “{trim(title, 32)}”</span> : null}
          <span className="office-msg-ts">{clock(m.createdAt)}</span>
        </div>
        <Markdown className="office-msg-body" text={m.body} />
      </div>
    </div>
  );
}
