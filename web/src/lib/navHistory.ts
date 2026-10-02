import type { TaskOverlay } from "../types.js";

// Browser history for the console's layers: the open task, and the memo / deliverable / diff layer on
// top of it. The console used to write no history at all, so a phone's Back gesture (or the browser's
// Back button) skipped every layer and left the app. On a phone that took the owner out of a work memo
// straight to the previous site, which is what "stuck in the memos card" meant. Now each layer that
// opens pushes an entry, Back closes the top layer, and Forward reopens it.
//
// The store stays the source of truth. This module only mirrors `selectedThreadId` + `taskOverlay`
// into `history.state` and applies a popped entry back to the store. The URL never changes, so a
// reload still opens on the board exactly as before.

/** Where the console is: which task is open, and which layer sits over it. */
export interface NavLocation {
  task: string | null;
  overlay: TaskOverlay | null;
}

/** A history entry also remembers the location it was pushed from, so closing a layer can step the
 *  browser back onto that entry instead of stacking a second copy of it. */
export interface NavEntry extends NavLocation {
  parent: NavEntry | null;
}

export type NavStep = "none" | "back" | "replace" | "push";

const STATE_KEY = "ggoNav";
// Bounds the parent chain written into each entry. Each step consults only the first link; the rest
// only has to survive a run of consecutive closes.
const MAX_DEPTH = 24;

export const HOME: NavLocation = { task: null, overlay: null };

function sameOverlay(a: TaskOverlay | null, b: TaskOverlay | null): boolean {
  if (!a || !b) return a === b;
  if (a.kind === "memo") return b.kind === "memo" && a.memoId === b.memoId;
  if (a.kind === "deliverable") return b.kind === "deliverable" && a.findingId === b.findingId;
  return a.kind === b.kind;
}

export function sameLocation(a: NavLocation, b: NavLocation): boolean {
  return a.task === b.task && sameOverlay(a.overlay, b.overlay);
}

/** True when `next` only closes something that is open in `current`. */
function closes(current: NavLocation, next: NavLocation): boolean {
  if (next.task === null) return current.task !== null;
  return next.task === current.task && next.overlay === null && current.overlay !== null;
}

/** The history operation that takes the browser from `current` to `next`:
 *  - back to the entry this one was pushed from, when that is where the console is going;
 *  - replace, for revision browsing or a close that was not opened from here (after a reload or a
 *    deleted task), so Back never reopens something the owner just closed;
 *  - push, for anything that opens another layer or switches tasks. */
export function navStep(current: NavEntry, next: NavLocation): NavStep {
  if (sameLocation(current, next)) return "none";
  // A revision picker changes the content of one memo layer, not its depth. Keep its parent so
  // Close still returns directly to the task and Forward restores the revision last read.
  if (current.task === next.task && current.overlay?.kind === "memo" && next.overlay?.kind === "memo") return "replace";
  if (current.parent && sameLocation(current.parent, next)) return "back";
  if (closes(current, next)) return "replace";
  return "push";
}

function trimmed(entry: NavEntry | null, depth = 0): NavEntry | null {
  if (!entry || depth >= MAX_DEPTH) return null;
  return { task: entry.task, overlay: entry.overlay, parent: trimmed(entry.parent, depth + 1) };
}

function isOverlay(value: unknown): value is TaskOverlay {
  if (!value || typeof value !== "object") return false;
  const o = value as Record<string, unknown>;
  if (o.kind === "memo") return typeof o.memoId === "string";
  if (o.kind === "deliverable") return typeof o.findingId === "string";
  return o.kind === "changes";
}

/** Reads an entry back out of `history.state`. Anything this module did not write reads as null. */
export function readEntry(state: unknown, depth = 0): NavEntry | null {
  if (!state || typeof state !== "object" || depth >= MAX_DEPTH) return null;
  const e = state as Record<string, unknown>;
  if (e.task !== null && typeof e.task !== "string") return null;
  const overlay = e.task !== null && isOverlay(e.overlay) ? e.overlay : null;
  return { task: e.task as string | null, overlay, parent: readEntry(e.parent, depth + 1) };
}

interface NavState {
  selectedThreadId: string | null;
  taskOverlay: TaskOverlay | null;
  threads: Record<string, unknown>;
  select: (id: string | null) => void;
}

/** The slice of the console store this module drives. Passed in (App hands it `useStore`) so the
 *  web gate can run the whole sync against a stand-in store and history. */
export interface NavStore {
  getState: () => NavState;
  setState: (partial: { taskOverlay: TaskOverlay | null }) => void;
  subscribe: (listener: (state: NavState, prev: NavState) => void) => () => void;
}

function locationOf(s: NavState): NavLocation {
  return { task: s.selectedThreadId, overlay: s.selectedThreadId ? s.taskOverlay : null };
}

/** Starts mirroring the store into browser history. Returns the teardown. */
export function installNavHistory(useStore: NavStore): () => void {
  const write = (entry: NavEntry, mode: "push" | "replace") => {
    const base = history.state && typeof history.state === "object" ? history.state : {};
    const state = { ...base, [STATE_KEY]: trimmed(entry) };
    if (mode === "push") history.pushState(state, "");
    else history.replaceState(state, "");
  };

  // Do not write or traverse again until a requested Back lands. Otherwise a quick reopen pushes
  // from the entry being left, and its late popstate overwrites the owner's newer action.
  let shadow: NavEntry = { ...locationOf(useStore.getState()), parent: null };
  write(shadow, "replace");
  let applying = false;
  let backing = false;

  const sync = (next: NavLocation) => {
    switch (navStep(shadow, next)) {
      case "none":
        return;
      case "back":
        backing = true;
        history.back();
        return;
      case "replace":
        shadow = { ...next, parent: shadow.parent };
        write(shadow, "replace");
        return;
      case "push":
        shadow = { ...next, parent: shadow };
        write(shadow, "push");
    }
  };
  const unsubscribe = useStore.subscribe((s, prev) => {
    if (applying || backing) return;
    if (s.selectedThreadId === prev.selectedThreadId && s.taskOverlay === prev.taskOverlay) return;
    sync(locationOf(s));
  });

  const onPop = (event: PopStateEvent) => {
    const popped = readEntry((event.state as Record<string, unknown> | null)?.[STATE_KEY]);
    let entry: NavEntry = popped ?? { ...HOME, parent: null };
    const store = useStore.getState();
    // A task deleted since its entry was written cannot be reopened; land on the board instead.
    if (entry.task && !store.threads[entry.task]) {
      entry = { ...HOME, parent: null };
      write(entry, "replace");
    }
    shadow = entry;
    if (backing) {
      backing = false;
      // The store already reflects Close, and may now reflect another open/close. Reconcile the
      // actual browser position with that latest intent instead of replaying an obsolete location.
      sync(locationOf(store));
      return;
    }
    applying = true;
    try {
      if (store.selectedThreadId !== entry.task) store.select(entry.task);
      if (!sameOverlay(useStore.getState().taskOverlay, entry.overlay)) useStore.setState({ taskOverlay: entry.overlay });
    } finally {
      applying = false;
    }
  };
  window.addEventListener("popstate", onPop);

  return () => {
    unsubscribe();
    window.removeEventListener("popstate", onPop);
  };
}
