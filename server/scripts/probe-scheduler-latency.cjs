#!/usr/bin/env node
// Measure the real scheduled-task CRUD round trip against a RUNNING instance. This is the reusable
// version of the authenticated WebSocket probes that diagnosed the 20-30s UI delay on 2026-09-13.
// It creates one disabled inert fixture, enables it, disables it, deletes it, then opens a fresh socket
// to verify cleanup. The fixture points at a deliberately absent workspace, so even a failed cleanup
// cannot dispatch work when its far-future cron eventually becomes due.
//
// This probe MUTATES the schedule list. It refuses to run without --confirm:
//   npm run probe:scheduler-latency --prefix server -- --confirm
//   npm run probe:scheduler-latency --prefix server -- --confirm --json
// From server/, `node scripts/probe-scheduler-latency.cjs --confirm` is equivalent.

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const WebSocket = require("ws");
const { login, passwordFromEnvOrDotenv, socketUrl } = require("./inject-thread.cjs");

const DEFAULT_URL = "http://127.0.0.1:4317";
// The reported regression was a 20-30s wait. Keep the default above that window so the probe records
// the slow receipt instead of timing out just before the evidence arrives.
const DEFAULT_TIMEOUT_MS = 45_000;
const DEFAULT_SLOW_MS = 1_000;
const FIXTURE_PREFIX = "__scheduler_latency_probe__";
const SAFE_CRON = "59 23 31 12 *";
const SERVER_DIR = path.resolve(__dirname, "..");
const REPO_DIR = path.resolve(SERVER_DIR, "..");

function usage(error) {
  return [
    error ? `error: ${error}` : null,
    "usage: node scripts/probe-scheduler-latency.cjs --confirm [--url http://host:port] [--timeout-ms N] [--slow-ms N] [--json]",
    "",
    "Creates, enables, disables, and deletes one inert temporary schedule, then verifies cleanup",
    "through a fresh authenticated WebSocket. Without --confirm, nothing is changed.",
  ].filter(Boolean).join("\n");
}

function positiveInteger(raw, flag) {
  const value = Number(raw);
  if (!raw || !Number.isInteger(value) || value < 1 || value > 120_000) {
    throw new Error(`${flag} must be an integer from 1 to 120000`);
  }
  return value;
}

function parseArgs(argv) {
  const options = {
    url: DEFAULT_URL,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    slowMs: DEFAULT_SLOW_MS,
    confirm: false,
    json: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--confirm") options.confirm = true;
    else if (arg === "--json") options.json = true;
    else if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg === "--url") {
      const value = argv[++i];
      if (!value) throw new Error("--url requires a value");
      options.url = value;
    } else if (arg === "--timeout-ms") {
      options.timeoutMs = positiveInteger(argv[++i], "--timeout-ms");
    } else if (arg === "--slow-ms") {
      options.slowMs = positiveInteger(argv[++i], "--slow-ms");
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  if (options.help) return options;
  let parsed;
  try {
    parsed = new URL(options.url);
  } catch {
    throw new Error("--url must be an absolute http(s) URL");
  }
  if (!/^https?:$/.test(parsed.protocol)) throw new Error("--url must use http or https");
  options.url = parsed.toString().replace(/\/$/, "");
  return options;
}

function createFixture(now = Date.now(), token = crypto.randomUUID(), repoDir = REPO_DIR) {
  return {
    title: `${FIXTURE_PREFIX}${new Date(now).toISOString()}_${token.slice(0, 8)}`,
    workspace: path.join(repoDir, `.scheduler-latency-probe-workspace-${token}`),
    prompt: "Temporary scheduler latency probe. Safe to delete.",
    cron: SAFE_CRON,
    enabled: false,
    id: null,
  };
}

class EventSocket {
  constructor(socket, timeoutMs) {
    this.socket = socket;
    this.timeoutMs = timeoutMs;
    this.waiters = new Set();
    socket.on("message", (raw) => this.accept(raw));
    socket.on("error", (error) => this.rejectAll(new Error(`WebSocket failed: ${error.message}`)));
    socket.on("close", () => this.rejectAll(new Error("WebSocket closed before the expected reply")));
  }

  accept(raw) {
    let event;
    try {
      event = JSON.parse(String(raw));
    } catch {
      return;
    }
    for (const waiter of [...this.waiters]) {
      if (!waiter.predicate(event)) continue;
      clearTimeout(waiter.timer);
      this.waiters.delete(waiter);
      waiter.resolve(event);
    }
  }

  rejectAll(error) {
    for (const waiter of this.waiters) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    this.waiters.clear();
  }

  waitFor(predicate, label) {
    return new Promise((resolve, reject) => {
      const waiter = { predicate, resolve, reject, timer: null };
      waiter.timer = setTimeout(() => {
        this.waiters.delete(waiter);
        reject(new Error(`timed out after ${this.timeoutMs}ms waiting for ${label}`));
      }, this.timeoutMs);
      this.waiters.add(waiter);
    });
  }

  send(command) {
    if (this.socket.readyState !== WebSocket.OPEN && this.socket.readyState !== this.socket.OPEN) {
      throw new Error("WebSocket is not open");
    }
    this.socket.send(JSON.stringify(command));
  }

  close() {
    try {
      this.socket.close();
    } catch {
      // already closed
    }
  }
}

async function openEventSocket({ url, cookie, timeoutMs, WebSocketImpl = WebSocket }) {
  const started = Date.now();
  const socket = new WebSocketImpl(socketUrl(url), { headers: { Cookie: cookie } });
  const channel = new EventSocket(socket, timeoutMs);
  const helloReply = channel.waitFor((event) => event.type === "hello", "initial hello");
  let connectMs;
  const opened = new Promise((resolve, reject) => {
    socket.once("open", () => {
      connectMs = Date.now() - started;
      resolve();
    });
    socket.once("error", (error) => reject(new Error(`WebSocket connection failed: ${error.message}`)));
  });
  try {
    const [, hello] = await Promise.all([opened, helloReply]);
    return { channel, hello, connectMs, helloMs: Date.now() - started };
  } catch (error) {
    channel.close();
    throw error;
  }
}

async function mutate(channel, command, predicate, label) {
  const reply = channel.waitFor(
    (event) => event.type === "schedules" && Array.isArray(event.schedules) && predicate(event.schedules),
    `${label} schedules broadcast`,
  );
  const started = Date.now();
  channel.send(command);
  const event = await reply;
  return { ms: Date.now() - started, schedules: event.schedules };
}

async function runMutationSequence(channel, fixture, timings = {}) {
  const created = await mutate(
    channel,
    {
      type: "schedule.create",
      title: fixture.title,
      workspace: fixture.workspace,
      prompt: fixture.prompt,
      cron: fixture.cron,
      enabled: false,
    },
    (schedules) => schedules.some((schedule) => schedule.title === fixture.title),
    "create",
  );
  timings.createMs = created.ms;
  fixture.id = created.schedules.find((schedule) => schedule.title === fixture.title).id;

  const enabled = await mutate(
    channel,
    { type: "schedule.update", id: fixture.id, patch: { enabled: true } },
    (schedules) => schedules.some((schedule) => schedule.id === fixture.id && schedule.enabled === true),
    "enable",
  );
  timings.enableMs = enabled.ms;

  const disabled = await mutate(
    channel,
    { type: "schedule.update", id: fixture.id, patch: { enabled: false } },
    (schedules) => schedules.some((schedule) => schedule.id === fixture.id && schedule.enabled === false),
    "disable",
  );
  timings.disableMs = disabled.ms;

  const deleted = await mutate(
    channel,
    { type: "schedule.delete", id: fixture.id },
    (schedules) => !schedules.some((schedule) => schedule.id === fixture.id),
    "delete",
  );
  timings.deleteMs = deleted.ms;
}

async function verifyCleanup({ url, cookie, fixture, timeoutMs, WebSocketImpl = WebSocket }) {
  let channel;
  try {
    const opened = await openEventSocket({ url, cookie, timeoutMs, WebSocketImpl });
    channel = opened.channel;
    if (!Array.isArray(opened.hello.schedules)) throw new Error("cleanup snapshot omitted the schedules list");
    const existing = opened.hello.schedules.find(
      (schedule) => (fixture.id && schedule.id === fixture.id) || schedule.title === fixture.title,
    );
    if (!existing) return { verified: true, removed: false, id: fixture.id };

    fixture.id = existing.id;
    const snapshot = channel.waitFor(
      (event) => event.type === "hello" && Array.isArray(event.schedules) && !event.schedules.some((schedule) => schedule.id === fixture.id),
      "cleanup snapshot",
    );
    channel.send({ type: "schedule.delete", id: fixture.id });
    channel.send({ type: "snapshot.request" });
    await snapshot;
    return { verified: true, removed: true, id: fixture.id };
  } catch (error) {
    return { verified: false, removed: false, id: fixture.id, error: error.message };
  } finally {
    channel?.close();
  }
}

async function timedHealth(url, timeoutMs, fetchImpl = fetch) {
  const started = Date.now();
  try {
    const response = await fetchImpl(`${url}/api/health`, { signal: AbortSignal.timeout(timeoutMs) });
    return { ok: response.ok, status: response.status, ms: Date.now() - started };
  } catch (error) {
    return { ok: false, status: null, ms: Date.now() - started, error: error.message };
  }
}

async function runProbe(options, dependencies = {}) {
  const result = {
    ok: false,
    url: options.url,
    fixture: createFixture(dependencies.now?.(), dependencies.token?.(), dependencies.repoDir),
    timings: {},
    cleanup: { verified: true, removed: false, id: null },
    error: null,
  };
  const fetchImpl = dependencies.fetchImpl ?? fetch;
  const loginFn = dependencies.loginFn ?? login;
  const WebSocketImpl = dependencies.WebSocketImpl ?? WebSocket;
  result.health = await timedHealth(options.url, options.timeoutMs, fetchImpl);

  let cookie;
  let channel;
  let createMayHaveLanded = false;
  try {
    if (fs.existsSync(result.fixture.workspace)) {
      throw new Error(`inert fixture workspace unexpectedly exists: ${result.fixture.workspace}`);
    }
    const loginStarted = Date.now();
    cookie = await loginFn(options.url, options.password);
    result.timings.loginMs = Date.now() - loginStarted;

    const opened = await openEventSocket({ url: options.url, cookie, timeoutMs: options.timeoutMs, WebSocketImpl });
    channel = opened.channel;
    result.timings.connectMs = opened.connectMs;
    result.timings.helloMs = opened.helloMs;
    createMayHaveLanded = true;
    await runMutationSequence(channel, result.fixture, result.timings);
  } catch (error) {
    result.error = error.message;
  } finally {
    channel?.close();
  }

  if (cookie && createMayHaveLanded) {
    result.cleanup = await verifyCleanup({
      url: options.url,
      cookie,
      fixture: result.fixture,
      timeoutMs: options.timeoutMs,
      WebSocketImpl,
    });
  }
  if (!result.cleanup.verified) {
    result.error = [result.error, `cleanup could not be verified: ${result.cleanup.error}`].filter(Boolean).join("; ");
  }
  result.ok = !result.error && result.cleanup.verified;
  return result;
}

function slowLegs(result, thresholdMs) {
  return Object.entries(result.timings)
    .filter(([, value]) => typeof value === "number" && value >= thresholdMs)
    .map(([name, ms]) => ({ name, ms }));
}

function renderResult(result, slowMs) {
  console.log("=== Scheduled-task latency ===");
  console.log(`instance: ${result.url}`);
  console.log(`health: ${result.health.ms}ms${result.health.ok ? "" : ` (status ${result.health.status ?? "error"})`}`);
  for (const name of ["loginMs", "connectMs", "helloMs", "createMs", "enableMs", "disableMs", "deleteMs"]) {
    if (result.timings[name] != null) console.log(`${name.replace(/Ms$/, "")}: ${result.timings[name]}ms`);
  }
  console.log(
    `cleanup: ${result.cleanup.verified ? "verified" : "UNVERIFIED"}${result.cleanup.removed ? " (recovered leftover fixture)" : ""}`,
  );
  const slow = slowLegs(result, slowMs);
  if (slow.length) console.log(`slow legs >=${slowMs}ms: ${slow.map((leg) => `${leg.name}=${leg.ms}ms`).join(", ")}`);
  if (result.ok) console.log("verdict: PASS - every mutation was confirmed and no fixture remains");
  else {
    console.log(`verdict: FAIL - ${result.error}`);
    console.log(`fixture: ${result.fixture.title}${result.fixture.id ? ` (${result.fixture.id})` : ""}`);
  }
}

async function main(argv = process.argv.slice(2), env = process.env) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    console.error(usage(error.message));
    return 2;
  }
  if (options.help) {
    console.log(usage());
    return 0;
  }
  if (!options.confirm) {
    console.error(usage("--confirm is required because this probe temporarily changes the schedule list"));
    return 2;
  }
  const password = passwordFromEnvOrDotenv(env);
  if (!password) {
    console.error("error: AUTH_PASSWORD is not set (and server/.env has no AUTH_PASSWORD line)");
    return 2;
  }
  const result = await runProbe({ ...options, password });
  if (options.json) console.log(JSON.stringify({ ...result, slowLegs: slowLegs(result, options.slowMs) }, null, 2));
  else renderResult(result, options.slowMs);
  return result.ok ? 0 : 1;
}

module.exports = {
  DEFAULT_SLOW_MS,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_URL,
  EventSocket,
  FIXTURE_PREFIX,
  createFixture,
  openEventSocket,
  parseArgs,
  renderResult,
  runMutationSequence,
  runProbe,
  slowLegs,
  usage,
  verifyCleanup,
};

if (require.main === module) main().then((code) => { process.exitCode = code; });
