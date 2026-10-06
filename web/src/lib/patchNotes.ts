import { useEffect } from "react";
import { create } from "zustand";
import { apiUrl } from "./base.js";

// The Patch notes board area's data: this install's own commit history, served by /api/patch-notes.
// Kept out of the main store because nothing else reads it, and it is fetched on demand (when the board
// first renders, and each time the area opens) rather than pushed over the socket.

export type PatchNoteKind = "feature" | "fix" | "perf" | "other" | "internal";

export interface PatchNote {
  sha: string;
  short: string;
  at: number;
  kind: PatchNoteKind;
  type: string | null;
  scope: string | null;
  breaking: boolean;
  summary: string;
  body: string;
}

interface PatchNotesPage {
  head: string | null;
  running: string | null;
  /** Commits whose server or web change is not built into what is running yet (first page only). */
  pending: string[];
  branch: string | null;
  upcoming: PatchNote[];
  entries: PatchNote[];
  hasMore: boolean;
  error: string | null;
}

interface PatchNotesState {
  head: string | null;
  running: string | null;
  pending: string[];
  upcoming: PatchNote[];
  entries: PatchNote[];
  hasMore: boolean;
  lastDayComplete: boolean;
  loading: boolean;
  error: string | null;
  /** The newest commit the operator has seen in this area; entries above it are "new to you". */
  seenSha: string | null;
  /** Busy days' overviews by `digestKey`; absent until asked for, null when it could not be written. */
  digests: Record<string, DayDigest>;
  load: () => Promise<void>;
  loadOlder: () => Promise<void>;
  markSeen: () => void;
  /** Ask for an ENDED day's overview; `day` is its `localDay` key. */
  requestDigest: (day: string, shas: string[]) => void;
}

export type DayDigest = { status: "loading" } | { status: "ready"; summary: string } | { status: "failed" };

/** Must match the server's DIGEST_MIN_CHANGES: below this a day is short enough to scan. */
export const DIGEST_MIN_CHANGES = 5;

export function digestKey(shas: string[]): string {
  return [...shas].sort().join(",");
}

/** The viewer's calendar day for `at`, as YYYY-MM-DD: how the view groups days and what a digest names. */
export function localDay(at: number): string {
  const d = new Date(at);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** Milliseconds until the viewer's next local midnight. */
export function msUntilNextDay(now: number): number {
  const d = new Date(now);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime() - now;
}

class DayInProgress extends Error {}

/** How long to wait before asking again when the server's clock has not reached the viewer's midnight yet. */
const IN_PROGRESS_RETRY_MS = 60_000;

const SEEN_KEY = "ggo.patchNotesSeen";

function readSeen(): string | null {
  try {
    return localStorage.getItem(SEEN_KEY);
  } catch {
    return null;
  }
}

function writeSeen(sha: string): void {
  try {
    localStorage.setItem(SEEN_KEY, sha);
  } catch {
    /* private mode */
  }
}

async function fetchRawPage(skip: number): Promise<PatchNotesPage> {
  const res = await fetch(apiUrl(`/api/patch-notes?skip=${skip}`), { cache: "no-store" });
  if (!res.ok) throw new Error(`patch notes request failed (${res.status})`);
  return (await res.json()) as PatchNotesPage;
}

/** Finish a calendar day before displaying its overview, even across git pages. Keep the next
 * day's rows for the next user-requested page rather than loading the whole history automatically. */
async function fetchPage(skip: number): Promise<PatchNotesPage & { lastDayComplete: boolean }> {
  const page = await fetchRawPage(skip);
  const last = page.entries.at(-1);
  const day = last ? localDay(last.at) : null;
  if (!page.hasMore || !day) return { ...page, lastDayComplete: true };
  while (page.hasMore) {
    const next = await fetchRawPage(skip + page.entries.length);
    if (next.error) throw new Error(next.error);
    if (!next.entries.length) {
      if (next.hasMore) throw new Error("patch notes paging made no progress");
      page.hasMore = false;
      break;
    }
    const boundary = next.entries.findIndex((note) => localDay(note.at) !== day);
    page.entries.push(...(boundary < 0 ? next.entries : next.entries.slice(0, boundary)));
    if (boundary >= 0) return { ...page, hasMore: true, lastDayComplete: true };
    page.hasMore = next.hasMore;
  }
  return { ...page, lastDayComplete: true };
}

async function fetchDigest(day: string, shas: string[]): Promise<string> {
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const res = await fetch(apiUrl("/api/patch-notes/digest"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ shas, day, timeZone }),
    cache: "no-store",
  });
  if (res.status === 409) throw new DayInProgress();
  if (!res.ok) throw new Error(`patch notes digest failed (${res.status})`);
  return ((await res.json()) as { summary: string }).summary;
}

let inflight: Promise<void> | null = null;

export const usePatchNotes = create<PatchNotesState>((set, get) => {
  const refreshFirstPage = async (): Promise<void> => {
    set({ loading: true });
    try {
      const page = await fetchPage(0);
      // A first visit has nothing to compare against: start the clock now instead of flagging the whole
      // history as new.
      if (!get().seenSha && page.head) {
        writeSeen(page.head);
        set({ seenSha: page.head });
      }
      set({ running: page.running, pending: page.pending ?? [], upcoming: page.upcoming, error: page.error });
      // Same HEAD: keep what is loaded, so a refresh does not collapse the older pages the operator opened.
      if (page.head !== get().head || get().entries.length === 0) set({ head: page.head, entries: page.entries, hasMore: page.hasMore, lastDayComplete: page.lastDayComplete });
    } catch (e) {
      set({ error: (e as Error).message });
    } finally {
      set({ loading: false });
    }
  };

  return {
    head: null,
    running: null,
    pending: [],
    upcoming: [],
    entries: [],
    hasMore: false,
    lastDayComplete: true,
    loading: false,
    error: null,
    seenSha: readSeen(),
    digests: {},

    // Concurrent callers share one request, so a caller that awaits `load()` (the view, before marking
    // what it showed as seen) always resumes after the data it asked for has landed.
    load: () => (inflight ??= refreshFirstPage().finally(() => (inflight = null))),

    loadOlder: async () => {
      const { loading, entries } = get();
      if (loading) return;
      set({ loading: true });
      try {
        const page = await fetchPage(entries.length);
        const known = new Set(entries.map((e) => e.sha));
        set({ entries: [...entries, ...page.entries.filter((e) => !known.has(e.sha))], hasMore: page.hasMore, lastDayComplete: page.lastDayComplete });
      } catch (e) {
        set({ error: (e as Error).message });
      } finally {
        set({ loading: false });
      }
    },

    // Asked once per day while the console stays loaded: a failure stays failed until a reload rather
    // than retrying a model call on every render. The one exception is a server whose clock is a little
    // behind the viewer's midnight: it never reached the model, so it is asked again shortly.
    requestDigest: (day, shas) => {
      const key = digestKey(shas);
      if (get().digests[key]) return;
      const settle = (digest: DayDigest | null) =>
        set((s) => {
          const { [key]: _, ...rest } = s.digests;
          return { digests: digest ? { ...rest, [key]: digest } : rest };
        });
      settle({ status: "loading" });
      fetchDigest(day, shas).then(
        (summary) => settle({ status: "ready", summary }),
        (e) => {
          if (!(e instanceof DayInProgress)) return settle({ status: "failed" });
          settle(null);
          setTimeout(() => get().requestDigest(day, shas), IN_PROGRESS_RETRY_MS);
        },
      );
    },

    markSeen: () => {
      const head = get().head;
      if (!head || head === get().seenSha) return;
      writeSeen(head);
      set({ seenSha: head });
    },
  };
});

/** How many entries sit above `seenSha`. When the seen commit is not in the loaded page (it scrolled past
 *  the first page, or a rewrite dropped it), everything loaded counts. */
export function newerThan(entries: PatchNote[], sha: string | null): number {
  if (!sha) return 0;
  const idx = entries.findIndex((e) => e.sha === sha);
  return idx === -1 ? entries.length : idx;
}

/** Operator-facing changes the operator has not seen yet: the count on the board tab. */
export function useUnseenPatchNotes(): number {
  return usePatchNotes((s) => {
    const cut = newerThan(s.entries, s.seenSha);
    let count = 0;
    for (let i = 0; i < cut; i++) if (s.entries[i]!.kind !== "internal") count++;
    return count;
  });
}

/** Keep the unseen count current without a socket feed: read once when the board mounts, and again
 *  whenever the tab comes back into view (a deploy or an update may have landed meanwhile). */
export function usePatchNotesWatch(): void {
  useEffect(() => {
    const refresh = () => {
      if (!document.hidden) void usePatchNotes.getState().load();
    };
    refresh();
    document.addEventListener("visibilitychange", refresh);
    return () => document.removeEventListener("visibilitychange", refresh);
  }, []);
}
