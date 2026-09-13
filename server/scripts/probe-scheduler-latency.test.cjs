const assert = require("node:assert/strict");
const path = require("node:path");
const os = require("node:os");
const { EventEmitter } = require("node:events");
const {
  FIXTURE_PREFIX,
  createFixture,
  parseArgs,
  runProbe,
  slowLegs,
  usage,
} = require("./probe-scheduler-latency.cjs");

class FakeScheduleServer {
  constructor() {
    this.schedules = [];
    this.sockets = new Set();
    this.nextId = 1;
    this.suppressBroadcastFor = null;
  }

  connect(socket) {
    this.sockets.add(socket);
    queueMicrotask(() => {
      socket.readyState = 1;
      socket.emit("open");
      socket.deliver({ type: "hello", schedules: this.snapshot() });
    });
  }

  snapshot() {
    return this.schedules.map((schedule) => ({ ...schedule }));
  }

  broadcast(commandType) {
    if (this.suppressBroadcastFor === commandType) {
      this.suppressBroadcastFor = null;
      return;
    }
    const event = { type: "schedules", schedules: this.snapshot() };
    for (const socket of this.sockets) socket.deliver(event);
  }

  receive(socket, command) {
    if (command.type === "schedule.create") {
      const now = Date.now();
      const { type: _type, ...input } = command;
      this.schedules.push({
        ...input,
        id: `schedule-${this.nextId++}`,
        effort: null,
        lastRunAt: null,
        nextRunAt: null,
        lastThreadId: null,
        createdAt: now,
        updatedAt: now,
      });
      this.broadcast(command.type);
      return;
    }
    if (command.type === "schedule.update") {
      this.schedules = this.schedules.map((schedule) =>
        schedule.id === command.id ? { ...schedule, ...command.patch, updatedAt: Date.now() } : schedule,
      );
      this.broadcast(command.type);
      return;
    }
    if (command.type === "schedule.delete") {
      this.schedules = this.schedules.filter((schedule) => schedule.id !== command.id);
      this.broadcast(command.type);
      return;
    }
    if (command.type === "snapshot.request") {
      socket.deliver({ type: "hello", schedules: this.snapshot() });
    }
  }
}

function fakeWebSocket(server) {
  return class FakeWebSocket extends EventEmitter {
    constructor() {
      super();
      this.OPEN = 1;
      this.readyState = 0;
      server.connect(this);
    }

    send(raw) {
      server.receive(this, JSON.parse(raw));
    }

    deliver(event) {
      const payload = JSON.stringify(event);
      queueMicrotask(() => {
        if (this.readyState === this.OPEN) this.emit("message", payload);
      });
    }

    close() {
      if (this.readyState === 3) return;
      this.readyState = 3;
      server.sockets.delete(this);
      this.emit("close");
    }
  };
}

function options(timeoutMs = 100) {
  return {
    url: "http://127.0.0.1:4317",
    timeoutMs,
    slowMs: 50,
    confirm: true,
    json: false,
    help: false,
    password: "not-used-by-the-fake",
  };
}

function dependencies(server) {
  return {
    WebSocketImpl: fakeWebSocket(server),
    fetchImpl: async () => ({ ok: true, status: 200 }),
    loginFn: async () => "session=fake",
    now: () => 1_789_260_000_000,
    token: () => "12345678-1234-4234-8234-123456789abc",
    repoDir: path.join(os.tmpdir(), "scheduler-latency-probe-test-root"),
  };
}

assert.deepEqual(parseArgs([]), {
  url: "http://127.0.0.1:4317",
  timeoutMs: 45_000,
  slowMs: 1_000,
  confirm: false,
  json: false,
  help: false,
});
assert.deepEqual(parseArgs(["--confirm", "--json", "--timeout-ms", "2500", "--slow-ms", "300", "--url", "https://example.test/base/"]), {
  url: "https://example.test/base",
  timeoutMs: 2_500,
  slowMs: 300,
  confirm: true,
  json: true,
  help: false,
});
assert.throws(() => parseArgs(["--timeout-ms", "0"]), /integer from 1/);
assert.throws(() => parseArgs(["--url", "ftp://example.test"]), /http or https/);
assert.throws(() => parseArgs(["--unknown"]), /unknown argument/);
assert.match(usage(), /--confirm/);

const fixture = createFixture(1_789_260_000_000, "12345678-1234-4234-8234-123456789abc", "fixture-root");
assert.match(fixture.title, new RegExp(`^${FIXTURE_PREFIX}`));
assert.equal(fixture.enabled, false);
assert.equal(fixture.cron, "59 23 31 12 *");
assert.equal(fixture.workspace, path.join("fixture-root", ".scheduler-latency-probe-workspace-12345678-1234-4234-8234-123456789abc"));
assert.deepEqual(slowLegs({ timings: { createMs: 4, enableMs: 80, note: "ignored" } }, 50), [{ name: "enableMs", ms: 80 }]);

(async () => {
  const healthyServer = new FakeScheduleServer();
  const healthy = await runProbe(options(), dependencies(healthyServer));
  assert.equal(healthy.ok, true, healthy.error);
  assert.equal(healthy.cleanup.verified, true);
  assert.deepEqual(healthyServer.schedules, [], "the normal path leaves no fixture behind");
  for (const leg of ["createMs", "enableMs", "disableMs", "deleteMs"]) {
    assert.equal(typeof healthy.timings[leg], "number", `${leg} is measured`);
  }

  const droppedBroadcastServer = new FakeScheduleServer();
  droppedBroadcastServer.suppressBroadcastFor = "schedule.update";
  const failed = await runProbe(options(20), dependencies(droppedBroadcastServer));
  assert.equal(failed.ok, false, "a missing mutation receipt fails the probe");
  assert.match(failed.error, /timed out.*enable schedules broadcast/);
  assert.equal(failed.cleanup.verified, true, "cleanup is independently checked on a fresh socket");
  assert.equal(failed.cleanup.removed, true, "cleanup removes a mutation that landed before its receipt was lost");
  assert.deepEqual(droppedBroadcastServer.schedules, [], "the failure path leaves no fixture behind");

  const droppedCreateServer = new FakeScheduleServer();
  droppedCreateServer.schedules.push({ id: "keep-this", title: "Owner schedule", enabled: true });
  droppedCreateServer.suppressBroadcastFor = "schedule.create";
  const unknownId = await runProbe(options(20), dependencies(droppedCreateServer));
  assert.equal(unknownId.ok, false, "a lost create receipt fails the probe");
  assert.equal(unknownId.cleanup.verified, true, "cleanup finds an unacknowledged create by its unique title");
  assert.equal(unknownId.cleanup.removed, true);
  assert.deepEqual(
    droppedCreateServer.schedules.map((schedule) => schedule.id),
    ["keep-this"],
    "cleanup removes only its fixture and preserves owner schedules",
  );

  console.log("scheduler-latency probe: arguments, CRUD timings, and failure cleanup verified");
})().catch((error) => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
