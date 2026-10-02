import { createHash } from "node:crypto";
import { readNotesBySha, type PatchNote } from "./patchNotes.js";
import { disputesTheWork, haikuLine } from "./orchestrator/titleFromInjection.js";

// A busy day in the Patch notes gets one plain-language line above its bullets, so thirty commits read
// as "what that day was about" at a glance. The console groups days in the viewer's own timezone, so it
// sends the day, that timezone and the day's commit shas; the server re-reads those commits from git
// (the prompt is never built from client text) and asks Haiku once per distinct set. Only a day that has
// ended is summarized: today still gains commits, and summarizing it would re-ask the model with every
// one and keep rewriting its overview. Commits are immutable, so a digest keyed on its shas never goes stale.

/** Days with fewer operator-facing changes than this are short enough to scan without a digest. */
export const DIGEST_MIN_CHANGES = 5;
const MAX_SHAS = 300;
const BODY_CHARS = 240;
const MAX_OUTPUT_TOKENS = 160;
const CACHE_KEY = "patch_note_digests";
const CACHE_LIMIT = 400;
const SHA = /^[0-9a-f]{40}$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

const PROMPT = `Below is one day's list of changes to GGO, a console for running coding agents. Write a short overview the owner reads above the list: one or two plain sentences, at most 45 words, that say what the day was mostly about, grouping related changes into themes rather than naming each one. Use everyday words, not commit jargon; no list, no preamble, no commit hashes, no dates, and do not start with "Today". Output only the overview. The changes follow:`;

export interface DigestStore {
  get(key: string): string | null;
  set(key: string, value: string): void;
}

/** One day as the console groups it: its date in the viewer's timezone and its operator-facing commits. */
export interface DigestRequest {
  shas: string[];
  /** YYYY-MM-DD in `timeZone`. */
  day: string;
  /** IANA name, e.g. Europe/Copenhagen. */
  timeZone: string;
}

export type DigestResult =
  | { ok: true; summary: string }
  | { ok: false; status: 409 | 422 | 502; error: string };

type CacheEntry = { summary: string; at: number };

/** Turns the day's change list into an overview; null on any failure. */
export type DigestModel = (changes: string) => Promise<string | null>;

/** The production model: one Haiku call on a subscription token, best-effort like the board titles. */
export function haikuDigestModel(token: () => string | undefined): DigestModel {
  return (changes) => haikuLine(changes, token(), PROMPT, MAX_OUTPUT_TOKENS);
}

/** The shas a request may ask about: full lowercase hex, deduplicated. Null when the request is malformed. */
export function digestShas(input: unknown): string[] | null {
  if (!Array.isArray(input) || input.length === 0 || input.length > MAX_SHAS) return null;
  if (!input.every((s) => typeof s === "string" && SHA.test(s))) return null;
  return [...new Set(input as string[])];
}

/** A digest request body, validated; null when it is malformed. */
export function digestRequest(body: unknown): DigestRequest | null {
  const b = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  const shas = digestShas(b.shas);
  if (!shas || typeof b.day !== "string" || !DAY.test(b.day) || typeof b.timeZone !== "string") return null;
  if (!dayFormat(b.timeZone)) return null;
  return { shas, day: b.day, timeZone: b.timeZone };
}

const dayFormats = new Map<string, Intl.DateTimeFormat | null>();

function dayFormat(timeZone: string): Intl.DateTimeFormat | null {
  if (!dayFormats.has(timeZone)) {
    let format: Intl.DateTimeFormat | null = null;
    try {
      format = new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" });
    } catch {
      // RangeError: not a timezone this runtime knows.
    }
    dayFormats.set(timeZone, format);
  }
  return dayFormats.get(timeZone)!;
}

/** The calendar day `at` (epoch ms) falls on in `timeZone`, as YYYY-MM-DD — the key the console groups days by. */
export function dayIn(at: number, timeZone: string): string {
  const parts = Object.fromEntries(dayFormat(timeZone)!.formatToParts(at).map((p) => [p.type, p.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

export function digestKey(shas: string[]): string {
  return createHash("sha256").update([...shas].sort().join("\n")).digest("hex").slice(0, 32);
}

/** The model's input: one line per change, its kind and subject, with the start of its body for context. */
export function buildDigestInput(notes: PatchNote[]): string {
  return notes
    .map((note) => {
      const kind = note.kind === "feature" ? "New" : note.kind === "fix" ? "Fixed" : note.kind === "perf" ? "Faster" : "Changed";
      const scope = note.scope ? ` (${note.scope})` : "";
      const body = note.body.replace(/\s+/g, " ").trim();
      const detail = body ? ` — ${body.length > BODY_CHARS ? `${body.slice(0, BODY_CHARS).trimEnd()}…` : body}` : "";
      return `- ${kind}${scope}: ${note.summary}${detail}`;
    })
    .join("\n");
}

/** A usable overview, or null when the model talked about the task instead of doing it. */
export function cleanDigest(text: string | null): string | null {
  const t = (text ?? "").trim();
  if (!t || disputesTheWork(t) || /^(here|sure|i\b|sorry)/i.test(t)) return null;
  return /[.!?…]$/.test(t) ? t : `${t}.`;
}

export class PatchNoteDigests {
  private readonly inflight = new Map<string, Promise<DigestResult>>();

  constructor(
    private readonly store: DigestStore,
    private readonly ask: DigestModel,
    private readonly cwd?: string,
    private readonly now: () => number = Date.now,
  ) {}

  /** The overview for one ended day's operator-facing commits; concurrent asks for the same day share one call. */
  digest({ shas, day, timeZone }: DigestRequest): Promise<DigestResult> {
    if (day >= dayIn(this.now(), timeZone)) {
      return Promise.resolve({ ok: false, status: 409, error: "that day is still in progress; it is summarized once it has ended" });
    }
    const key = digestKey(shas);
    const cached = this.readCache()[key];
    if (cached) return Promise.resolve({ ok: true, summary: cached.summary });
    let pending = this.inflight.get(key);
    if (!pending) {
      pending = this.compute(key, shas, day, timeZone).finally(() => this.inflight.delete(key));
      this.inflight.set(key, pending);
    }
    return pending;
  }

  private async compute(key: string, shas: string[], day: string, timeZone: string): Promise<DigestResult> {
    const notes = await readNotesBySha(shas, this.cwd);
    if (!notes) return { ok: false, status: 422, error: "one of those commits is not in this checkout" };
    if (notes.some((note) => dayIn(note.at, timeZone) !== day)) return { ok: false, status: 422, error: `those commits are not all from ${day}` };
    const facing = notes.filter((note) => note.kind !== "internal");
    if (facing.length < DIGEST_MIN_CHANGES) {
      return { ok: false, status: 422, error: `a digest needs at least ${DIGEST_MIN_CHANGES} operator-facing changes` };
    }
    const summary = cleanDigest(await this.ask(buildDigestInput(facing)).catch(() => null));
    if (!summary) return { ok: false, status: 502, error: "the summary model gave no usable answer" };
    this.writeCache(key, summary);
    return { ok: true, summary };
  }

  private readCache(): Record<string, CacheEntry> {
    try {
      const parsed = JSON.parse(this.store.get(CACHE_KEY) ?? "{}") as unknown;
      return parsed && typeof parsed === "object" ? (parsed as Record<string, CacheEntry>) : {};
    } catch {
      return {};
    }
  }

  // One entry per ended busy day; the newest are kept so the kv row stays bounded on a long-lived install.
  private writeCache(key: string, summary: string): void {
    const entries = Object.entries({ ...this.readCache(), [key]: { summary, at: Date.now() } })
      .sort((a, b) => b[1].at - a[1].at)
      .slice(0, CACHE_LIMIT);
    this.store.set(CACHE_KEY, JSON.stringify(Object.fromEntries(entries)));
  }
}
