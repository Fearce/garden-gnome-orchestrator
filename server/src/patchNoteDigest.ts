import { createHash } from "node:crypto";
import { readNotesBySha, type PatchNote } from "./patchNotes.js";
import { disputesTheWork, haikuLine } from "./orchestrator/titleFromInjection.js";

// A busy day in the Patch notes gets one plain-language line above its bullets, so thirty commits read
// as "what happened today" at a glance. The console groups days in the viewer's own timezone, so it
// sends the day's commit shas; the server re-reads those commits from git (the prompt is never built
// from client text) and asks Haiku once per distinct set. Commits are immutable, so a digest keyed on
// its shas never goes stale: a day that gains a commit is simply a new set.

/** Days with fewer operator-facing changes than this are short enough to scan without a digest. */
export const DIGEST_MIN_CHANGES = 5;
const MAX_SHAS = 300;
const BODY_CHARS = 240;
const MAX_OUTPUT_TOKENS = 160;
const CACHE_KEY = "patch_note_digests";
const CACHE_LIMIT = 400;
const SHA = /^[0-9a-f]{40}$/;

const PROMPT = `Below is one day's list of changes to GGO, a console for running coding agents. Write a short overview the owner reads above the list: one or two plain sentences, at most 45 words, that say what the day was mostly about, grouping related changes into themes rather than naming each one. Use everyday words, not commit jargon; no list, no preamble, no commit hashes, no dates, and do not start with "Today". Output only the overview. The changes follow:`;

export interface DigestStore {
  get(key: string): string | null;
  set(key: string, value: string): void;
}

export type DigestResult =
  | { ok: true; summary: string }
  | { ok: false; status: 422 | 502; error: string };

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
  ) {}

  /** The overview for one day's operator-facing commits; concurrent asks for the same day share one call. */
  digest(shas: string[]): Promise<DigestResult> {
    const key = digestKey(shas);
    const cached = this.readCache()[key];
    if (cached) return Promise.resolve({ ok: true, summary: cached.summary });
    let pending = this.inflight.get(key);
    if (!pending) {
      pending = this.compute(key, shas).finally(() => this.inflight.delete(key));
      this.inflight.set(key, pending);
    }
    return pending;
  }

  private async compute(key: string, shas: string[]): Promise<DigestResult> {
    const notes = await readNotesBySha(shas, this.cwd);
    if (!notes) return { ok: false, status: 422, error: "one of those commits is not in this checkout" };
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

  // A day still in progress mints a new set with every commit, so the cache keeps only the newest entries.
  private writeCache(key: string, summary: string): void {
    const entries = Object.entries({ ...this.readCache(), [key]: { summary, at: Date.now() } })
      .sort((a, b) => b[1].at - a[1].at)
      .slice(0, CACHE_LIMIT);
    this.store.set(CACHE_KEY, JSON.stringify(Object.fromEntries(entries)));
  }
}
