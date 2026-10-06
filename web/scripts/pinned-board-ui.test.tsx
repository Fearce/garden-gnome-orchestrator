/**
 * Gate: pinned tasks (run with the server half: `npm run test:pinned-tasks --prefix server`).
 *
 *   · a pinned task leads the board under every sort, with drag-and-drop on or off;
 *   · completed tasks hide even when pinned, with an accurate hidden count and reversible filtering;
 *   · the card's pin toggle shows the state and sends one `thread.pin` command.
 */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import type { Thread } from "../src/types.js";
import type { TaskSort } from "../src/store.js";
import "./ssrCssStub.mjs";

// Server rendering reads a store's SERVER snapshot: zustand's is its initial (empty) state, and the
// board's remote-control store has none at all, which throws. This gate renders the board as the
// browser sees it, so every store answers with its live snapshot. Node snapshots a CommonJS module's
// named exports on its first ESM import, so React is patched through require before anything imports it.
const React = createRequire(import.meta.url)("react") as typeof import("react");
const clientSyncExternalStore = React.useSyncExternalStore;
Object.assign(React, {
  useSyncExternalStore: <T,>(subscribe: (cb: () => void) => () => void, getSnapshot: () => T) =>
    clientSyncExternalStore(subscribe, getSnapshot, getSnapshot),
});
Object.assign(globalThis, { React });
const { renderToStaticMarkup } = await import("react-dom/server");
Object.defineProperty(globalThis, "document", { value: { baseURI: "http://localhost/", addEventListener: () => {} }, configurable: true });
Object.defineProperty(globalThis, "location", { value: { protocol: "http:", host: "localhost", search: "", pathname: "/" }, configurable: true });

type SentFrame = { type: string; [key: string]: unknown };
class FakeWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 3;
  static instances: FakeWebSocket[] = [];
  readyState = FakeWebSocket.CONNECTING;
  readonly sent: SentFrame[] = [];
  onopen: (() => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  constructor(readonly url: string) {
    FakeWebSocket.instances.push(this);
  }
  send(raw: string): void {
    this.sent.push(JSON.parse(raw) as SentFrame);
  }
  close(): void {
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.({ code: 1000 });
  }
}
Object.defineProperty(globalThis, "WebSocket", { value: FakeWebSocket, configurable: true });

const { connect, useStore } = await import("../src/store.js");
const { Board, PinButton } = await import("../src/components/Board.js");
connect();
const socket = FakeWebSocket.instances[0]!;
socket.readyState = FakeWebSocket.OPEN;
socket.onopen?.();
socket.sent.length = 0;

const day = 24 * 60 * 60 * 1000;
const now = Date.now();
const task = (id: string, title: string, state: Thread["state"], ageDays: number, pinnedAt: number | null = null): Thread => ({
  id, title, state, workspace: `C:\\repos\\${id}`, createdAt: now - ageDays * day, updatedAt: now - ageDays * day + 60_000, pinnedAt,
});
// The pinned task is the oldest, finished longest ago, and alphabetically and by status the last —
// so every sort would put it at the back if the pin did nothing.
const threads: Record<string, Thread> = Object.fromEntries(
  [
    task("zz-pinned", "Zebra reference task", "done", 40, now - 30 * day),
    task("fresh-running", "Alpha running now", "implementing", 0),
    task("mid-review", "Beta awaiting review", "review", 2),
    task("old-done", "Gamma finished", "done", 10),
  ].map((t) => [t.id, t]),
);

const order = (): string[] =>
  [...renderToStaticMarkup(<Board />).matchAll(/data-thread-id="([^"]+)"/g)].map((m) => m[1]!);
const SORTS: TaskSort[] = ["created_desc", "created_asc", "updated", "status", "workspace", "title"];

useStore.setState({ threads, boardView: "tasks", showCompleted: true, taskOrder: [] });
for (const dnd of [false, true]) {
  for (const sort of SORTS) {
    // Under drag-and-drop the manual order puts the pinned task last on purpose: the pin must still win.
    useStore.setState({ taskDragAndDrop: dnd, taskSort: sort, taskOrder: dnd ? ["fresh-running", "mid-review", "old-done", "zz-pinned"] : [] });
    const ids = order();
    assert.equal(ids.length, 4, `all four tasks render (sort ${sort}, dnd ${dnd})`);
    assert.equal(ids[0], "zz-pinned", `the pinned task leads under sort ${sort} with drag-and-drop ${dnd ? "on" : "off"}: ${ids.join(", ")}`);
  }
}

// Unpinned cards still follow the sort behind the pinned group.
useStore.setState({ taskDragAndDrop: false, taskSort: "created_desc" });
assert.deepEqual(order(), ["zz-pinned", "fresh-running", "mid-review", "old-done"]);

// Done/cancelled pins hide under every sort and DnD mode, but active/review/failed pins stay.
for (const state of ["done", "cancelled", "implementing", "review", "failed"] as const) {
  const completed = state === "done" || state === "cancelled";
  const variant = { ...threads, "zz-pinned": { ...threads["zz-pinned"]!, state } };
  for (const dnd of [false, true]) {
    for (const sort of SORTS) {
      useStore.setState({ threads: variant, showCompleted: false, taskDragAndDrop: dnd, taskSort: sort });
      assert.equal(order().includes("zz-pinned"), !completed, `${state} pin visibility: ${sort}, dnd ${dnd}`);
      assert.match(renderToStaticMarkup(<Board />), completed ? /2 total · 2 completed hidden/ : /3 total · 1 completed hidden/);
      useStore.setState({ showCompleted: true });
      assert.equal(order()[0], "zz-pinned", "showing completed tasks restores the pin at the front");
      assert.equal(useStore.getState().threads["zz-pinned"]!.pinnedAt, threads["zz-pinned"]!.pinnedAt, "filtering preserves the pin");
    }
  }
}
useStore.setState({ threads, showCompleted: true });
const visibleMarkup = renderToStaticMarkup(<Board />);

// The toggle reflects the state, and a press is one command.
assert.match(visibleMarkup, /data-thread-id="zz-pinned" class="card pinned/, "the pinned card is marked");
assert.match(visibleMarkup, /class="card-pin on"[^>]*aria-label="Unpin task"[^>]*aria-pressed="true"/);
assert.match(visibleMarkup, /class="card-pin"[^>]*aria-label="Pin task"[^>]*aria-pressed="false"/);
// Press the real button (PinButton is hook-free, so calling it is an ordinary function call): each press
// sends the opposite of what the card shows, and neither the press nor the click reaches the card.
const press = (id: string) => {
  const thread = useStore.getState().threads[id]!;
  const button = PinButton({ thread }) as React.ReactElement<React.ButtonHTMLAttributes<HTMLButtonElement>>;
  let armedDrag = true;
  let openedCard = true;
  button.props.onPointerDown?.({ stopPropagation: () => (armedDrag = false) } as React.PointerEvent<HTMLButtonElement>);
  button.props.onClick?.({ stopPropagation: () => (openedCard = false) } as React.MouseEvent<HTMLButtonElement>);
  assert.ok(!armedDrag, "pressing the pin does not arm the card's drag");
  assert.ok(!openedCard, "clicking the pin does not also open the task");
};
press("old-done");
press("zz-pinned");
assert.deepEqual(socket.sent, [
  { type: "thread.pin", threadId: "old-done", pinned: true },
  { type: "thread.pin", threadId: "zz-pinned", pinned: false },
]);

console.log("pinned-board-ui: pins lead every sort, respect the completed filter, restore intact, and toggle with one command");
