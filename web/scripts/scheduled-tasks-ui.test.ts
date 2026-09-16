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
import { storedPin } from "../src/lib/schedulePin.js";
import type { ScheduledTask } from "../src/types.js";

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

// --- the implementor pin: a schedule may name an exact provider + model ---------------------------
//
// The pin is a PAIR. A model id on its own is re-read as owner wording on every fire, against whatever
// roster is live then — which is the whole reason the provider exists: a schedule may not fire for
// weeks, and rosters move underneath it. So the two halves must travel together everywhere, and a half
// pin must never be storable: it would read on the card as pinned while routing automatically.
const ROSTERS = [
  { provider: "claude" as const, models: ["claude-opus-5", "claude-sonnet-5"] },
  { provider: "codex" as const, models: ["gpt-5.6-sol", "gpt-5.6-luna"] },
];
const row = (pin: Partial<ScheduledTask>): ScheduledTask => ({ ...saved, ...pin } as ScheduledTask);

assert.equal(storedPin(ROSTERS, null), null, "no schedule is no pin");
assert.equal(storedPin(ROSTERS, row({ model: null })), null, "no model is no pin — Auto routing");
assert.deepEqual(
  storedPin(ROSTERS, row({ model: "gpt-5.6-sol", provider: "codex" })),
  { provider: "codex", model: "gpt-5.6-sol" },
  "a saved pair is read back as that exact pair",
);
assert.deepEqual(
  storedPin(ROSTERS, row({ model: "claude-opus-5" })),
  { provider: "claude", model: "claude-opus-5" },
  "a pin saved before the provider column, whose id a live roster still publishes, resolves to the pair",
);
assert.deepEqual(
  storedPin(ROSTERS, row({ model: "GPT Spark" })),
  { provider: null, model: "GPT Spark" },
  "wording no roster publishes is kept verbatim — guessing at it here would repoint the owner's schedule",
);
assert.deepEqual(
  storedPin(ROSTERS, row({ model: "  gpt-5.6-luna  " })),
  { provider: "codex", model: "gpt-5.6-luna" },
  "a stored id is trimmed to the roster's own spelling, so the editor's select can match an option",
);

// The disconnect case above left the socket closed; a write has to reach it again from here.
socket.readyState = FakeWebSocket.OPEN;
socket.sent.length = 0;
assert.equal(
  useStore.getState().createSchedule({ ...input, model: "gpt-5.6-sol", provider: "codex" }),
  true,
);
const pinCmd = socket.sent[0]!;
assert.equal(pinCmd.model, "gpt-5.6-sol", "the create carries the pinned model");
assert.equal(pinCmd.provider, "codex", "…and the backend it belongs to, so the pair stays exact");
const pinned = useStore.getState().schedules.at(-1);
assert.equal(pinned?.model, "gpt-5.6-sol", "the projected card shows the pin in the same click");
assert.equal(pinned?.provider, "codex");

// Mirrors Scheduler.sanitize: a provider with no model pins nothing, so the server drops it. The
// projection has to drop it too, or the card claims a pin until the authoritative list corrects it.
socket.sent.length = 0;
assert.equal(useStore.getState().createSchedule({ ...input, provider: "codex" }), true);
assert.equal(
  useStore.getState().schedules.at(-1)?.provider,
  null,
  "a provider with no model is not a pin, and must not be projected as one",
);

socket.sent.length = 0;
assert.equal(useStore.getState().updateSchedule("schedule-1", { model: null, provider: null }), true);
assert.deepEqual(
  socket.sent,
  [{ type: "schedule.update", id: "schedule-1", patch: { model: null, provider: null } }],
  "clearing the pin clears both halves — a stale backend must never outlive the model it named",
);
useStore.setState({ schedules: [] });

const component = readFileSync(resolve(import.meta.dirname, "..", "src", "components", "ScheduledTasks.tsx"), "utf8");
assert.match(component, /const saved = initial \? updateSchedule\([\s\S]*?if \(saved\) onClose\(\)/, "the editor stays open when its command was not sent");

console.log("Scheduled-task controls update immediately without a per-click snapshot, and disconnected writes stay visible.");
process.exit(0);
