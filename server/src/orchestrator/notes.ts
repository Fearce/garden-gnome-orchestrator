import type { Db } from "../db/db.js";
import type { EventHub } from "../events.js";
import { NOTE_MAX_CHARS, type OperatorNote, type Role } from "../types.js";

/** What a caller may set on a note; everything else (id, timestamp) is service-managed. */
export interface NoteInput {
  body: string;
  url?: string | null;
  threadId?: string | null;
  threadTitle?: string | null;
  workspace?: string | null;
  fromRole?: Role | null;
  fromName?: string | null;
}

export interface NoteResult {
  ok: boolean;
  error?: string;
  note?: OperatorNote;
  /** What the write actually did, so a posting agent learns it was clipped/deduped rather than silently
   *  wondering why the list didn't grow. */
  outcome?: "created" | "refreshed";
  truncated?: boolean;
  evicted?: number;
}

// One task may hold at most this many notes. Reaching it EVICTS that task's oldest note rather than
// refusing the new one: a refusal would drop a real PR link on the floor, and the freshest pointer is
// the one worth keeping. It is the anti-spam bound the char cap can't provide on its own.
const MAX_PER_TASK = 5;
// Whole-list backstop, so months of un-cleared notes can't grow the snapshot frame without limit.
const MAX_TOTAL = 200;
const MAX_URL_CHARS = 600;

/**
 * The owner's note list: short pointers agents leave for them — a branch pushed, a PR to review — that
 * they click and then delete. Every mutation rebroadcasts the whole list (it's small and hard-bounded),
 * which is the only state the console trusts.
 *
 * Deliberately STATELESS beyond its two collaborators, so it can be constructed wherever it's needed —
 * the WS layer holds one, and each agent's bus server builds its own from the same `db`/`hub` rather
 * than threading an instance through ThreadManager.
 */
export class OperatorNotes {
  constructor(
    private readonly db: Db,
    private readonly hub: EventHub,
  ) {}

  list(): OperatorNote[] {
    return this.db.listOperatorNotes();
  }

  /** Record a note. Re-posting a link the same task already noted refreshes THAT note instead of adding
   *  a second row for it — an implementor that pushes twice leaves one line, not two. */
  add(input: NoteInput): NoteResult {
    // A poster that wrote the link into the sentence instead of the field still gets a click target —
    // which is how a model naturally writes one, and the only shape a CLI backend's text bridge has.
    const url = this.cleanUrl(input.url ?? firstLink(input.body));
    if (typeof url === "string" && url.startsWith("!")) return { ok: false, error: url.slice(1) };

    const body = normalize(input.body);
    const clipped = clip(input.body, NOTE_MAX_CHARS) || url || "";
    if (!clipped) return { ok: false, error: "A note needs a body (or at least a link)." };
    // Only a body the cap actually shortened counts — a note that fell back to its bare link didn't lose
    // anything, and telling the poster otherwise sends it re-writing a note that was already fine.
    const truncated = body.length > NOTE_MAX_CHARS;

    const existing = url ? this.sameLink(input.threadId ?? null, url) : null;
    if (existing) {
      const note = this.db.refreshOperatorNote(existing.id, clipped);
      this.broadcast();
      return { ok: true, note: note ?? existing, outcome: "refreshed", truncated };
    }

    const note = this.db.createOperatorNote({
      body: clipped,
      url,
      threadId: input.threadId ?? null,
      threadTitle: clip(input.threadTitle ?? "", 200) || null,
      workspace: input.workspace ?? null,
      fromRole: input.fromRole ?? null,
      fromName: input.fromName ?? null,
    });
    const evicted = this.trim(note);
    this.broadcast();
    this.hub.log("info", `Note for the owner${note.fromName ? ` from ${note.fromName}` : ""}: ${note.body}`);
    return { ok: true, note, outcome: "created", truncated, evicted };
  }

  remove(id: string): NoteResult {
    const existed = this.db.deleteOperatorNote(id);
    if (existed) this.broadcast();
    return { ok: existed, error: existed ? undefined : "No such note." };
  }

  /** Clear the whole list — the "I've worked through all of these" action. */
  clear(): NoteResult {
    if (this.db.deleteAllOperatorNotes() > 0) this.broadcast();
    return { ok: true };
  }

  /** Enforce the per-task and whole-list caps by dropping the oldest notes, never `keep`. */
  private trim(keep: OperatorNote): number {
    let evicted = 0;
    if (keep.threadId) {
      const mine = this.db.listOperatorNotesForThread(keep.threadId);
      for (const n of mine.slice(0, Math.max(0, mine.length - MAX_PER_TASK))) {
        if (n.id !== keep.id && this.db.deleteOperatorNote(n.id)) evicted++;
      }
    }
    const all = this.db.listOperatorNotes(); // newest first
    for (const n of all.slice(MAX_TOTAL)) {
      if (n.id !== keep.id) this.db.deleteOperatorNote(n.id);
    }
    return evicted;
  }

  private sameLink(threadId: string | null, url: string): OperatorNote | null {
    return this.db.listOperatorNotes().find((n) => n.url === url && (n.threadId ?? null) === threadId) ?? null;
  }

  /** null when absent; the cleaned absolute URL when usable; an `!`-prefixed error otherwise. The value
   *  is agent-supplied and is rendered as a real link, so only http(s) may ever come back out of here —
   *  a `javascript:` or `data:` "link" must never reach the console's DOM. */
  private cleanUrl(raw: string | null | undefined): string | null {
    const v = (raw ?? "").trim();
    if (!v) return null;
    if (v.length > MAX_URL_CHARS) return `!That link is too long (max ${MAX_URL_CHARS} characters).`;
    let parsed: URL;
    try {
      parsed = new URL(v);
    } catch {
      return "!`url` must be a full link starting with https:// — put a bare branch name in the note text instead.";
    }
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      return `!\`url\` must be http(s) — "${parsed.protocol}" links aren't allowed.`;
    }
    return parsed.toString();
  }

  private broadcast(): void {
    this.hub.publish({ type: "notes", notes: this.list() });
  }
}

/** The first http(s) link in the text, with any trailing sentence punctuation dropped. */
function firstLink(text: string): string | null {
  const m = /https?:\/\/[^\s<>"')\]]+/i.exec(text ?? "");
  return m ? m[0].replace(/[.,;:!?]+$/, "") : null;
}

/** One line, no newlines — the list is skimmed, not read. */
function normalize(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function clip(text: string, max: number): string {
  const one = normalize(text);
  return one.length <= max ? one : one.slice(0, max - 1).trimEnd() + "…";
}
