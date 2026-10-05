import { useMemo } from "react";
import { useStore } from "../store.js";
import { agentName, DIRECTORS_ROOM, GENERAL_ROOM, homeWorkspace, normalizeWorkspace, repoRoom, ROLES, type Role } from "../types.js";
import { Gnome } from "./Gnome.js";
import { roleColor } from "../lib/format.js";

interface Member {
  id: string;
  name: string;
  role: Role;
  status: string;
  task: string;
  threadId?: string;
  machine?: string;
}

/** Presence comes from current runs, never the participants retained in chat history. */
export function OfficeRoster({ room, onOpenTask }: { room: string; onOpenTask: (id: string) => void }) {
  const runs = useStore((s) => s.runs);
  const threads = useStore((s) => s.threads);
  const names = useStore((s) => s.nameOverrides);
  const directorName = useStore((s) => s.settings.directorName);
  const directorBusy = useStore((s) => s.directorBusy);
  const online = useStore((s) => s.onlineOffice);
  const members = useMemo<Member[]>(() => {
    if (room === DIRECTORS_ROOM) return [{
      id: "director", name: directorName, role: "director", status: directorBusy ? "Working" : "Standing by", task: "This office",
    }, ...(online.state === "online" ? online.directors.map((d): Member => ({
      id: d.instanceId, name: d.name, role: "director", status: d.busy === undefined ? "Online" : d.busy ? "Working" : "Standing by", task: d.instanceName, machine: d.instanceName,
    })) : [])];

    const latest = new Map<string, typeof runs[string]>();
    for (const run of Object.values(runs)) {
      if (run.state !== "starting" && run.state !== "running") continue;
      const previous = latest.get(run.threadId);
      if (!previous || previous.startedAt <= run.startedAt) latest.set(run.threadId, run);
    }
    const local: Member[] = [];
    for (const run of latest.values()) {
      const thread = threads[run.threadId];
      if (!thread || (room !== GENERAL_ROOM && repoRoom(homeWorkspace(thread)) !== room)) continue;
      local.push({ id: run.threadId, threadId: run.threadId, name: agentName(names, run.threadId, run.role), role: run.role, status: run.state === "starting" ? "Starting" : "Working", task: thread.title });
    }
    // General chat is local; only repository rooms connect agents across machines.
    const shared = online.sharedRepos.find((repo) => repo.workspaces.some((ws) => repoRoom(normalizeWorkspace(ws)) === room));
    const remote = room !== GENERAL_ROOM && shared && online.state === "online"
      ? online.remoteAgents.filter((agent) => agent.repoKey === shared.repoKey)
      : [];
    const seen = new Set<string>();
    for (const agent of remote) {
      const id = `remote:${agent.instanceId}:${agent.key}`;
      if (seen.has(id)) continue;
      seen.add(id);
      local.push({ id, name: agent.name, role: ROLES.includes(agent.role as Role) ? agent.role as Role : "implementor", status: "Working", task: agent.title, machine: agent.instanceName });
    }
    return local;
  }, [room, runs, threads, names, directorName, directorBusy, online]);

  const directors = room === DIRECTORS_ROOM;
  return <section className="office-roster" aria-label="Office presence">
    <div className="office-roster-summary" role="status">
      <span className={"office-presence-dot" + (members.length ? " active" : "")} />
      <strong>{members.length} {directors ? members.length === 1 ? "director" : "directors" : members.length === 1 ? "gnome" : "gnomes"} {directors ? "in the office" : "working here"}</strong>
      {room !== GENERAL_ROOM && online.joined && online.state !== "online" ? <span className="office-roster-offline">Remote presence unavailable</span> : null}
    </div>
    {members.length ? <ul className="office-roster-list">{members.map((member) => {
      const content = <>
        <Gnome role={member.role} size={26} />
        <span className="office-roster-person"><strong style={{ color: roleColor(member.role) }}>{member.name}</strong><span className="office-roster-task">{member.task}</span><span className="office-roster-meta">{member.role}{member.machine ? ` · Remote · ${member.machine}` : " · This office"}</span></span>
        <span className={"office-roster-state" + (member.status === "Working" ? " working" : "")}>{member.status}</span>
      </>;
      return <li key={member.id}>{member.threadId
        ? <button className="office-roster-member" onClick={() => onOpenTask(member.threadId!)} title={`Open task: ${member.task}`}>{content}</button>
        : <div className="office-roster-member">{content}</div>}</li>;
    })}</ul> : <p className="office-roster-empty">No gnomes are working here right now. The conversation stays available.</p>}
  </section>;
}
