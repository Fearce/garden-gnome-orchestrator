import { WebSocket } from "ws";
import type { Db } from "../db/db.js";
import type { EventHub } from "../events.js";
import { OFFICE_ROOM, RELAY_PROTOCOL, relayRepoRoom } from "./onlineProtocol.js";
import type { ClientFrame, JoinResponse, RelayAgent, RelayChat, RelayPresentAgent, ServerFrame } from "./onlineProtocol.js";
import { repoIdentity, type RepoIdentity } from "./repoIdentity.js";

/** How the console sees the online office. The token is never part of this — only whether one is held. */
export interface OnlineOfficeDTO {
  enabled: boolean;
  url: string;
  instanceName: string;
  joined: boolean; // a device token is held (Join has been done at least once)
  state: "off" | "connecting" | "online" | "error";
  error: string | null;
  connectedAt: number | null;
  /** Agents on OTHER machines, as last reported by the relay. */
  remoteAgents: RelayPresentAgent[];
  /** Repositories this instance and at least one other machine are both working right now. */
  sharedRepos: SharedRepo[];
}

/** A repository whose work is split across machines — the collaboration the office exists for. The local
 *  `workspaces` are what let the console line a remote agent up with the checkout it collides with, which
 *  a repo label alone cannot do: the two sides agree on the remote, never on the path. */
export interface SharedRepo {
  repoKey: string;
  repoLabel: string;
  workspaces: string[];
}

/** One local agent the instance advertises, before its repo identity is resolved. */
export interface LocalAgentSnapshot {
  key: string;
  name: string;
  role: string;
  title: string;
  workspace: string;
}

export interface OnlineOfficeDeps {
  db: Db;
  hub: EventHub;
  /** The agents this instance has working right now (ThreadManager's live set). */
  roster: () => LocalAgentSnapshot[];
  /** A coordination line from another machine, already scoped to a room. */
  onRemoteChat: (msg: RelayChat, workspaces: string[]) => void;
  /** The remote roster changed: agents that appeared in a repo THIS instance is also working. */
  onRemoteJoin: (repoLabel: string, workspaces: string[], joiners: RelayPresentAgent[]) => void;
}

const KV = {
  enabled: "online_office_enabled",
  url: "online_office_url",
  name: "online_office_name",
  token: "online_office_token",
  instanceId: "online_office_instance_id",
} as const;

const PRESENCE_MS = 15_000;
const RECONNECT_MIN_MS = 2_000;
const RECONNECT_MAX_MS = 60_000;

/**
 * This instance's half of the Online Office: one authenticated WebSocket to the relay, over which it
 * advertises the agents it has working and receives everyone else's.
 *
 * Standalone by design — it depends on `Db`, `EventHub` and three callbacks, never on ThreadManager, so
 * the pipeline stays untouched and a concurrent edit to threadManager can't collide with it (the same
 * shape as `orchestrator/notes.ts` and `orchestrator/scheduler.ts`).
 *
 * Failure is always soft. No token, a relay that is down, a revoked device: the office simply reports
 * itself offline and every local pipeline runs exactly as it did before the feature existed.
 */
export class OnlineOffice {
  private ws: WebSocket | null = null;
  private state: OnlineOfficeDTO["state"] = "off";
  private error: string | null = null;
  private connectedAt: number | null = null;
  private remote: RelayPresentAgent[] = [];
  private lastPresence = "";
  private reconnectDelay = RECONNECT_MIN_MS;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private presenceTimer: ReturnType<typeof setInterval> | undefined;
  private disposed = false;
  /** Resolved repo identity per workspace, so the (async, git-backed) lookup never blocks a chat post. */
  private readonly identities = new Map<string, RepoIdentity>();

  constructor(private readonly deps: OnlineOfficeDeps) {}

  // ---- lifecycle ------------------------------------------------------------------------------------

  /** Connect if the office is switched on and this instance has a device token. Safe to call always. */
  start(): void {
    this.presenceTimer = setInterval(() => void this.publishPresence(), PRESENCE_MS);
    this.presenceTimer.unref?.();
    if (this.enabled() && this.token()) this.connect();
    else this.setState("off", null);
  }

  dispose(): void {
    this.disposed = true;
    if (this.presenceTimer) clearInterval(this.presenceTimer);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.closeSocket();
  }

  // ---- the operator's two buttons -------------------------------------------------------------------

  /**
   * Exchange a join code for this instance's durable device token, then connect. This is the ONLY time
   * a human types a secret: the token is kept locally and slid forward on every connect, so the office
   * is a one-time setup rather than a recurring login.
   */
  async join(input: { url: string; code: string; instanceName: string }): Promise<{ ok: boolean; error?: string }> {
    const base = normalizeRelayUrl(input.url);
    if (!base) return { ok: false, error: "That doesn't look like a relay URL — use https://office.example.com" };
    const name = input.instanceName.trim().slice(0, 40) || "an orchestrator";
    let answer: JoinResponse;
    try {
      const res = await fetch(`${base}/api/join`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code: input.code, name }),
        signal: AbortSignal.timeout(15_000),
      });
      const body = (await res.json().catch(() => ({}))) as Partial<JoinResponse> & { error?: string };
      if (!res.ok) return { ok: false, error: body.error || `The relay refused the join (HTTP ${res.status}).` };
      if (!body.token || !body.instanceId) return { ok: false, error: "The relay's answer was missing a token." };
      answer = body as JoinResponse;
    } catch (e) {
      // `fetch` reports every transport failure as the same useless "fetch failed"; the actionable part
      // (ECONNREFUSED, ENOTFOUND, a TLS complaint) is only on `cause`.
      const err = e as Error & { cause?: Error };
      const why = err.cause?.message ? `${err.message} (${err.cause.message})` : err.message;
      return { ok: false, error: `Couldn't reach the relay: ${why}` };
    }
    if (answer.protocol !== RELAY_PROTOCOL) {
      return { ok: false, error: `Relay speaks protocol v${answer.protocol}, this console speaks v${RELAY_PROTOCOL} — update one of them.` };
    }
    this.deps.db.kvSet(KV.url, base);
    this.deps.db.kvSet(KV.name, name);
    this.deps.db.kvSet(KV.token, answer.token);
    this.deps.db.kvSet(KV.instanceId, answer.instanceId);
    this.deps.db.kvSet(KV.enabled, "1");
    this.deps.hub.log("info", `Online office: joined "${base}" as "${name}".`);
    this.reconnectDelay = RECONNECT_MIN_MS;
    this.connect();
    return { ok: true };
  }

  /** Leave the office: disconnect and forget the device token. Re-joining needs the code again — which
   *  is the point, since "leave" is what the owner clicks when a machine should no longer be in. */
  leave(): void {
    this.deps.db.kvSet(KV.enabled, "0");
    this.deps.db.kvSet(KV.token, "");
    this.deps.db.kvSet(KV.instanceId, "");
    this.remote = [];
    this.closeSocket();
    this.setState("off", null);
    this.deps.hub.log("info", "Online office: left.");
  }

  /** Toggle presence without giving up the token — going offline for an afternoon. */
  setEnabled(on: boolean): void {
    this.deps.db.kvSet(KV.enabled, on ? "1" : "0");
    if (on && this.token()) this.connect();
    else {
      this.remote = [];
      this.closeSocket();
      this.setState("off", null);
    }
  }

  /** Rename this instance as everyone else sees it; takes effect on the next connect. */
  setInstanceName(name: string): void {
    const clean = name.trim().slice(0, 40);
    if (!clean || clean === this.instanceName()) return;
    this.deps.db.kvSet(KV.name, clean);
    if (this.state === "online") this.reconnect(0);
    else this.broadcast();
  }

  // ---- what ThreadManager asks it -------------------------------------------------------------------

  status(): OnlineOfficeDTO {
    return {
      enabled: this.enabled(),
      url: this.deps.db.kvGet(KV.url) ?? "",
      instanceName: this.instanceName(),
      joined: !!this.token(),
      state: this.state,
      error: this.error,
      connectedAt: this.connectedAt,
      remoteAgents: this.remote,
      sharedRepos: this.sharedReposNow(),
    };
  }

  /** Remote agents working the same repository as this workspace — the cross-machine half of
   *  `repoPeers`. Sync (the local office gate is sync) and therefore answers from the identity cache;
   *  an unresolved workspace schedules its own lookup and answers on the next tick. */
  remotePeers(workspace: string): RelayPresentAgent[] {
    const id = this.identityFor(workspace);
    if (!id) return [];
    return this.remote.filter((a) => a.repoKey === id.key);
  }

  /** Local workspaces that map to a relay room — how an incoming remote message finds the local repo
   *  it belongs to. The office room maps to every workspace this instance currently has live. */
  workspacesForRoom(room: string, candidates: string[]): string[] {
    if (room === OFFICE_ROOM) return candidates;
    return candidates.filter((ws) => {
      const id = this.identityFor(ws);
      return !!id && relayRepoRoom(id.key) === room;
    });
  }

  /** Publish a local office post to the relay. Fire-and-forget: the local copy is already persisted and
   *  the office must never be able to fail a chat_post. */
  postChat(input: { workspace: string | null; body: string; senderName: string; role: string }): void {
    if (this.state !== "online") return;
    void this.resolveIdentity(input.workspace).then((id) => {
      const room = input.workspace && id ? relayRepoRoom(id.key) : OFFICE_ROOM;
      this.send({ t: "chat", room, body: input.body, senderName: input.senderName, role: input.role, repoLabel: id?.label ?? null });
    });
  }

  /** Re-advertise this instance's agents right now — called when one starts or ends, so a teammate sees
   *  a new worker in seconds rather than at the next presence tick. */
  refreshPresence(): void {
    void this.publishPresence();
  }

  // ---- connection -----------------------------------------------------------------------------------

  private connect(): void {
    if (this.disposed) return;
    const base = this.deps.db.kvGet(KV.url) ?? "";
    const token = this.token();
    if (!base || !token) return this.setState("off", null);
    this.closeSocket();
    this.setState("connecting", null);
    const ws = new WebSocket(`${base.replace(/^http/, "ws")}/ws`, {
      headers: { authorization: `Bearer ${token}`, "x-office-instance": this.instanceName() },
      handshakeTimeout: 15_000,
    });
    this.ws = ws;

    ws.on("open", () => {
      this.reconnectDelay = RECONNECT_MIN_MS;
      this.connectedAt = Date.now();
      this.setState("online", null);
      this.lastPresence = "";
      void this.publishPresence();
    });
    ws.on("message", (data) => this.onFrame(String(data)));
    ws.on("unexpected-response", (_req, res) => {
      // The relay says the door is shut. A 401 is terminal — retrying forever against a revoked or
      // lapsed token just burns the connection and hides the one thing the owner has to act on.
      if (res.statusCode === 401) {
        this.deps.db.kvSet(KV.token, "");
        this.setState("error", "This machine is no longer joined — re-join with a fresh code in Settings.");
        this.closeSocket();
        return;
      }
      this.failAndRetry(`relay answered HTTP ${res.statusCode}`);
    });
    ws.on("error", (e) => this.failAndRetry((e as Error).message));
    ws.on("close", () => {
      if (this.ws !== ws) return; // a socket we already replaced
      this.ws = null;
      this.connectedAt = null;
      if (this.state === "error" || !this.enabled()) return;
      this.failAndRetry("connection closed");
    });
  }

  private onFrame(raw: string): void {
    let frame: ServerFrame;
    try {
      frame = JSON.parse(raw) as ServerFrame;
    } catch {
      return;
    }
    switch (frame.t) {
      case "welcome":
        if (frame.protocol !== RELAY_PROTOCOL) {
          this.setState("error", `Relay speaks protocol v${frame.protocol}, this console speaks v${RELAY_PROTOCOL}.`);
          this.closeSocket();
          return;
        }
        // The relay is the authority on which instance this connection is; a token re-issued under a new
        // id would otherwise leave the self-filter below matching nothing.
        if (frame.instanceId) this.deps.db.kvSet(KV.instanceId, frame.instanceId);
        this.applyPresence(frame.presence);
        return;
      case "presence":
        this.applyPresence(frame.agents);
        return;
      case "history":
        // The backlog of a room we just entered: deliver it like live traffic so a fresh agent reads
        // what its remote teammates already claimed. Ordering is the relay's (chronological).
        for (const msg of frame.messages) this.deliverChat(msg);
        return;
      case "chat":
        this.deliverChat(frame.msg);
        return;
      case "error":
        this.deps.hub.log("warn", `Online office: relay rejected a frame — ${frame.message}`);
        return;
      case "pong":
        return;
    }
  }

  private deliverChat(msg: RelayChat): void {
    if (this.isSelf(msg.instanceId)) return;
    const mine = this.deps.roster().map((a) => a.workspace);
    const workspaces = [...new Set(this.workspacesForRoom(msg.room, mine))];
    this.deps.onRemoteChat(msg, workspaces);
  }

  /** Whether a frame came from THIS instance. The relay already withholds an instance's own traffic, but
   *  the relay is shared infrastructure on someone else's deploy cadence — and the cost of trusting it is
   *  not a duplicate row: a self-echo makes a solo agent look like it has a teammate, which is the switch
   *  that turns the whole office on. So the receiving side refuses it too, and an unknown id (never
   *  joined, or the welcome frame not yet in) is treated as someone else, never as self. */
  private isSelf(instanceId: string): boolean {
    const mine = this.deps.db.kvGet(KV.instanceId) ?? "";
    return !!mine && instanceId === mine;
  }

  /** Fold a new remote roster in, and tell the caller about agents that just appeared in a repo THIS
   *  instance is also working — the cross-machine equivalent of `ensureGroup`'s activation push. */
  private applyPresence(agents: RelayPresentAgent[]): void {
    const before = new Set(this.remote.map((a) => `${a.instanceId}:${a.key}`));
    this.remote = agents.filter((a) => !this.isSelf(a.instanceId));
    this.broadcast();
    // Diff against the FILTERED roster — a joiner is only ever someone else's agent.
    const joiners = this.remote.filter((a) => !before.has(`${a.instanceId}:${a.key}`));
    if (!joiners.length) return;
    const mine = this.deps.roster();
    const byRepo = new Map<string, RelayPresentAgent[]>();
    for (const j of joiners) {
      const shared = mine.filter((m) => this.identityFor(m.workspace)?.key === j.repoKey).map((m) => m.workspace);
      if (!shared.length) continue;
      byRepo.set(j.repoKey, [...(byRepo.get(j.repoKey) ?? []), j]);
    }
    for (const [repoKey, list] of byRepo) {
      const workspaces = [...new Set(mine.filter((m) => this.identityFor(m.workspace)?.key === repoKey).map((m) => m.workspace))];
      this.deps.onRemoteJoin(list[0]?.repoLabel || repoKey, workspaces, list);
    }
  }

  private async publishPresence(): Promise<void> {
    if (this.state !== "online") return;
    const local = this.deps.roster();
    const agents: RelayAgent[] = [];
    for (const a of local) {
      const id = await this.resolveIdentity(a.workspace);
      if (!id) continue; // a workspace that isn't a repo has no cross-machine identity to share
      agents.push({ key: a.key, name: a.name, role: a.role, title: a.title, repoKey: id.key, repoLabel: id.label });
    }
    const fingerprint = JSON.stringify(agents);
    if (fingerprint === this.lastPresence) return;
    this.lastPresence = fingerprint;
    this.send({ t: "presence", agents });
  }

  private send(frame: ClientFrame): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(frame));
  }

  private failAndRetry(reason: string): void {
    if (this.disposed || !this.enabled()) return;
    this.setState("connecting", reason);
    this.reconnect(this.reconnectDelay);
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, RECONNECT_MAX_MS);
  }

  private reconnect(delayMs: number): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => this.connect(), delayMs);
    this.reconnectTimer.unref?.();
  }

  private closeSocket(): void {
    const ws = this.ws;
    this.ws = null;
    this.connectedAt = null;
    if (!ws) return;
    ws.removeAllListeners();
    // `ws` EMITS on a close during the handshake ("closed before the connection was established"), and a
    // socket we just stripped of listeners has nobody to catch an `error` — which in Node is a process
    // kill, not a warning. So: keep a sink attached, and never send a graceful close to a socket that
    // has no open connection to close (the revoked-device path, where the relay 401s the upgrade).
    ws.on("error", () => {});
    try {
      if (ws.readyState === WebSocket.OPEN) ws.close();
      else ws.terminate();
    } catch {
      /* already gone */
    }
  }

  // ---- repo identity --------------------------------------------------------------------------------

  private identityFor(workspace: string): RepoIdentity | null {
    const hit = this.identities.get(workspace);
    if (hit) return hit;
    void this.resolveIdentity(workspace); // warm it for the next call — a git read must not block the gate
    return null;
  }

  private async resolveIdentity(workspace: string | null): Promise<RepoIdentity | null> {
    if (!workspace) return null;
    const hit = this.identities.get(workspace);
    if (hit) return hit;
    const id = await repoIdentity(workspace);
    if (id) this.identities.set(workspace, id);
    return id;
  }

  // ---- state ----------------------------------------------------------------------------------------

  private sharedReposNow(): SharedRepo[] {
    const remoteKeys = new Set(this.remote.map((a) => a.repoKey));
    const byKey = new Map<string, SharedRepo>();
    for (const a of this.deps.roster()) {
      const id = this.identityFor(a.workspace);
      if (!id || !remoteKeys.has(id.key)) continue;
      const e = byKey.get(id.key) ?? { repoKey: id.key, repoLabel: id.label, workspaces: [] };
      if (!e.workspaces.includes(a.workspace)) e.workspaces.push(a.workspace);
      byKey.set(id.key, e);
    }
    return [...byKey.values()];
  }

  private setState(state: OnlineOfficeDTO["state"], error: string | null): void {
    if (this.state === state && this.error === error) return;
    this.state = state;
    this.error = error;
    this.broadcast();
  }

  private broadcast(): void {
    this.deps.hub.publish({ type: "office.online", office: this.status() });
  }

  private enabled(): boolean {
    return this.deps.db.kvGet(KV.enabled) === "1";
  }

  private token(): string {
    return this.deps.db.kvGet(KV.token) ?? "";
  }

  private instanceName(): string {
    return this.deps.db.kvGet(KV.name) ?? "an orchestrator";
  }
}

/** Accept what a human would paste — `office.example.com`, a `wss://` URL, a trailing slash — and
 *  return the canonical `https://host[:port][/path]` base, or null when it isn't usable. */
export function normalizeRelayUrl(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const withScheme = /^[a-z]+:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    return null;
  }
  const scheme = url.protocol === "ws:" || url.protocol === "http:" ? "http:" : "https:";
  if (!url.hostname) return null;
  url.protocol = scheme;
  url.hash = "";
  url.search = "";
  url.pathname = url.pathname.replace(/\/+$/, "");
  return url.toString().replace(/\/+$/, "");
}
