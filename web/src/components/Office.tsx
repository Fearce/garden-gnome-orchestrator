import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { useShallow } from "zustand/react/shallow";
import { useStore } from "../store.js";
import type { ChatMessage, ChatRoomSummary, RelayPresentAgent, Role, SharedRepo } from "../types.js";
import { agentName, CHAT_PAGE_SIZE, GENERAL_ROOM, isCollaborationRoom, normalizeWorkspace, repoRoom, ROLES } from "../types.js";
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

// A cluster of agents in the same repo. A `room` is a real project chatroom — the gnomes stand still
// together; a lone worker paces on its own. Membership is by REPOSITORY, not by machine: a teammate
// reached through the Online Office works the same repo from another checkout and can land the same
// conflicting commit, so they huddle here too rather than in a separate box off to the side.
interface Group {
  key: string;
  workspace: string;
  room: string | null; // repo room key when ≥2 agents share the repo, else null (solo, general only)
  workers: Worker[];
  remotes: RelayPresentAgent[];
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

const roleOf = (r: string): Role => ((ROLES as readonly string[]).includes(r) ? (r as Role) : "implementor");

/** The hover text for a huddle. It names the remote half explicitly, by machine: "who is in this repo
 *  with me, and are they somewhere my `git status` can see?" is the whole question the strip answers. */
function huddleTitle(g: Group, nameOf: (w: Worker) => string): string {
  const here = g.workers.map(nameOf).join(", ");
  if (!g.remotes.length) return `${here} collaborating in ${leaf(g.workspace)} — click to open their chatroom`;
  const there = [...new Set(g.remotes.map((a) => a.instanceName))]
    .map((inst) => `${g.remotes.filter((a) => a.instanceName === inst).map((a) => a.name).join(", ")} on ${inst}`)
    .join("; ");
  return (
    `${here} in ${leaf(g.workspace)}, working with ${there} through the online office.\n` +
    `They have their own checkout — their commits reach you at the remote, not in your working tree.\n` +
    `Click to open the shared chatroom.`
  );
}

/** Hover text for a project-room tab: the repo, and who is in it — naming the other machines, since
 *  "N tasks" is meaningless for a room whose participants are all somewhere else. */
function roomTabTitle(r: ChatRoomSummary): string {
  const parts = [`${r.threadIds.length} task${r.threadIds.length === 1 ? "" : "s"} here`];
  if (r.remoteInstances.length) parts.push(`${r.remoteInstances.join(", ")} (online office)`);
  return `${r.workspace} · ${parts.join(" · ")}`;
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
  const onlineOffice = useStore((s) => s.onlineOffice);
  const nameOverrides = useStore((s) => s.nameOverrides);
  const directorName = useStore((s) => s.settings.directorName);
  // A worker's name is per (thread, role) — the running role IS the agent, so the gnome carries that
  // agent's name, and it advances as the pipeline hands off (planner → implementor → …). The director
  // is the singleton persona from settings, not a gnome from the pool.
  const nameOf = (threadId: string, role: Role) =>
    role === "director" ? directorName : agentName(nameOverrides, threadId, role);

  // Which local workspaces belong to a repository someone else is also working right now. The server
  // resolves that (a repo identity is a git read); the client only joins the two lists.
  const sharedByWorkspace = useMemo(() => {
    const out = new Map<string, SharedRepo>();
    for (const r of onlineOffice.sharedRepos) for (const ws of r.workspaces) out.set(normalizeWorkspace(ws), r);
    return out;
  }, [onlineOffice.sharedRepos]);

  // One worker per active task (latest active run wins), grouped by normalized repo, then joined with the
  // remote agents working that same repository.
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
      .map(([k, workers]) => {
        const shared = sharedByWorkspace.get(k);
        const remotes = shared ? onlineOffice.remoteAgents.filter((a) => a.repoKey === shared.repoKey) : [];
        return {
          key: k,
          workspace: workers[0]!.workspace,
          room: workers.length + remotes.length >= 2 ? repoRoom(workers[0]!.workspace) : null,
          workers,
          remotes,
        };
      })
      .sort((a, b) => (b.room ? 1 : 0) - (a.room ? 1 : 0) || a.key.localeCompare(b.key));
  }, [runs, threads, sharedByWorkspace, onlineOffice.remoteAgents]);

  const liveCount = groups.reduce((n, g) => n + g.workers.length, 0);
  const now = useNow(liveCount > 0, 1000);

  // Coworkers reached through the Online Office who are NOT already standing in one of the huddles above
  // — i.e. working repos this machine isn't. Grouped by machine, since with no shared repo that (not a
  // path we don't have) is all that distinguishes them.
  const remoteMachines = useMemo(() => {
    const huddled = new Set(groups.flatMap((g) => g.remotes.map((a) => `${a.instanceId}:${a.key}`)));
    const byInstance = new Map<string, { name: string; agents: RelayPresentAgent[] }>();
    for (const a of onlineOffice.remoteAgents) {
      if (huddled.has(`${a.instanceId}:${a.key}`)) continue;
      const e = byInstance.get(a.instanceId) ?? { name: a.instanceName, agents: [] };
      e.agents.push(a);
      byInstance.set(a.instanceId, e);
    }
    return [...byInstance.values()];
  }, [onlineOffice.remoteAgents, groups]);

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
                className={"office-huddle" + (g.remotes.length ? " cross-machine" : "")}
                onClick={() => openOffice(g.room!)}
                title={huddleTitle(g, (w) => nameOf(w.threadId, w.role))}
              >
                <span className="office-huddle-gnomes">
                  {g.workers.slice(0, 4).map((w) => (
                    <Gnome key={w.threadId} role={w.role} size={20} />
                  ))}
                  {/* Teammates from another machine stand in the same huddle — dimmed, because nothing
                      they do lands in this working tree until someone pushes. */}
                  {g.remotes.slice(0, 3).map((a) => (
                    <span className="office-huddle-remote" key={`${a.instanceId}:${a.key}`}>
                      <Gnome role={roleOf(a.role)} size={20} />
                    </span>
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
        {remoteMachines.map((m) => (
          <button
            key={m.name}
            className="office-remote"
            onClick={() => openOffice(GENERAL_ROOM)}
            title={
              `${m.name} — another machine in the online office, working repos you aren't:\n` +
              m.agents.map((a) => `${a.name} (${a.role}) on "${a.title}" in ${a.repoLabel}`).join("\n")
            }
          >
            <span className="office-remote-gnomes">
              {m.agents.slice(0, 3).map((a) => (
                <Gnome key={`${a.instanceId}:${a.key}`} role={roleOf(a.role)} size={18} />
              ))}
            </span>
            <span className="office-remote-tag">{m.name}</span>
          </button>
        ))}
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
  const roomHasMore = useStore((s) => s.roomHasMore);
  const roomLoading = useStore((s) => s.roomLoading);
  const loadMoreRoom = useStore((s) => s.loadMoreRoom);
  const threads = useStore((s) => s.threads);
  const nameOverrides = useStore((s) => s.nameOverrides);
  const directorName = useStore((s) => s.settings.directorName);
  const postChat = useStore((s) => s.postChat);
  const [draft, setDraft] = useState("");

  // Loaded pages if any have been fetched; otherwise a placeholder from the recent cross-room slice we
  // hold — capped to one page's worth so the initial view already matches the first fetched page (no
  // shrink flash when the real newest page replaces a larger snapshot slice). Kept ASC.
  const messages = useMemo(() => {
    const loaded = roomHistory[officeRoom];
    const sorted = [...(loaded ?? chat.filter((m) => m.room === officeRoom))].sort((a, b) => a.createdAt - b.createdAt);
    return loaded ? sorted : sorted.slice(-CHAT_PAGE_SIZE);
  }, [roomHistory, chat, officeRoom]);

  const hasMore = roomHasMore[officeRoom] ?? false;
  const loading = roomLoading[officeRoom] ?? false;

  const bodyRef = useRef<HTMLDivElement>(null);
  // Bottom-stick + prepend anchoring. When older messages load in above, the scroll position must hold
  // on the same content (else the view yanks up); when a new message arrives at the bottom (or the room
  // first opens) we follow it — but only if the user was already near the bottom, so scrolling up to read
  // history isn't fought by every incoming line.
  const stickBottom = useRef(true);
  const prevRoom = useRef(officeRoom);
  const prevFirstId = useRef<string | undefined>(undefined);
  const prevScrollHeight = useRef(0);

  useLayoutEffect(() => {
    const el = bodyRef.current;
    if (!el) return;
    const firstId = messages[0]?.id;
    const roomChanged = prevRoom.current !== officeRoom;
    // A true older-page prepend keeps the previous top message in the list (older rows added above it).
    // If the previous top is gone, the list was trimmed/replaced from the top (e.g. the initial snapshot
    // placeholder giving way to the real newest page) — that must NOT be anchored, or it fights the bottom.
    const prevTopStillPresent = prevFirstId.current !== undefined && messages.some((m) => m.id === prevFirstId.current);
    const prepended = !roomChanged && firstId !== prevFirstId.current && prevTopStillPresent;

    if (roomChanged) {
      el.scrollTop = el.scrollHeight; // fresh room: land at the newest message
      stickBottom.current = true;
    } else if (prepended) {
      el.scrollTop += el.scrollHeight - prevScrollHeight.current; // hold position across the older page
    } else if (stickBottom.current) {
      el.scrollTop = el.scrollHeight; // new bottom message and we were following along
    }

    prevRoom.current = officeRoom;
    prevFirstId.current = firstId;
    prevScrollHeight.current = el.scrollHeight;
  }, [messages, officeRoom]);

  const onScroll = () => {
    const el = bodyRef.current;
    if (!el) return;
    stickBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    if (el.scrollTop < 80 && hasMore && !loading) loadMoreRoom(officeRoom);
  };

  // Project rooms with ≥2 participants are the real collaborations worth a tab; the general room is
  // always shown. A participant may be a machine on the far side of the online office — see
  // isCollaborationRoom.
  const projectRooms = rooms.filter(isCollaborationRoom);

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
                title={roomTabTitle(r)}
              >
                {/* Participants, not local tasks: a room whose conversation is entirely cross-machine has
                    no local task in it and used to render a bare "0". */}
                {leaf(r.workspace)} <span className="office-tab-n">{r.threadIds.length + r.remoteInstances.length}</span>
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
        {/* The "earlier messages" hint sits OUTSIDE the scroll container so its mount/unmount (when the
            room becomes fully loaded) never shifts the scroll anchor mid-prepend. */}
        {hasMore ? (
          <div className="office-more">{loading ? "Loading earlier messages…" : "Scroll up for earlier messages"}</div>
        ) : null}
        <div className="office-msgs" ref={bodyRef} onScroll={onScroll}>
          {messages.length === 0 ? (
            <div className="office-empty">No messages yet{officeRoom === GENERAL_ROOM ? "" : " — they just grouped up"}.</div>
          ) : (
            messages.map((m) => (
              <OfficeMsg
                key={m.id}
                m={m}
                title={m.threadId ? threads[m.threadId]?.title : undefined}
                name={
                  m.senderName ||
                  (m.role === "director"
                    ? directorName
                    : m.threadId && m.role !== "system"
                      ? agentName(nameOverrides, m.threadId, m.role)
                      : undefined)
                }
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
    <div className={"office-msg" + (m.remoteInstance ? " remote" : "")} style={{ "--role": roleColor(role) } as CSSProperties}>
      <Gnome role={role} size={22} />
      <div className="office-msg-main">
        <div className="office-msg-head">
          <span className="office-msg-role" style={{ color: roleColor(role) }}>
            {name ?? role}
          </span>
          <span className="office-msg-kind">{role}</span>
          {/* The sender name already reads "Rune @ Mikkel's box"; this is the at-a-glance marker that the
              line crossed the internet, so a room's cross-machine half is visible without reading names. */}
          {m.remoteInstance ? <span className="office-msg-remote" title={`From ${m.remoteInstance} — another machine`}>🌐</span> : null}
          {title ? <span className="office-msg-task">on “{trim(title, 32)}”</span> : null}
          <span className="office-msg-ts">{clock(m.createdAt)}</span>
        </div>
        <Markdown className="office-msg-body" text={m.body} />
      </div>
    </div>
  );
}
