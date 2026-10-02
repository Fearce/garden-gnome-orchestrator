import { randomUUID } from "node:crypto";
import type { Db } from "../../db/db.js";
import type { ClientFrame, RelayShareErrorCode, RelayShareMessage, RelaySharePresent, RelayShareUsage, ServerFrame } from "../onlineProtocol.js";

/** The only frames Director sharing ever sends. */
export type ShareClientFrame = Extract<ClientFrame, { t: "share.call" | "share.reply" | "share.cancel" }>;

const KV_SELECTION = "director_shared_selection_v1";
/** The recipient's own bound on one shared call, a little past the donor's provider timeout so the
 *  donor's own (more specific) failure normally arrives first. */
const CALL_TIMEOUT_MS = 6 * 60_000;

/** The shared capacity the owner of THIS console picked as their Director. A snapshot of the offer at
 *  selection time, refreshed whenever the donor re-announces it (a moved deadline). It authorises
 *  nothing: the donor decides every call. */
export interface SharedDirectorSelection {
  instanceId: string;
  shareId: string;
  instanceName: string;
  donorName: string;
  providerLabel: string;
  model: string;
  expiresAt: number;
  selectedAt: number;
}

export type SharedDirectorAvailability =
  | "available"
  | "busy" // the donor reports every slot in use
  | "expired"
  | "withdrawn" // the donor is online but no longer offers this share
  | "donor-offline"
  | "office-offline" // this console is not connected to the office
  | "relay-unsupported";

export type ShareCallResult =
  | { ok: true; text: string; usage?: RelayShareUsage }
  | { ok: false; code: RelayShareErrorCode; message: string };

interface PendingCall {
  donor: string;
  resolve: (r: ShareCallResult) => void;
  timer: ReturnType<typeof setTimeout>;
}

export interface DirectorShareClientDeps {
  db: Db;
  send: (frame: ShareClientFrame) => boolean;
  /** Office connected AND the relay routes sharing frames. */
  relayState: () => "office-offline" | "relay-unsupported" | "ready";
  /** Whether a donor instance is connected to the office at all (its director is on the roster). */
  instanceOnline: (instanceId: string) => boolean;
  changed: () => void;
  now?: () => number;
}

/**
 * The recipient half of Director sharing: what other consoles offer, which one (if any) the owner chose,
 * and the request/reply plumbing for a call. Selection is explicit and sticky. Nothing here ever falls
 * back to a private subscription; a shared Director that is unavailable says so and stops.
 */
export class DirectorShareClient {
  private offersNow: RelaySharePresent[] = [];
  private readonly pending = new Map<string, PendingCall>();
  private readonly now: () => number;

  constructor(private readonly deps: DirectorShareClientDeps) {
    this.now = deps.now ?? (() => Date.now());
  }

  /** The relay's current list. Expired entries are dropped here as well, so a cached roster from before
   *  the deadline never lists capacity the donor would refuse. */
  setOffers(offers: RelaySharePresent[] | undefined): void {
    if (!offers) return;
    this.offersNow = offers.filter((o) => o.expiresAt > this.now());
    const sel = this.selection();
    const fresh = sel && this.offersNow.find((o) => o.instanceId === sel.instanceId && o.shareId === sel.shareId);
    if (sel && fresh && (fresh.expiresAt !== sel.expiresAt || fresh.donorName !== sel.donorName || fresh.instanceName !== sel.instanceName)) {
      this.persistSelection({ ...sel, expiresAt: fresh.expiresAt, donorName: fresh.donorName, instanceName: fresh.instanceName });
    }
    this.deps.changed();
  }

  offers(): RelaySharePresent[] {
    const now = this.now();
    return this.offersNow.filter((o) => o.expiresAt > now);
  }

  selection(): SharedDirectorSelection | null {
    try {
      const raw = this.deps.db.kvGet(KV_SELECTION);
      return raw ? (JSON.parse(raw) as SharedDirectorSelection) : null;
    } catch {
      return null;
    }
  }

  /** Choose a currently offered, unexpired share as this console's Director. */
  select(instanceId: string, shareId: string): { ok: true } | { ok: false; error: string } {
    const offer = this.offers().find((o) => o.instanceId === instanceId && o.shareId === shareId);
    if (!offer) return { ok: false, error: "That shared Director is no longer offered." };
    this.persistSelection({
      instanceId,
      shareId,
      instanceName: offer.instanceName,
      donorName: offer.donorName,
      providerLabel: offer.providerLabel,
      model: offer.model,
      expiresAt: offer.expiresAt,
      selectedAt: this.now(),
    });
    this.deps.changed();
    return { ok: true };
  }

  /** Go back to this console's own subscriptions. */
  clearSelection(): void {
    this.deps.db.kvDelete(KV_SELECTION);
    this.deps.changed();
  }

  availability(sel = this.selection()): SharedDirectorAvailability | null {
    if (!sel) return null;
    if (sel.expiresAt <= this.now()) return "expired";
    const relay = this.deps.relayState();
    if (relay !== "ready") return relay;
    const offer = this.offers().find((o) => o.instanceId === sel.instanceId && o.shareId === sel.shareId);
    if (!offer) return this.deps.instanceOnline(sel.instanceId) ? "withdrawn" : "donor-offline";
    return offer.inFlight >= offer.maxConcurrent ? "busy" : "available";
  }

  /**
   * Send one model call to the selected share and wait for the donor's answer. Refused locally, without
   * a round trip, when this console already knows the call cannot succeed. `busy` is not one of those:
   * the in-flight count it sees is a snapshot, so the donor decides.
   */
  call(messages: RelayShareMessage[], signal?: AbortSignal): Promise<ShareCallResult> {
    const sel = this.selection();
    if (!sel) return Promise.resolve({ ok: false, code: "not-shared", message: "No shared Director is selected." });
    const state = this.availability(sel);
    if (state && state !== "available" && state !== "busy") {
      return Promise.resolve({ ok: false, code: state === "expired" ? "expired" : state === "withdrawn" ? "not-shared" : "offline", message: availabilityText(state, sel) });
    }
    const callId = randomUUID();
    return new Promise<ShareCallResult>((resolve) => {
      const finish = (r: ShareCallResult): void => {
        const p = this.pending.get(callId);
        if (!p) return;
        clearTimeout(p.timer);
        this.pending.delete(callId);
        signal?.removeEventListener("abort", onAbort);
        resolve(r);
      };
      const onAbort = (): void => {
        this.deps.send({ t: "share.cancel", to: sel.instanceId, callId });
        finish({ ok: false, code: "cancelled", message: "The call was cancelled." });
      };
      const timer = setTimeout(() => {
        this.deps.send({ t: "share.cancel", to: sel.instanceId, callId });
        finish({ ok: false, code: "timeout", message: "The shared Director did not answer in time." });
      }, CALL_TIMEOUT_MS);
      timer.unref?.();
      this.pending.set(callId, { donor: sel.instanceId, resolve: finish, timer });
      if (signal?.aborted) return onAbort();
      signal?.addEventListener("abort", onAbort, { once: true });
      const sent = this.deps.send({ t: "share.call", to: sel.instanceId, callId, shareId: sel.shareId, messages });
      if (!sent) finish({ ok: false, code: "offline", message: "This console is not connected to the online office." });
    });
  }

  /** A donor's answer. Accepted only for a call this console made, to that same donor. */
  handleReply(frame: Extract<ServerFrame, { t: "share.reply" }>): void {
    const p = this.pending.get(frame.callId);
    if (!p || p.donor !== frame.from) return;
    if (frame.ok) p.resolve({ ok: true, text: frame.text ?? "", usage: frame.usage });
    else p.resolve({ ok: false, code: frame.code ?? "provider-error", message: frame.message || "The shared Director failed." });
  }

  /** The office connection dropped: nothing in flight can be answered any more. */
  disconnected(): void {
    for (const p of [...this.pending.values()]) p.resolve({ ok: false, code: "offline", message: "The connection to the online office dropped." });
    this.offersNow = [];
    this.deps.changed();
  }

  dispose(): void {
    for (const p of [...this.pending.values()]) p.resolve({ ok: false, code: "cancelled", message: "The server is shutting down." });
  }

  private persistSelection(sel: SharedDirectorSelection): void {
    this.deps.db.kvSet(KV_SELECTION, JSON.stringify(sel));
  }
}

/** One plain sentence for each availability state, used by the Director's notes and the settings panel. */
export function availabilityText(state: SharedDirectorAvailability, sel: SharedDirectorSelection): string {
  const who = `${sel.donorName} on ${sel.instanceName}`;
  switch (state) {
    case "available":
      return `Shared by ${who}.`;
    case "busy":
      return `${who} reports every shared slot in use right now.`;
    case "expired":
      return `The Director shared by ${who} expired at ${new Date(sel.expiresAt).toISOString()}.`;
    case "withdrawn":
      return `${who} is no longer sharing this Director.`;
    case "donor-offline":
      return `${sel.instanceName} is not connected to the online office.`;
    case "office-offline":
      return "This console is not connected to the online office.";
    case "relay-unsupported":
      return "The office relay does not support Director sharing yet.";
  }
}
