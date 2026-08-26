import { createHmac } from "node:crypto";
import type { FreeProviderId, FreeTierKind, QuotaWindow, UsageLedgerEvent } from "./types.js";

const LEDGER_KEY = "free_ai_usage_ledger_v1";
const MAX_EVENTS = 2_000;

export interface KvStore {
  kvGet(key: string): string | null;
  kvSet(key: string, value: string): void;
}

export interface UsageAggregate {
  requests: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  estimatedUnits: number;
  lastAt: number | null;
}

export function credentialFingerprint(secret: string | undefined, salt: string, anonymousLabel = "anonymous"): string {
  const material = secret?.trim() || anonymousLabel;
  return createHmac("sha256", salt).update(material).digest("hex").slice(0, 20);
}

function zonedParts(at: number, timeZone: string): Record<string, string> {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(at));
  return Object.fromEntries(parts.filter((p) => p.type !== "literal").map((p) => [p.type, p.value]));
}

export function quotaWindowId(window: QuotaWindow, at: number, timeZone = "UTC"): string {
  const p = zonedParts(at, timeZone);
  if (window === "month") return `${p.year}-${p.month}@${timeZone}`;
  if (window === "day") return `${p.year}-${p.month}-${p.day}@${timeZone}`;
  if (window === "hour") return `${p.year}-${p.month}-${p.day}T${p.hour}@${timeZone}`;
  if (window === "rolling") return `rolling@${timeZone}`;
  return `dynamic@${timeZone}`;
}

function isLedgerEvent(value: unknown): value is UsageLedgerEvent {
  if (!value || typeof value !== "object") return false;
  const e = value as Partial<UsageLedgerEvent>;
  return typeof e.providerId === "string" && typeof e.accountFingerprint === "string" && typeof e.modelId === "string" && typeof e.timestamp === "number";
}

export class UsageLedger {
  constructor(private readonly store: KvStore) {}

  all(): UsageLedgerEvent[] {
    const raw = this.store.kvGet(LEDGER_KEY);
    if (!raw) return [];
    try {
      const parsed = JSON.parse(raw) as unknown;
      return Array.isArray(parsed) ? parsed.filter(isLedgerEvent) : [];
    } catch {
      return [];
    }
  }

  record(input: {
    providerId: FreeProviderId;
    accountFingerprint: string;
    modelId: string;
    timestamp?: number;
    requestCount?: number;
    inputTokens?: number;
    outputTokens?: number;
    providerCostUsd?: number;
    estimatedUnits?: number;
    responseStatus: UsageLedgerEvent["responseStatus"];
    freeClass: FreeTierKind;
    window: QuotaWindow;
    timeZone?: string;
  }): UsageLedgerEvent {
    const timestamp = input.timestamp ?? Date.now();
    const event: UsageLedgerEvent = {
      providerId: input.providerId,
      accountFingerprint: input.accountFingerprint,
      modelId: input.modelId,
      timestamp,
      requestCount: input.requestCount ?? 1,
      inputTokens: input.inputTokens,
      outputTokens: input.outputTokens,
      providerCostUsd: input.providerCostUsd,
      estimatedUnits: input.estimatedUnits,
      responseStatus: input.responseStatus,
      freeClass: input.freeClass,
      windowId: quotaWindowId(input.window, timestamp, input.timeZone),
    };
    const events = [...this.all(), event].slice(-MAX_EVENTS);
    this.store.kvSet(LEDGER_KEY, JSON.stringify(events));
    return event;
  }

  aggregate(input: {
    providerId: FreeProviderId;
    accountFingerprint: string;
    window: QuotaWindow;
    now?: number;
    timeZone?: string;
  }): UsageAggregate {
    const now = input.now ?? Date.now();
    const currentWindow = quotaWindowId(input.window, now, input.timeZone);
    const rollingCutoff = input.window === "rolling" ? now - 60 * 60_000 : null;
    const relevant = this.all().filter(
      (event) =>
        event.providerId === input.providerId &&
        event.accountFingerprint === input.accountFingerprint &&
        (rollingCutoff != null ? event.timestamp >= rollingCutoff && event.timestamp <= now : event.windowId === currentWindow),
    );
    return relevant.reduce<UsageAggregate>(
      (sum, event) => ({
        requests: sum.requests + (event.requestCount || 0),
        inputTokens: sum.inputTokens + (event.inputTokens || 0),
        outputTokens: sum.outputTokens + (event.outputTokens || 0),
        costUsd: sum.costUsd + (event.providerCostUsd || 0),
        estimatedUnits: sum.estimatedUnits + (event.estimatedUnits || 0),
        lastAt: Math.max(sum.lastAt ?? 0, event.timestamp),
      }),
      { requests: 0, inputTokens: 0, outputTokens: 0, costUsd: 0, estimatedUnits: 0, lastAt: null },
    );
  }
}
