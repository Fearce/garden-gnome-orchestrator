import { randomUUID } from "node:crypto";
import type { Db } from "../../db/db.js";
import { SHARE_CALL_MAX_CHARS, SHARE_REPLY_MAX_CHARS } from "../onlineProtocol.js";
import type { RelayShareErrorCode, RelayShareMessage, RelayShareOffer, ServerFrame } from "../onlineProtocol.js";
import type { ShareClientFrame } from "./client.js";
import type { DirectorShareSubscription, ShareableEndpoint } from "./policy.js";
import { callChatCompletion, isChatModelId, listChatModels, type ShareFetch } from "./providerCall.js";

const KV_SHARES = "director_shares_v1";
/** Nobody shares open-ended: a deadline further out than this is refused. */
export const SHARE_MAX_HORIZON_MS = 30 * 24 * 60 * 60_000;
/** A deadline must leave at least this long, so a share does not expire while the form is still open. */
export const SHARE_MIN_LEAD_MS = 60_000;
export const SHARE_MAX_CONCURRENT = 4;
export const SHARE_MAX_REQUESTS_PER_HOUR = 600;
const HOUR_MS = 60 * 60_000;
/** setTimeout's ceiling is ~24.8 days; re-arming at least this often also absorbs clock adjustments. */
const MAX_TIMER_MS = 6 * HOUR_MS;
const MAX_RECIPIENTS_TRACKED = 50;

export type ShareStatus = "shared" | "stopped" | "expired";

export interface ShareUsage {
  requests: number;
  denied: number;
  inputTokens: number;
  outputTokens: number;
  lastUsedAt: number | null;
  recipients: Record<string, { name: string; requests: number; lastAt: number }>;
}

/** One subscription's durable sharing state. `shareId` is minted on every opt-in and never reused, so a
 *  call addressed to an earlier share (a stale discovery cache, a recipient session from before a stop or
 *  an expiry) can never ride a later one. */
export interface ShareRecord {
  subscriptionId: string;
  shareId: string;
  status: ShareStatus;
  model: string;
  expiresAt: number;
  timeZone: string;
  sharedAt: number;
  endedAt: number | null;
  maxConcurrent: number;
  maxRequestsPerHour: number;
  usage: ShareUsage;
  /** Start times of accepted calls within the last hour: the hourly request limit. */
  recentCalls: number[];
}

export interface DirectorShareView {
  subscription: DirectorShareSubscription;
  share: (Omit<ShareRecord, "recentCalls" | "subscriptionId"> & { inFlight: number; requestsLastHour: number }) | null;
}

export interface ShareTerms {
  expiresAt: number;
  timeZone: string;
  maxConcurrent: number;
  maxRequestsPerHour: number;
}

export type ShareOutcome = { ok: true } | { ok: false; error: string };

interface InFlight {
  key: string;
  from: string;
  callId: string;
  shareId: string;
  controller: AbortController;
  /** A reply has been sent (the share ended underneath it), or the caller cancelled. */
  settled: boolean;
}

export interface DirectorShareHostDeps {
  db: Db;
  subscriptions: () => DirectorShareSubscription[];
  endpoint: (subscriptionId: string) => ShareableEndpoint | undefined;
  /** Send a frame to the relay. False when the office is not connected. */
  send: (frame: ShareClientFrame) => boolean;
  /** Shares changed (status, deadline, in-flight count, usage): re-announce and re-render. */
  changed: () => void;
  fetch?: ShareFetch;
  now?: () => number;
  log?: (level: "info" | "warn", message: string) => void;
}

/**
 * The donor half of Director sharing. Every rule that protects the owner lives HERE, on the machine that
 * holds the key, and is checked per request against durable state: the relay and the recipient only ever
 * hold copies of an offer, and a copy can be stale.
 *
 * Expiry is a comparison, not an event. A share is live only while `now < expiresAt`, read at every call,
 * every reply and every view. The timer below only makes the transition prompt (cancel in-flight work,
 * re-announce). A missed timer cannot extend a share, whether the laptop slept or the server was down
 * across the deadline, because nothing consults the timer to decide.
 */
export class DirectorShareHost {
  private records: Record<string, ShareRecord>;
  private readonly inFlight = new Map<string, InFlight>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private readonly now: () => number;
  private readonly fetchImpl: ShareFetch;

  constructor(private readonly deps: DirectorShareHostDeps) {
    this.now = deps.now ?? (() => Date.now());
    this.fetchImpl = deps.fetch ?? ((url, init) => fetch(url, init));
    this.records = this.load();
  }

  /** Apply every expiry that happened while the server was down, then arm the deadline timer. */
  start(): void {
    this.sweep();
    this.arm();
  }

  dispose(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    for (const f of this.inFlight.values()) f.controller.abort();
    this.inFlight.clear();
  }

  // ---- the owner's controls ---------------------------------------------------------------------------

  /** A FRESH opt-in: a new share id, zeroed usage, a deadline that must lie in the future. Refused while
   *  the subscription is already shared (edit that share instead) and for anything not shareable. */
  share(subscriptionId: string, model: string, terms: ShareTerms): ShareOutcome {
    this.sweep();
    const sub = this.deps.subscriptions().find((s) => s.id === subscriptionId);
    if (!sub) return { ok: false, error: "That subscription is not connected." };
    if (!sub.shareable) return { ok: false, error: sub.reason };
    if (!this.deps.endpoint(subscriptionId)) return { ok: false, error: "That subscription has no usable API key." };
    if (this.records[subscriptionId]?.status === "shared") return { ok: false, error: "Already shared. Edit the deadline, or stop sharing first." };
    const cleanModel = model.trim();
    if (!/^[A-Za-z0-9._:/-]{1,80}$/.test(cleanModel)) return { ok: false, error: "Pick a model to share." };
    if (!isChatModelId(cleanModel)) return { ok: false, error: "This model cannot use the shared Director's chat-completions integration." };
    const bad = this.badTerms(terms);
    if (bad) return { ok: false, error: bad };
    const now = this.now();
    this.records[subscriptionId] = {
      subscriptionId,
      shareId: randomUUID(),
      status: "shared",
      model: cleanModel,
      expiresAt: terms.expiresAt,
      timeZone: cleanTimeZone(terms.timeZone),
      sharedAt: now,
      endedAt: null,
      maxConcurrent: terms.maxConcurrent,
      maxRequestsPerHour: terms.maxRequestsPerHour,
      usage: { requests: 0, denied: 0, inputTokens: 0, outputTokens: 0, lastUsedAt: null, recipients: {} },
      recentCalls: [],
    };
    this.deps.log?.("info", `Director sharing: ${sub.label} shared until ${new Date(terms.expiresAt).toISOString()}.`);
    this.commit();
    return { ok: true };
  }

  /** Change a LIVE share's deadline or limits. An expired or stopped share cannot be revived this way:
   *  sharing again is a fresh, explicit opt-in through `share`. */
  update(subscriptionId: string, terms: ShareTerms): ShareOutcome {
    this.sweep();
    const rec = this.records[subscriptionId];
    if (!rec || rec.status !== "shared") {
      return { ok: false, error: rec?.status === "expired" ? "This share has expired. Share it again to set a new deadline." : "This subscription is not shared." };
    }
    const bad = this.badTerms(terms);
    if (bad) return { ok: false, error: bad };
    rec.expiresAt = terms.expiresAt;
    rec.timeZone = cleanTimeZone(terms.timeZone);
    rec.maxConcurrent = terms.maxConcurrent;
    rec.maxRequestsPerHour = terms.maxRequestsPerHour;
    this.commit();
    return { ok: true };
  }

  /** Stop sharing now. In-flight calls are aborted and their callers told, immediately. */
  stop(subscriptionId: string): ShareOutcome {
    this.sweep();
    const rec = this.records[subscriptionId];
    if (!rec || rec.status !== "shared") return { ok: false, error: "This subscription is not shared." };
    rec.status = "stopped";
    rec.endedAt = this.now();
    this.abortShare(rec.shareId, "not-shared", "The donor stopped sharing this Director.");
    this.deps.log?.("info", `Director sharing: stopped sharing ${subscriptionId}.`);
    this.commit();
    return { ok: true };
  }

  async models(subscriptionId: string): Promise<{ ok: true; models: string[] } | { ok: false; error: string }> {
    const sub = this.deps.subscriptions().find((s) => s.id === subscriptionId);
    const endpoint = this.deps.endpoint(subscriptionId);
    if (!sub?.shareable || !endpoint) return { ok: false, error: "That subscription cannot be shared." };
    return listChatModels(this.fetchImpl, endpoint);
  }

  // ---- what the office and the console read -------------------------------------------------------------

  view(): DirectorShareView[] {
    this.sweep();
    const now = this.now();
    return this.deps.subscriptions().map((subscription) => {
      const rec = this.records[subscription.id];
      if (!rec) return { subscription, share: null };
      const { recentCalls, subscriptionId: _id, ...rest } = rec;
      return {
        subscription,
        share: { ...rest, inFlight: this.inFlightFor(rec.shareId), requestsLastHour: recentCalls.filter((t) => t > now - HOUR_MS).length },
      };
    });
  }

  /** The offers to advertise right now: live shares of subscriptions that are still shareable and keyed. */
  offers(): RelayShareOffer[] {
    this.sweep();
    const subs = new Map(this.deps.subscriptions().map((s) => [s.id, s]));
    return Object.values(this.records)
      .filter((rec) => rec.status === "shared" && subs.get(rec.subscriptionId)?.shareable && this.deps.endpoint(rec.subscriptionId))
      .map((rec) => ({
        shareId: rec.shareId,
        providerLabel: subs.get(rec.subscriptionId)!.providerLabel,
        model: rec.model,
        expiresAt: rec.expiresAt,
        maxConcurrent: rec.maxConcurrent,
        inFlight: this.inFlightFor(rec.shareId),
      }));
  }

  // ---- relay traffic ------------------------------------------------------------------------------------

  /** One recipient request. Every check reads durable state at this moment; the reply is re-checked
   *  against the share AFTER the provider answers, so a reply that lands past the deadline is withheld. */
  async handleCall(frame: Extract<ServerFrame, { t: "share.call" }>): Promise<void> {
    this.sweep();
    const deny = (code: RelayShareErrorCode, message: string, rec?: ShareRecord): void => {
      if (rec) {
        rec.usage.denied++;
        this.persist();
        this.deps.changed();
      }
      this.reply(frame.from, frame.callId, { ok: false, code, message });
    };
    const rec = Object.values(this.records).find((r) => r.shareId === frame.shareId);
    if (!rec) return deny("not-shared", "This machine is not sharing that Director.");
    if (rec.status === "expired") return deny("expired", `This shared Director expired at ${new Date(rec.expiresAt).toISOString()}.`, rec);
    if (rec.status !== "shared") return deny("not-shared", "The donor stopped sharing this Director.", rec);
    const sub = this.deps.subscriptions().find((s) => s.id === rec.subscriptionId);
    const endpoint = this.deps.endpoint(rec.subscriptionId);
    if (!sub?.shareable || !endpoint) return deny("not-shared", "The donor's subscription is no longer connected.", rec);
    if (!validMessages(frame.messages)) return deny("provider-error", "The request was malformed.", rec);
    const chars = frame.messages.reduce((n, m) => n + m.content.length, 0);
    if (chars > SHARE_CALL_MAX_CHARS) return deny("too-large", `The request is ${chars} characters; the limit is ${SHARE_CALL_MAX_CHARS}.`, rec);
    const key = `${frame.from}\n${frame.callId}`;
    if (this.inFlight.has(key)) return;
    if (this.inFlightFor(rec.shareId) >= rec.maxConcurrent) {
      return deny("busy", `All ${rec.maxConcurrent} shared slot${rec.maxConcurrent === 1 ? " is" : "s are"} in use. Try again shortly.`, rec);
    }
    const now = this.now();
    rec.recentCalls = rec.recentCalls.filter((t) => t > now - HOUR_MS);
    if (rec.recentCalls.length >= rec.maxRequestsPerHour) {
      return deny("rate-limited", `This share allows ${rec.maxRequestsPerHour} requests per hour, and they are used up.`, rec);
    }

    rec.recentCalls.push(now);
    rec.usage.requests++;
    rec.usage.lastUsedAt = now;
    this.noteRecipient(rec, frame.from, frame.fromName, now);
    const flight: InFlight = { key, from: frame.from, callId: frame.callId, shareId: rec.shareId, controller: new AbortController(), settled: false };
    this.inFlight.set(key, flight);
    this.commit();

    const result = await callChatCompletion({
      fetch: this.fetchImpl,
      endpoint,
      model: rec.model,
      messages: frame.messages,
      signal: flight.controller.signal,
    });
    this.inFlight.delete(key);
    if (result.ok) {
      rec.usage.inputTokens += result.usage.inputTokens;
      rec.usage.outputTokens += result.usage.outputTokens;
    }
    if (!flight.settled) this.reply(frame.from, frame.callId, this.finalReply(rec, result));
    this.commit();
  }

  /** The recipient gave up on a call: stop the provider request. The relay has already settled the call,
   *  so no reply is owed. A cancel can only name the caller's own calls, because the relay stamps `from`. */
  handleCancel(frame: Extract<ServerFrame, { t: "share.cancel" }>): void {
    const flight = this.inFlight.get(`${frame.from}\n${frame.callId}`);
    if (!flight) return;
    flight.settled = true;
    flight.controller.abort();
  }

  // ---- internals ----------------------------------------------------------------------------------------

  /** What a finished provider call may tell the recipient. The share is re-read first: a reply that
   *  arrives after the deadline or a stop is withheld, even though the provider already did the work. */
  private finalReply(rec: ShareRecord, result: Awaited<ReturnType<typeof callChatCompletion>>): ReplyBody {
    this.sweep();
    const current = this.records[rec.subscriptionId];
    if (current?.shareId !== rec.shareId || current.status !== "shared") {
      return current?.shareId === rec.shareId && current.status === "expired"
        ? { ok: false, code: "expired", message: "This shared Director expired before the reply was ready." }
        : { ok: false, code: "not-shared", message: "The donor stopped sharing this Director before the reply was ready." };
    }
    if (result.ok) return { ok: true, text: result.text.slice(0, SHARE_REPLY_MAX_CHARS), usage: result.usage };
    return { ok: false, code: result.code, message: result.message };
  }

  /** Move every share whose deadline has passed to `expired`, cancelling its in-flight calls. Idempotent
   *  and cheap, because it runs on every read. */
  private sweep(): void {
    const now = this.now();
    let changed = false;
    for (const rec of Object.values(this.records)) {
      if (rec.status !== "shared" || now < rec.expiresAt) continue;
      rec.status = "expired";
      rec.endedAt = rec.expiresAt;
      this.abortShare(rec.shareId, "expired", `This shared Director expired at ${new Date(rec.expiresAt).toISOString()}.`);
      this.deps.log?.("info", `Director sharing: ${rec.subscriptionId} expired.`);
      changed = true;
    }
    if (!changed) return;
    this.persist();
    // Announce on the next tick: a sweep runs inside reads (offers(), view()) that the announcement
    // itself calls, and must not recurse into them.
    queueMicrotask(() => this.deps.changed());
  }

  private abortShare(shareId: string, code: RelayShareErrorCode, message: string): void {
    for (const flight of this.inFlight.values()) {
      if (flight.shareId !== shareId || flight.settled) continue;
      flight.settled = true;
      flight.controller.abort();
      this.reply(flight.from, flight.callId, { ok: false, code, message });
    }
  }

  private reply(to: string, callId: string, body: ReplyBody): void {
    this.deps.send({ t: "share.reply", to, callId, ...body });
  }

  private inFlightFor(shareId: string): number {
    let n = 0;
    for (const f of this.inFlight.values()) if (f.shareId === shareId && !f.settled) n++;
    return n;
  }

  private noteRecipient(rec: ShareRecord, instanceId: string, name: string, at: number): void {
    const prior = rec.usage.recipients[instanceId];
    rec.usage.recipients[instanceId] = { name: String(name || instanceId).slice(0, 60), requests: (prior?.requests ?? 0) + 1, lastAt: at };
    const ids = Object.keys(rec.usage.recipients);
    if (ids.length <= MAX_RECIPIENTS_TRACKED) return;
    const oldest = ids.sort((a, b) => rec.usage.recipients[a]!.lastAt - rec.usage.recipients[b]!.lastAt)[0]!;
    delete rec.usage.recipients[oldest];
  }

  private badTerms(terms: ShareTerms): string | null {
    const now = this.now();
    if (!Number.isFinite(terms.expiresAt)) return "Pick a deadline.";
    if (terms.expiresAt < now + SHARE_MIN_LEAD_MS) return "The deadline must be at least a minute in the future.";
    if (terms.expiresAt > now + SHARE_MAX_HORIZON_MS) return "The deadline can be at most 30 days away.";
    if (!Number.isInteger(terms.maxConcurrent) || terms.maxConcurrent < 1 || terms.maxConcurrent > SHARE_MAX_CONCURRENT) {
      return `Concurrent requests must be between 1 and ${SHARE_MAX_CONCURRENT}.`;
    }
    if (!Number.isInteger(terms.maxRequestsPerHour) || terms.maxRequestsPerHour < 1 || terms.maxRequestsPerHour > SHARE_MAX_REQUESTS_PER_HOUR) {
      return `Requests per hour must be between 1 and ${SHARE_MAX_REQUESTS_PER_HOUR}.`;
    }
    return null;
  }

  /** The single timer: wake at the earliest live deadline (re-armed at least every six hours). */
  private arm(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    const next = Object.values(this.records).filter((r) => r.status === "shared").map((r) => r.expiresAt).sort((a, b) => a - b)[0];
    if (next === undefined) return;
    const delay = Math.max(0, Math.min(next - this.now(), MAX_TIMER_MS));
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.sweep();
      this.arm();
    }, delay);
    this.timer.unref?.();
  }

  private commit(): void {
    this.persist();
    this.arm();
    this.deps.changed();
  }

  private persist(): void {
    this.deps.db.kvSet(KV_SHARES, JSON.stringify(this.records));
  }

  private load(): Record<string, ShareRecord> {
    try {
      const raw = JSON.parse(this.deps.db.kvGet(KV_SHARES) ?? "{}") as Record<string, ShareRecord>;
      return raw && typeof raw === "object" ? raw : {};
    } catch {
      return {};
    }
  }
}

type ReplyBody = { ok: boolean; text?: string; code?: RelayShareErrorCode; message?: string; usage?: { inputTokens: number; outputTokens: number } };

function validMessages(raw: unknown): raw is RelayShareMessage[] {
  return Array.isArray(raw) && raw.length > 0 && raw.every((m: Partial<RelayShareMessage> | null) =>
    !!m && (m.role === "system" || m.role === "user" || m.role === "assistant") && typeof m.content === "string");
}

/** An IANA zone name as the browser reported it, kept for display only. The deadline itself is epoch ms. */
function cleanTimeZone(tz: string): string {
  const clean = String(tz ?? "").trim().slice(0, 64);
  if (!clean) return "UTC";
  try {
    new Intl.DateTimeFormat("en", { timeZone: clean });
    return clean;
  } catch {
    return "UTC";
  }
}
