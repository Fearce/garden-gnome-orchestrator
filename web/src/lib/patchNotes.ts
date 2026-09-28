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
  branch: string | null;
  upcoming: PatchNote[];
  entries: PatchNote[];
  hasMore: boolean;
  error: string | null;
}

interface PatchNotesState {
  head: string | null;
  running: string | null;
  upcoming: PatchNote[];
  entries: PatchNote[];
  hasMore: boolean;
  loading: boolean;
  error: string | null;
  /** The newest commit the operator has seen in this area; entries above it are "new to you". */
  seenSha: string | null;
  load: () => Promise<void>;
  loadOlder: () => Promise<void>;
  markSeen: () => void;
}

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

async function fetchPage(skip: number): Promise<PatchNotesPage> {
  const res = await fetch(apiUrl(`/api/patch-notes?skip=${skip}`), { cache: "no-store" });
  if (!res.ok) throw new Error(`patch notes request failed (${res.status})`);
  return (await res.json()) as PatchNotesPage;
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
      set({ running: page.running, upcoming: page.upcoming, error: page.error });
      // Same HEAD: keep what is loaded, so a refresh does not collapse the older pages the operator opened.
      if (page.head !== get().head || get().entries.length === 0) set({ head: page.head, entries: page.entries, hasMore: page.hasMore });
    } catch (e) {
      set({ error: (e as Error).message });
    } finally {
      set({ loading: false });
    }
  };

  return {
    head: null,
    running: null,
    upcoming: [],
    entries: [],
    hasMore: false,
    loading: false,
    error: null,
    seenSha: readSeen(),

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
        set({ entries: [...entries, ...page.entries.filter((e) => !known.has(e.sha))], hasMore: page.hasMore });
      } catch (e) {
        set({ error: (e as Error).message });
      } finally {
        set({ loading: false });
      }
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
