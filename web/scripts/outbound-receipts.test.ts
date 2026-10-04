import assert from "node:assert/strict";

// The task feed's "Sending…" line: it must stop spinning once GGO holds the instruction, keep replaying
// under the same id until the final reply, and leave a refused message recoverable instead of lost.

const storage = new Map<string, string>();
const timers = new Map<number, () => void>();
let nextTimer = 0;
class Socket {
  static OPEN = 1;
  static CLOSED = 3;
  static instances: Socket[] = [];
  readyState = 0;
  sent: Array<{ type: string; clientId?: string; message?: string }> = [];
  onopen?: () => void;
  onmessage?: (event: { data: string }) => void;
  constructor(public url: string) { Socket.instances.push(this); }
  send(data: string) { this.sent.push(JSON.parse(data)); }
  receive(event: unknown) { this.onmessage?.({ data: JSON.stringify(event) }); }
}
Object.assign(globalThis, {
  document: { baseURI: "https://example.test/", addEventListener() {} },
  location: { protocol: "https:", host: "example.test" },
  localStorage: { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value), removeItem: (key: string) => storage.delete(key) },
  WebSocket: Socket,
  setTimeout: (callback: () => void) => { const id = ++nextTimer; timers.set(id, callback); return id; },
  setInterval: (callback: () => void) => { const id = ++nextTimer; timers.set(id, callback); return id; },
  clearTimeout: (id: number) => timers.delete(id),
  clearInterval: (id: number) => timers.delete(id),
});
const { useStore, connect } = await import("../src/store.js");
const hello = { type: "hello", threads: [], runs: [], findings: [], questions: [], accounts: [], approvalMode: false, director: [] };
const outbound = (id: string) => useStore.getState().outboundMessages.find((m) => m.id === id);
const onlyMessage = () => {
  const all = useStore.getState().outboundMessages;
  assert.equal(all.length, 1, JSON.stringify(all));
  return all[0]!;
};

connect();
let socket = Socket.instances.at(-1)!;
socket.readyState = 1;
socket.onopen?.();
socket.receive(hello);

// Accepted: the spinner ends while the final result is still pending, and the id keeps replaying.
await useStore.getState().inject("task-1", "epic fail, I cant delete events", "append");
const first = onlyMessage();
assert.equal(first.status, "sending");
assert.equal(socket.sent.at(-1)?.clientId, first.id);
socket.receive({ type: "thread.inject.accepted", threadId: "task-1", clientId: first.id });
assert.equal(outbound(first.id)?.status, "accepted", "GGO holding the instruction ends Sending…");
assert.ok(storage.get("orch-outbound-outbox-v1")?.includes(first.id), "an accepted message still survives a reload until its result lands");
connect();
socket = Socket.instances.at(-1)!;
socket.readyState = 1;
socket.onopen?.();
socket.receive(hello);
assert.equal(socket.sent.at(-1)?.clientId, first.id, "a reconnect replays the accepted instruction under its own id");
socket.receive({ type: "thread.action", threadId: "task-1", action: "inject", clientId: first.id, ok: true, result: { ok: true } });
assert.equal(useStore.getState().outboundMessages.length, 0, "the final result clears it");
assert.equal(storage.has("orch-outbound-outbox-v1"), false);

// Retry now: the same id again, never a second instruction.
await useStore.getState().inject("task-1", "retry me", "append");
const slow = onlyMessage();
const before = socket.sent.length;
useStore.getState().retryOutbound(slow.id);
assert.equal(socket.sent.length, before + 1);
assert.equal(socket.sent.at(-1)?.clientId, slow.id, "Retry now replays the same delivery id");
assert.equal(outbound(slow.id)?.status, "sending");

// Refused: kept, with its reason, and Send again issues a fresh id for the same words.
socket.receive({ type: "thread.action", threadId: "task-1", action: "inject", clientId: slow.id, ok: false, error: "No such task.", result: { ok: false } });
const failed = onlyMessage();
assert.equal(failed.status, "failed");
assert.equal(failed.error, "No such task.");
assert.equal(failed.resendable, true, "a refused message can be sent again");
const afterFailure = socket.sent.length;
socket.receive(hello);
assert.equal(socket.sent.length, afterFailure, "a failed message is never replayed on its own");
useStore.getState().retryOutbound(slow.id);
const resent = onlyMessage();
assert.notEqual(resent.id, slow.id, "Send again uses a new delivery id");
assert.equal(resent.status, "sending");
assert.equal(resent.content, "retry me");
assert.equal(resent.error, undefined);
assert.deepEqual(socket.sent.at(-1), { type: "thread.inject", threadId: "task-1", message: "retry me", mode: "append", clientId: resent.id });

// Dismiss: gone for good.
socket.receive({ type: "thread.action", threadId: "task-1", action: "inject", clientId: resent.id, ok: false, error: "Still no task.", result: { ok: false } });
useStore.getState().dismissOutbound(resent.id);
assert.equal(useStore.getState().outboundMessages.length, 0, "Dismiss removes a failed message");
const afterDismiss = socket.sent.length;
socket.receive(hello);
useStore.getState().retryOutbound(resent.id);
assert.equal(socket.sent.length, afterDismiss, "a dismissed message cannot come back");

// A message still sending is not dismissable: silence is not proof it was lost.
await useStore.getState().inject("task-1", "in flight", "append");
const inFlight = onlyMessage();
useStore.getState().dismissOutbound(inFlight.id);
assert.equal(outbound(inFlight.id)?.status, "sending", "Dismiss never drops an unconfirmed message");

console.log("Outbound receipts passed: accepted ends Sending, replay keeps one id, refused messages resend or dismiss.");
