import assert from "node:assert/strict";
import { HOME, installNavHistory, navStep, readEntry, type NavEntry, type NavStore } from "../src/lib/navHistory.js";
import type { TaskOverlay } from "../src/types.js";

/**
 * The iPhone Back/Forward contract for task layers, without a browser: which history operation each
 * open/close takes, and the whole sync run against a stand-in store and a stand-in `history` that
 * behaves like the real one (pushState truncates the forward stack, back/forward fire popstate
 * asynchronously). The real gesture and the layout are driven by `npm run ios-nav-lab --prefix server`.
 *
 * Run: npm run test:nav-history --prefix server
 */

// ---- navStep: the decision table ----
const entry = (task: string | null, overlay: TaskOverlay | null = null, parent: NavEntry | null = null): NavEntry => ({ task, overlay, parent });
const home = entry(null);
const taskA = entry("A", null, home);
const memoA = entry("A", { kind: "memo", memoId: "m1" }, taskA);

assert.equal(navStep(home, { task: "A", overlay: null }), "push", "opening a task pushes");
assert.equal(navStep(taskA, { task: "A", overlay: { kind: "memo", memoId: "m1" } }), "push", "opening a memo pushes");
assert.equal(navStep(memoA, { task: "A", overlay: null }), "back", "closing the memo steps back onto the task entry");
assert.equal(navStep(taskA, HOME), "back", "closing the task steps back onto the board entry");
assert.equal(navStep(taskA, { task: "A", overlay: null }), "none", "an unchanged location writes nothing");
assert.equal(navStep(entry("A"), HOME), "replace", "a close with no entry to return to replaces, so Back cannot reopen it");
assert.equal(navStep(taskA, { task: "B", overlay: null }), "push", "switching task pushes, so Back returns to the first");
assert.equal(navStep(memoA, { task: "A", overlay: { kind: "memo", memoId: "m2" } }), "replace", "revision browsing updates the memo entry without another layer");
assert.equal(
  navStep(entry("A", { kind: "deliverable", findingId: "f1" }, taskA), { task: "A", overlay: null }),
  "back",
  "a deliverable preview closes the same way",
);

// ---- readEntry: only this module's own state is trusted ----
assert.equal(readEntry(null), null);
assert.equal(readEntry("A"), null);
assert.equal(readEntry({ task: 42 }), null);
assert.deepEqual(readEntry({ task: "A", overlay: { kind: "memo" } }), entry("A"), "a malformed overlay is dropped, the task kept");
assert.deepEqual(readEntry({ task: null, overlay: { kind: "changes" } }), entry(null), "no overlay without a task");
assert.deepEqual(readEntry(memoA), memoA);

// ---- the sync, end to end ----
type Listener = (event: { state: unknown }) => void;
const popListeners = new Set<Listener>();
const stack: unknown[] = [null];
let index = 0;
const pending: Array<() => void> = [];
const traverse = (delta: number) =>
  pending.push(() => {
    const target = index + delta;
    if (target < 0 || target >= stack.length) return;
    index = target;
    for (const fn of popListeners) fn({ state: stack[index] });
  });
const fakeHistory = {
  get state() {
    return stack[index];
  },
  get length() {
    return stack.length;
  },
  pushState(state: unknown) {
    stack.splice(index + 1);
    stack.push(state);
    index++;
  },
  replaceState(state: unknown) {
    stack[index] = state;
  },
  back: () => traverse(-1),
  forward: () => traverse(1),
};
Object.assign(globalThis, {
  history: fakeHistory,
  window: {
    addEventListener: (type: string, fn: Listener) => type === "popstate" && popListeners.add(fn),
    removeEventListener: (type: string, fn: Listener) => type === "popstate" && popListeners.delete(fn),
  },
});
/** Lets queued back/forward traversals land, the way the browser fires popstate after the call. */
const settle = () => {
  while (pending.length) pending.shift()!();
};

type State = ReturnType<NavStore["getState"]>;
const listeners = new Set<(s: State, prev: State) => void>();
let state: State;
const commit = (patch: Partial<State>) => {
  const prev = state;
  state = { ...state, ...patch };
  for (const fn of listeners) fn(state, prev);
};
state = {
  selectedThreadId: null,
  taskOverlay: null,
  threads: { A: {}, B: {} },
  // Mirrors store.select: a new selection drops the layer that belonged to the old one.
  select: (id) => commit({ selectedThreadId: id, taskOverlay: id === state.selectedThreadId ? state.taskOverlay : null }),
};
const store: NavStore = {
  getState: () => state,
  setState: (patch) => commit(patch),
  subscribe: (fn) => {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },
};
const memo = (memoId: string): TaskOverlay => ({ kind: "memo", memoId });
const where = () => ({ task: state.selectedThreadId, overlay: state.taskOverlay });

const teardown = installNavHistory(store);
assert.equal(stack.length, 1, "installing replaces the current entry instead of adding one");

// Board -> task -> memo, then the memo's own Close: one step back, onto the task.
state.select("A");
store.setState({ taskOverlay: memo("m1") });
assert.equal(stack.length, 3);
assert.equal(index, 2);
store.setState({ taskOverlay: null });
settle();
assert.equal(index, 1, "Close on the memo returns to the task's entry");
assert.deepEqual(where(), { task: "A", overlay: null });

// Browser Back from the task lands on the board; Forward reopens the task, then the memo.
fakeHistory.back();
settle();
assert.deepEqual(where(), { task: null, overlay: null }, "Back closes the task");
fakeHistory.forward();
settle();
assert.deepEqual(where(), { task: "A", overlay: null }, "Forward reopens the task");
fakeHistory.forward();
settle();
assert.deepEqual(where(), { task: "A", overlay: memo("m1") }, "Forward reopens the memo it was showing");
assert.equal(stack.length, 3, "Back/Forward write no entries of their own");

// Back from the memo closes only the memo; the task stays open underneath.
fakeHistory.back();
settle();
assert.deepEqual(where(), { task: "A", overlay: null }, "Back from the memo keeps the task open");

// Repeated open/close does not grow history.
for (let i = 0; i < 5; i++) {
  store.setState({ taskOverlay: memo("m1") });
  store.setState({ taskOverlay: null });
  settle();
}
assert.equal(index, 1);
assert.equal(stack.length, 3, "re-opening reuses the forward slot instead of stacking entries");

// Close the task with its own Close: back onto the board entry, and Back from there leaves the app.
state.select(null);
settle();
assert.equal(index, 0);
assert.deepEqual(where(), { task: null, overlay: null });

// Switching tasks pushes; Back returns to the first task.
state.select("A");
state.select("B");
assert.equal(index, 2);
fakeHistory.back();
settle();
assert.deepEqual(where(), { task: "A", overlay: null }, "Back after switching returns to the originating task");

// A task deleted while it sat in history is not reopened by Forward: the console lands on the board.
delete (state.threads as Record<string, unknown>).B;
fakeHistory.forward();
settle();
assert.deepEqual(where(), { task: null, overlay: null }, "a deleted task reads as the board");

// A second action can arrive before the browser completes Close's asynchronous traversal.
state.select("A");
store.setState({ taskOverlay: memo("m1") });
store.setState({ taskOverlay: null });
store.setState({ taskOverlay: memo("m2") });
settle();
assert.deepEqual(where(), { task: "A", overlay: memo("m2") }, "quick close/reopen keeps the owner's latest action");
assert.deepEqual(readEntry((fakeHistory.state as { ggoNav: unknown }).ggoNav)?.overlay, memo("m2"));
store.setState({ taskOverlay: null });
state.select(null);
settle();
assert.deepEqual(where(), HOME, "closing both layers before popstate lands returns to the board");

teardown();
state.select("A");
assert.equal(listeners.size, 0, "teardown unsubscribes from the store");
assert.equal(popListeners.size, 0, "teardown removes the popstate listener");

console.log("nav-history: all checks passed");
