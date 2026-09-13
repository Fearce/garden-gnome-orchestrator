/**
 * UI/store regression gate for schedule controls. A schedule write must project immediately instead of
 * waiting for the 20-second heartbeat; a disconnected write must fail visibly so the editor can stay
 * open. It must ALSO stay cheap: a mutation sends its own command and nothing else, because a per-click
 * `snapshot.request` puts another ~1.3 MB `hello` on the socket whose head-of-line delay caused the
 * reported lag (the small `schedules` broadcast the server already emits is what reconciles it).
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

Object.defineProperty(globalThis, "document", {
  value: { baseURI: "http://localhost/", addEventListener: () => {} },
  configurable: true,
});
Object.defineProperty(globalThis, "location", {
  value: { protocol: "http:", host: "localhost", search: "", pathname: "/" },
  configurable: true,
});

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
connect();
const socket = FakeWebSocket.instances[0]!;
assert.equal(socket.url, "ws://localhost/ws");
socket.readyState = FakeWebSocket.OPEN;
socket.onopen?.();
socket.sent.length = 0; // ignore connect's initial recovery snapshot

const input = {
  title: "Nightly audit",
  workspace: "test-workspace",
  prompt: "Run the audit",
  cron: "0 3 * * *",
  enabled: true,
};

assert.equal(useStore.getState().createSchedule(input), true);
assert.deepEqual(socket.sent.map((frame) => frame.type), ["schedule.create"], "a create costs one small command, never a full snapshot");
assert.equal(socket.sent[0]!.title, input.title);
// Optional-chained on purpose: without the local projection there is no row here at all, and a `!`
// would die with a TypeError that names this line instead of the missing behaviour (see
// .claude/rules/threadmanager-itest.md on revert-checking a gate).
const pending = useStore.getState().schedules[0];
assert.ok(pending, "the create projects a card in the same click instead of waiting for the server");
assert.match(pending?.id ?? "", /^pending:/);
assert.equal(pending?.title, input.title);
assert.equal(pending?.enabled, true);

const saved = {
  ...pending,
  id: "schedule-1",
  nextRunAt: Date.now() + 60_000,
};
socket.onmessage?.({ data: JSON.stringify({ type: "schedules", schedules: [saved] }) });
assert.deepEqual(useStore.getState().schedules, [saved], "the server list replaces the pending projection");

socket.sent.length = 0;
assert.equal(useStore.getState().updateSchedule("schedule-1", { enabled: false }), true);
assert.deepEqual(socket.sent, [{ type: "schedule.update", id: "schedule-1", patch: { enabled: false } }]);
assert.equal(useStore.getState().schedules[0]?.enabled, false, "the switch updates without waiting for the server");
assert.equal(useStore.getState().schedules[0]?.nextRunAt, null);

socket.sent.length = 0;
assert.equal(useStore.getState().deleteSchedule("schedule-1"), true);
assert.deepEqual(socket.sent.map((frame) => frame.type), ["schedule.delete"]);
assert.deepEqual(useStore.getState().schedules, [], "delete removes the card without waiting for the server");

socket.readyState = FakeWebSocket.CLOSED;
socket.sent.length = 0;
useStore.setState({ notice: null });
assert.equal(useStore.getState().updateSchedule("schedule-1", { enabled: true }), false);
assert.deepEqual(socket.sent, []);
assert.deepEqual(useStore.getState().schedules, [], "a disconnected write does not project a change that was never sent");
assert.equal(useStore.getState().notice?.title, "Schedule not changed");
assert.match(useStore.getState().notice?.message ?? "", /reconnecting/i);

const component = readFileSync(resolve(import.meta.dirname, "..", "src", "components", "ScheduledTasks.tsx"), "utf8");
assert.match(component, /const saved = initial \? updateSchedule\([\s\S]*?if \(saved\) onClose\(\)/, "the editor stays open when its command was not sent");

console.log("Scheduled-task controls update immediately without a per-click snapshot, and disconnected writes stay visible.");
process.exit(0);
