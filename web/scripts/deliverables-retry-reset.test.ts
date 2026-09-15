/**
 * Regression gate for the store's `thread.reset` handling: a Retry used to wipe a task's owner-facing
 * deliverable cards from the console along with its transient run/feed/finding rows (`.claude/rules/
 * deliverables.md`). The server now republishes the preserved deliverable findings directly on the
 * `thread.reset` event, and `applyEvent`'s "thread.reset" case must fold them back into BOTH `findings`
 * and the durable `threadDeliverables` index rather than dropping them with everything else. Unlike
 * `deliverables-ui.test.tsx` (which drives the pure merge helpers in isolation), this drives the real
 * store reducer end-to-end over a fake WebSocket — the same pattern as `scheduled-tasks-ui.test.ts` —
 * so a regression in `store.ts`'s own "thread.reset" case (not just in `threadDeliverables.ts`) is
 * caught too.
 */
import assert from "node:assert/strict";
import type { Finding } from "../src/types.js";

Object.defineProperty(globalThis, "document", {
  value: { baseURI: "http://localhost/", addEventListener: () => {} },
  configurable: true,
});
Object.defineProperty(globalThis, "location", {
  value: { protocol: "http:", host: "localhost", search: "", pathname: "/" },
  configurable: true,
});

class FakeWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 3;
  static instances: FakeWebSocket[] = [];

  readyState = FakeWebSocket.CONNECTING;
  readonly sent: unknown[] = [];
  onopen: (() => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;

  constructor(readonly url: string) {
    FakeWebSocket.instances.push(this);
  }

  send(raw: string): void {
    this.sent.push(JSON.parse(raw));
  }

  close(): void {
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.({ code: 1000 });
  }
}

Object.defineProperty(globalThis, "WebSocket", { value: FakeWebSocket, configurable: true });

const { connect, useStore } = await import("../src/store.js");
connect();
const socket = FakeWebSocket.instances[0]!;
socket.readyState = FakeWebSocket.OPEN;
socket.onopen?.();
socket.sent.length = 0; // ignore connect's own snapshot.request

const THREAD = "retried-task";
const OTHER = "unrelated-task";

const deliverable = (id: string, createdAt: number): Finding => ({
  id,
  threadId: THREAD,
  fromRunId: "run-before-retry",
  fromRole: "implementor",
  kind: "deliverable",
  summary: id,
  detail: null,
  path: `C:/work/${id}.png`,
  label: id,
  severity: "info",
  routed: false,
  createdAt,
});

const ordinaryFinding: Finding = {
  id: "route-note",
  threadId: THREAD,
  fromRunId: null,
  fromRole: "director",
  kind: "finding",
  summary: "Usage-aware routing chose Codex",
  detail: null,
  path: null,
  label: null,
  severity: "info",
  routed: false,
  createdAt: 1,
};

const otherThreadFinding: Finding = { ...ordinaryFinding, id: "other-thread-note", threadId: OTHER };

const preserved = [deliverable("overview.png", 10), deliverable("rationale.md", 20)];

// Seed the pre-retry state: two owner-facing deliverable cards plus an ordinary finding, a feed entry
// and a history cursor for the task being retried, and an unrelated task's own finding that must survive
// untouched.
useStore.setState({
  findings: [...preserved, ordinaryFinding, otherThreadFinding],
  threadDeliverables: { [THREAD]: preserved },
  threadFeeds: { [THREAD]: [{ kind: "text", at: 5, role: "implementor", runId: "run-before-retry", id: "m1", text: "old transcript" }] },
  threadHistoryCursors: { [THREAD]: { id: "m1", seq: 1 } },
});

console.log("\nA. a Retry republishes deliverables instead of dropping them");
socket.onmessage?.({ data: JSON.stringify({ type: "thread.reset", threadId: THREAD, deliverables: preserved }) });

const afterReset = useStore.getState();
assert.deepEqual(
  afterReset.findings.filter((f) => f.threadId === THREAD).map((f) => f.id).sort(),
  ["overview.png", "rationale.md"],
  "the retried task's ordinary finding is dropped but its deliverable cards remain",
);
assert.deepEqual(
  afterReset.threadDeliverables[THREAD]?.map((f) => f.id).sort(),
  ["overview.png", "rationale.md"],
  "the durable per-thread deliverables index keeps both cards across the reset",
);
assert.equal(afterReset.threadFeeds[THREAD], undefined, "the transient feed is still pruned like every other retry-cleared slice");
assert.equal(afterReset.threadHistoryCursors[THREAD], undefined, "the history cursor is still pruned");
assert.ok(
  afterReset.findings.some((f) => f.id === "other-thread-note"),
  "an unrelated task's finding is untouched by another task's retry",
);

console.log("\nB. a Retry with nothing to preserve leaves no dangling empty entry");
useStore.setState({
  findings: [ordinaryFinding],
  threadDeliverables: {},
  threadFeeds: { [THREAD]: [] },
});
socket.onmessage?.({ data: JSON.stringify({ type: "thread.reset", threadId: THREAD, deliverables: [] }) });
const afterEmptyReset = useStore.getState();
assert.equal(
  THREAD in afterEmptyReset.threadDeliverables,
  false,
  "no deliverables survived, so the index gets no empty placeholder entry for this thread",
);
assert.equal(afterEmptyReset.findings.filter((f) => f.threadId === THREAD).length, 0);

console.log("\nStore-level thread.reset regression: Retry preserves deliverable cards end-to-end, prunes everything else, and leaves other tasks untouched.");
process.exit(0);
