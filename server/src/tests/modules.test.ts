// Gate for the optional local-service modules (Script Hub, Surveillance, Home, Sidekick): the pure pieces
// (secret masking, Sidekick's settings edits, frame pacing) and the worker lifecycle with real worker
// processes against a stand-in Script Hub — nothing starts before it is asked for, one worker per module,
// configs migrate from the Deck, secrets never reach the browser, idle workers exit, stale builds are
// replaced, and user-started work survives a GGO restart until it is stopped.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import websocket from "@fastify/websocket";
import WebSocket from "ws";
import { MODULE_IDS } from "../modules/catalog.js";
import { modulePaths } from "../modules/protocol.js";
import { registerModuleRoutes } from "../modules/routes.js";
import { workerEnvironment } from "../modules/spawnDetached.js";
import { ModuleSupervisor } from "../modules/supervisor.js";
import { bridgeFor, maskDevice, normalizeDevice, restoreDeviceSecrets } from "../modules/worker/home/config.js";
import { matchesProcessName, parseLogLines, buildSidekickState, type SidekickIo } from "../modules/worker/sidekick/state.js";
import { mutateRules, revisionForText } from "../modules/worker/sidekick/rules.js";
import { fromDeckSection, maskCamera, maskUrl, normalizeCamera, restoreSecrets, SECRET_MASK } from "../modules/worker/surveillance/config.js";
import { FramePush, type Frame, type FrameSource } from "../modules/worker/surveillance/frames.js";
import { ffmpegTag } from "../modules/worker/surveillance/processes.js";
import { LineThrottle } from "../modules/worker/surveillance/logThrottle.js";

let checks = 0;
async function test(name: string, fn: () => Promise<void> | void) {
  await fn();
  console.log(`✓ ${name}`);
  checks++;
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const TOKEN = "0123456789abcdef0123456789abcdef";
const RULE_ID = "6f1c2b8e-1d2a-4c3b-9e4f-100000000001";
const COMPANION_ID = "6f1c2b8e-1d2a-4c3b-9e4f-100000000002";

async function waitFor<T>(label: string, read: () => Promise<T>, done: (value: T) => boolean, timeoutMs = 15_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last = await read();
  while (!done(last)) {
    if (Date.now() > deadline) throw new Error(`${label}: still ${JSON.stringify(last)} after ${timeoutMs}ms`);
    await delay(200);
    last = await read();
  }
  return last;
}

function pidAlive(pid: number | null): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// ---- pure pieces --------------------------------------------------------------------------------

await test("surveillance: camera passwords and URL credentials are masked and restored", () => {
  const stored = normalizeCamera({ id: "cam-1", name: "Porch", password: "pw-secret", streamUrl: "rtsp://admin:pw-secret@192.0.2.20:554/stream1", snapshotUrl: "http://192.0.2.20/snap.cgi?user=admin&password=pw-secret" });
  const masked = maskCamera(stored);
  assert.equal(masked.password, SECRET_MASK);
  assert.equal(masked.passwordSet, true);
  assert.ok(!JSON.stringify(masked).includes("pw-secret"), "no secret survives masking");
  const restored = restoreSecrets(normalizeCamera(masked), stored);
  assert.equal(restored.password, "pw-secret");
  assert.equal(restored.streamUrl, stored.streamUrl);
  assert.equal(restored.snapshotUrl, stored.snapshotUrl);
  assert.throws(() => restoreSecrets(normalizeCamera({ ...masked, id: "cam-new" }), undefined), /enter the camera password again/);
  assert.equal(maskUrl("not a url"), "not a url");
});

await test("surveillance: a password written into a camera's notes is masked and survives a save", () => {
  const notes = "Login admin / pw-secret.\nFallback: rtsp://viewer:other-pass@192.0.2.21:554/s1 (ask sam@example.com)";
  const stored = normalizeCamera({ id: "cam-1", name: "Porch", password: "pw-secret", notes });
  const masked = maskCamera(stored);
  assert.ok(!masked.notes.includes("pw-secret") && !masked.notes.includes("other-pass"), masked.notes);
  assert.ok(masked.notes.includes("sam@example.com"), "plain text around the secrets stays readable");
  assert.equal(restoreSecrets(normalizeCamera(masked), stored).notes, notes);
  const edited = normalizeCamera({ ...masked, notes: `${masked.notes}\nMoved to the porch.` });
  assert.equal(restoreSecrets(edited, stored).notes, `${notes}\nMoved to the porch.`);
  assert.throws(() => restoreSecrets(normalizeCamera({ ...masked, notes: `${masked.notes} ${SECRET_MASK}` }), stored), /notes/);
});

await test("surveillance: a Deck config whose recording was parked keeps the folder, not the recording", () => {
  const config = fromDeckSection({ recordingRoot: "", recordingRootParked: "recordings/parked", cameras: [{ id: "a", name: "Yard", gridWidth: 2 }] })!;
  assert.equal(config.recordingRoot, "recordings/parked");
  assert.equal(config.cameras[0]!.gridSpan, 12, "the Deck's old wide tile maps to a full-width span");
  assert.equal(fromDeckSection({ cameras: [] }), null);
});

await test("home: the miIO token is masked, restored, and picks the bridge", () => {
  const stored = normalizeDevice({ id: "vac-1", name: "Hall", token: TOKEN, host: "192.0.2.10" });
  const masked = maskDevice(stored);
  assert.equal(masked.token, SECRET_MASK);
  assert.equal(restoreDeviceSecrets(normalizeDevice(masked), stored).token, TOKEN);
  assert.throws(() => restoreDeviceSecrets(normalizeDevice({ ...masked, id: "vac-2" }), undefined), /miIO token/);
  assert.equal(bridgeFor(stored), "xiaomi-miio");
  assert.equal(bridgeFor({ ...stored, token: "" }), "home-assistant");
  assert.equal(bridgeFor({ ...stored, platform: "home-assistant" }), "home-assistant");
  assert.equal(normalizeDevice({ refreshMs: 500 }).refreshMs, 2_000, "no faster than every 2 s");
});

await test("sidekick: process names match like the tray app and the log parses both clock styles", () => {
  assert.ok(matchesProcessName("Example.exe", "example"));
  assert.ok(matchesProcessName("Game*", "GameClient.exe"));
  assert.ok(!matchesProcessName("Game?", "GameClient.exe"));
  const entries = parseLogLines("2026-01-02 20:53:01 [INFO] started\n2026-01-02 20.54.02 [WARN] slow\n  continued line\n");
  assert.deepEqual(entries.map((e) => e.level), ["info", "warn"]);
  assert.equal(entries[1]!.time, "2026-01-02 20.54.02");
  assert.match(entries[1]!.message, /continued line/);
});

await test("sidekick: rule edits need the current revision and keep fields they do not know", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ggo-sidekick-"));
  try {
    const settings = join(dir, "settings.json");
    const created = await mutateRules(settings, { type: "create" }, { revision: null, rule: { name: "Game", triggerProcess: "Game.exe", companions: [{ hubId: "overlay" }] } });
    const doc = JSON.parse(await readFile(settings, "utf8"));
    assert.equal(doc.Rules.length, 1);
    assert.equal(doc.Rules[0].Companions[0].Name, "overlay", "a nameless companion takes its Script Hub id");
    doc.Rules[0].FutureField = "kept";
    doc.App = { Theme: "dark" };
    await writeFile(settings, JSON.stringify(doc));
    await assert.rejects(mutateRules(settings, { type: "update", id: created.ruleId }, { revision: created.revision, rule: { name: "Game 2", triggerProcess: "Game.exe", companions: [] } }), (e: Error & { status?: number; extra?: { code?: string } }) => e.status === 409 && e.extra?.code === "stale_config");
    await assert.rejects(mutateRules(settings, { type: "update", id: created.ruleId }, { rule: {} }), (e: Error & { status?: number }) => e.status === 428);
    const revision = revisionForText(await readFile(settings, "utf8"));
    await mutateRules(settings, { type: "update", id: created.ruleId }, { revision, rule: { name: "Game 2", triggerProcess: "Game.exe", companions: [] } });
    const updated = JSON.parse(await readFile(settings, "utf8"));
    assert.equal(updated.Rules[0].Name, "Game 2");
    assert.equal(updated.Rules[0].FutureField, "kept");
    assert.deepEqual(updated.App, { Theme: "dark" });
    await assert.rejects(mutateRules(settings, { type: "create" }, { revision: revisionForText(await readFile(settings, "utf8")), rule: { name: "x", triggerProcess: "Games/x.exe", companions: [] } }), /image name/);
    await mutateRules(settings, { type: "delete", id: created.ruleId }, { revision: revisionForText(await readFile(settings, "utf8")) });
    assert.equal(JSON.parse(await readFile(settings, "utf8")).Rules.length, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

await test("sidekick: state reports trigger and companion liveness through the injected probes", async () => {
  const files: Record<string, string> = {
    "/s.json": JSON.stringify({ Rules: [{ Id: RULE_ID, Name: "Game", TriggerProcess: "Game.exe", Companions: [{ Id: COMPANION_ID, Name: "Overlay", ExePath: "x.exe", AlreadyRunningPort: 5005 }] }] }),
  };
  const io: SidekickIo = {
    readText: async (p) => files[p] ?? null,
    readTail: async () => "2026-01-02 20:53:01 [INFO] watching",
    exists: async (p) => p === "/Sidekick.exe",
    mtime: async () => new Date(0),
    runningImageNames: async () => ["game.exe", "Sidekick.exe"],
    portIsListening: async (port) => port === 5005,
  };
  const state = await buildSidekickState({ exe: "/Sidekick.exe", settings: "/s.json", log: "/l.log", startupShortcut: "/none.lnk", logLines: 10 }, io);
  assert.equal(state.installed, true);
  assert.equal(state.running, true);
  assert.equal(state.startOnLogin, false);
  assert.equal(state.rules[0]!.triggerRunning, true);
  assert.equal(state.rules[0]!.companions[0]!.running, true);
  assert.equal(state.settingsRevision, revisionForText(files["/s.json"]!));
});

await test("surveillance: the frame push asks a snapshot camera only at its own refresh interval", async () => {
  const refreshes: Record<string, number> = { slow: 0, fast: 0 };
  let at = 1;
  const source = {
    refreshIntervalMs: (camera: { id: string }) => (camera.id === "slow" ? 60_000 : 0),
    peek: (camera: { id: string }, refresh: boolean): Frame => {
      if (refresh) refreshes[camera.id]! += 1;
      return { buf: Buffer.alloc(300), at: at++, contentType: "image/jpeg" };
    },
  } as unknown as FrameSource;
  const cameras = [normalizeCamera({ id: "slow", refreshMs: 60_000 }), normalizeCamera({ id: "fast" })];
  const push = new FramePush(() => cameras, source);
  const sent: Buffer[] = [];
  const socket = { OPEN: 1, readyState: 1, bufferedAmount: 0, on() {}, ping() {}, terminate() {}, send: (b: Buffer) => sent.push(b) };
  push.add(socket as never);
  await delay(1_700);
  push.closeAll();
  assert.equal(refreshes.slow, 1, "a 60 s camera is asked once, not every tick");
  assert.ok(refreshes.fast! >= 3, `a free source is read every tick (got ${refreshes.fast})`);
  const header = JSON.parse(sent[0]!.subarray(2, 2 + sent[0]!.readUInt16BE(0)).toString("utf8"));
  assert.ok(header.id === "slow" || header.id === "fast");
  assert.equal(push.viewerCount, 0);
});

await test("surveillance: a worker only clears ffmpeg leftovers tagged with its own data folder", () => {
  const live = ffmpegTag(join("srv", "data"));
  assert.equal(ffmpegTag(join("srv", "data")), live);
  assert.equal(ffmpegTag(join("SRV", "Data")), live, "Windows paths compare case-insensitively");
  assert.notEqual(ffmpegTag(join("lab", "data")), live, "a lab instance must never match the live instance's recorder");
  assert.match(live, /^ggosurveillance[0-9a-f]{10}$/, "the tag is also a multipart boundary, so it stays alphanumeric");
});

await test("surveillance: a camera spewing ffmpeg warnings logs a bounded number of lines", () => {
  const throttle = new LineThrottle(3, 60_000);
  const passed = Array.from({ length: 50 }, (_, i) => throttle.admit("garden", 1_000 + i).pass).filter(Boolean).length;
  assert.equal(passed, 3, "only the first lines of a window are logged");
  assert.equal(throttle.admit("porch", 1_100).pass, true, "each camera has its own budget");
  const next = throttle.admit("garden", 61_000);
  assert.equal(next.pass, true, "a new window logs again");
  assert.equal(next.mutedNote, "47 more ffmpeg line(s) muted in the last 60s");
});

await test("workers never inherit credential-looking variables", () => {
  process.env.EXAMPLE_API_KEY = "x";
  process.env.EXAMPLE_PLAIN = "y";
  const env = workerEnvironment({ GGO_MODULE_BUILD: "b" });
  delete process.env.EXAMPLE_API_KEY;
  delete process.env.EXAMPLE_PLAIN;
  assert.equal(env.EXAMPLE_API_KEY, undefined);
  assert.equal(env.EXAMPLE_PLAIN, "y");
  assert.equal(env.GGO_MODULE_BUILD, "b");
});

// ---- real workers -------------------------------------------------------------------------------

const root = await mkdtemp(join(tmpdir(), "ggo-modules-gate-"));
const appData = join(root, "appdata");
const localAppData = join(root, "localappdata");
await mkdir(join(appData, "Sidekick"), { recursive: true });
await mkdir(join(localAppData, "Sidekick"), { recursive: true });
await writeFile(join(appData, "Sidekick", "settings.json"), JSON.stringify({ Version: 1, Rules: [{ Id: RULE_ID, Name: "Game", TriggerProcess: "Example.exe", Companions: [{ Id: COMPANION_ID, Name: "Overlay", HubId: "overlay" }] }] }, null, 2));
await writeFile(join(localAppData, "Sidekick", "sidekick.log"), "2026-01-02 20:53:01 [INFO] watching 1 task\n");
process.env.APPDATA = appData;
process.env.LOCALAPPDATA = localAppData;

const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(400, 1), Buffer.from([0xff, 0xd9])]);
const hubCalls: string[] = [];
let hubPort = 0;
const hub: Server = createServer((req, res) => {
  hubCalls.push(`${req.method} ${req.url}`);
  const json = (body: unknown) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  if (req.url === "/snap.jpg") {
    res.writeHead(200, { "content-type": "image/jpeg" });
    return res.end(JPEG);
  }
  if (req.url === "/api/settings/hiddenScripts") return json({ value: ["beta"] });
  if (req.url === "/api/settings/home-control") return json({ value: { devices: [{ id: "vac-1", name: "Hall vacuum", token: TOKEN, host: "192.0.2.10", refreshMs: 10_000 }] } });
  if (req.url === "/api/settings/surveillance") {
    return json({ value: { recordingRoot: "", recordingRootParked: join(root, "recordings"), cameras: [{ id: "cam-1", name: "Porch", password: "pw-secret", snapshotUrl: `http://admin:pw-secret@127.0.0.1:${hubPort}/snap.jpg`, previewStrategy: "snapshot", refreshMs: 250 }] } });
  }
  if (req.url === "/api/status") {
    return json({
      generatedAt: new Date().toISOString(),
      scripts: [
        { id: "alpha", owner: "alex", displayName: "Alpha", category: "tools", description: "A long description", keepAlive: true, start: { executable: "node", args: ["alpha.js"] }, status: { state: "running", processes: [{ processId: 4242, name: "node.exe", commandLine: "node alpha.js" }] } },
        { id: "beta", displayName: "Beta", start: { executable: "beta.exe" }, status: { state: "stopped", processes: [] } },
        { id: "script-hub", start: { workingDir: join(root, "nowhere") } },
      ],
    });
  }
  if (req.url === "/api/scripts") return json({ scripts: [{ id: "sidekick", displayName: "Sidekick", start: { executable: join(root, "Sidekick.exe") } }, { id: "overlay", displayName: "Overlay" }] });
  if (req.method === "POST" && req.url === "/api/start") return json({ ok: true });
  res.writeHead(404, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: "not here" }));
});
await new Promise<void>((resolve) => hub.listen(0, "127.0.0.1", resolve));
hubPort = (hub.address() as AddressInfo).port;
const hubUrl = `http://127.0.0.1:${hubPort}`;

const dataDir = join(root, "data");
const supervisor = new ModuleSupervisor({ dataDir, build: "build-one", hubUrl, idleExitMs: 120_000 });
const app: FastifyInstance = Fastify();
await app.register(websocket);
registerModuleRoutes(app, supervisor, (cookie) => cookie === "session=ok");
await app.listen({ port: 0, host: "127.0.0.1" });
const base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
const authed = { cookie: "session=ok", "sec-fetch-site": "same-origin" };

async function api(path: string, init: { method?: string; body?: unknown; headers?: Record<string, string> } = {}) {
  const res = await fetch(`${base}${path}`, {
    method: init.method ?? "GET",
    headers: { ...authed, ...(init.body === undefined ? {} : { "content-type": "application/json" }), ...init.headers },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null, headers: res.headers };
}

const extraSupervisors: ModuleSupervisor[] = [];
try {
  await test("nothing runs, polls or touches disk until a module is asked for", async () => {
    const { status, body } = await api("/api/modules/services");
    assert.equal(status, 200);
    assert.deepEqual(body.map((s: { state: string }) => s.state), MODULE_IDS.map(() => "stopped"));
    assert.equal(existsSync(dataDir), false, "no module folder before first use");
    assert.deepEqual(hubCalls, [], "Script Hub was not called");
  });

  await test("module routes need the owner's session and refuse cross-site requests", async () => {
    assert.equal((await api("/api/modules/services", { headers: { cookie: "" } })).status, 401);
    assert.equal((await api("/api/modules/home/api/config", { headers: { "sec-fetch-site": "cross-site" } })).status, 403);
    assert.equal((await api("/api/modules/nope/service")).status, 404);
    assert.equal(existsSync(dataDir), false, "a refused request starts nothing");
  });

  await test("Script Hub: the worker starts on demand, slims the status and carries over hidden scripts", async () => {
    const { status, body } = await api("/api/modules/scripthub/api/status");
    assert.equal(status, 200, JSON.stringify(body));
    assert.deepEqual(body.hiddenScripts, ["beta"]);
    const alpha = body.scripts.find((s: { id: string }) => s.id === "alpha");
    assert.equal(alpha.owner, "alex");
    assert.equal(alpha.command, "node alpha.js");
    assert.equal(alpha.status.processes[0].processId, 4242);
    assert.equal(alpha.description, undefined, "descriptions are served once from /details, not every poll");
    const details = await api("/api/modules/scripthub/api/details");
    assert.equal(details.body.scripts.alpha.description, "A long description");
    const stored = JSON.parse(readFileSync(modulePaths(dataDir, "scripthub").config, "utf8"));
    assert.equal(stored.origin, "dashboard-deck");
    const service = await api("/api/modules/scripthub/service");
    assert.equal(service.body.state, "running");
    assert.ok(pidAlive(service.body.pid));
  });

  await test("Home: concurrent first requests share one worker, and the token never leaves the server", async () => {
    const [a, b, c] = await Promise.all([supervisor.ensure("home"), supervisor.ensure("home"), supervisor.ensure("home")]);
    assert.equal(a.health.pid, b.health.pid);
    assert.equal(b.health.pid, c.health.pid);
    const config = await api("/api/modules/home/api/config");
    assert.equal(config.status, 200);
    assert.equal(config.body.origin, "dashboard-deck");
    assert.equal(config.body.devices[0].token, SECRET_MASK);
    assert.ok(!JSON.stringify(config.body).includes(TOKEN));
    const renamed = { ...config.body, devices: [{ ...config.body.devices[0], name: "Hall robot" }] };
    const saved = await api("/api/modules/home/api/config", { method: "PUT", body: renamed });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    const onDisk = JSON.parse(readFileSync(modulePaths(dataDir, "home").config, "utf8"));
    assert.equal(onDisk.value.devices[0].name, "Hall robot");
    assert.equal(onDisk.value.devices[0].token, TOKEN, "the masked token was restored, not saved as dots");
  });

  await test("Surveillance: cameras import masked, recording stays off, frames stream over a ticketed socket", async () => {
    const config = await api("/api/modules/surveillance/api/config");
    assert.equal(config.status, 200, JSON.stringify(config.body));
    assert.equal(config.body.recordingRoot, join(root, "recordings"));
    assert.equal(config.body.cameras[0].password, SECRET_MASK);
    assert.ok(!JSON.stringify(config.body).includes("pw-secret"));
    const recording = await api("/api/modules/surveillance/api/recording");
    assert.equal(recording.body.active, false);
    assert.equal((await api("/api/modules/surveillance/service")).body.busy, null);

    const frame = await fetch(`${base}/api/modules/surveillance/api/cameras/cam-1/frame`, { headers: authed });
    assert.equal(frame.status, 200);
    assert.equal(frame.headers.get("content-type"), "image/jpeg");
    assert.equal(Buffer.from(await frame.arrayBuffer()).length, JPEG.length);

    const refused = new WebSocket(`${base.replace("http", "ws")}/api/modules/surveillance/stream?ticket=forged`, { headers: authed });
    const refusedCode = await new Promise<number>((resolve) => refused.on("close", (code) => resolve(code)));
    assert.equal(refusedCode, 4403);

    const { body: ticket } = await api("/api/modules/surveillance/ticket", { method: "POST", body: {} });
    const socket = new WebSocket(`${base.replace("http", "ws")}/api/modules/surveillance/stream?ticket=${ticket.ticket}`, { headers: authed });
    const message = await new Promise<Buffer>((resolve, reject) => {
      socket.once("message", (data) => resolve(data as Buffer));
      socket.once("error", reject);
      setTimeout(() => reject(new Error("no frame within 10s")), 10_000);
    });
    const header = JSON.parse(message.subarray(2, 2 + message.readUInt16BE(0)).toString("utf8"));
    assert.equal(header.id, "cam-1");
    const health = await waitFor("open stream counted", () => supervisor.ensure("surveillance").then((c) => supervisor.request(c, "/_worker/health")).then((r) => r.json() as Promise<{ openStreams: number }>), (h) => h.openStreams === 1);
    assert.equal(health.openStreams, 1);
    socket.close();
    supervisor.forget("surveillance");
    await waitFor("stream closed in the worker", () => supervisor.ensure("surveillance").then((c) => supervisor.request(c, "/_worker/health")).then((r) => r.json() as Promise<{ openStreams: number }>), (h) => h.openStreams === 0);
    const reused = await api("/api/modules/surveillance/ticket", { method: "POST", body: {} });
    assert.notEqual(reused.body.ticket, ticket.ticket, "tickets are single-use");
  });

  await test("Sidekick: reads the tray app's own files and edits them only against the current revision", async () => {
    const state = await api("/api/modules/sidekick/api/state");
    assert.equal(state.status, 200, JSON.stringify(state.body));
    assert.equal(state.body.rules[0].name, "Game");
    assert.equal(state.body.log.entries[0].message, "watching 1 task");
    assert.deepEqual(state.body.hubScripts, [{ id: "overlay", name: "Overlay" }]);
    const stale = await api(`/api/modules/sidekick/api/rules/${RULE_ID}`, { method: "PUT", body: { revision: "old", rule: { name: "Game", triggerProcess: "Example.exe", companions: [] } } });
    assert.equal(stale.status, 409);
    assert.equal(stale.body.code, "stale_config");
    const saved = await api(`/api/modules/sidekick/api/rules/${RULE_ID}`, { method: "PUT", body: { revision: state.body.settingsRevision, rule: { name: "Game night", triggerProcess: "Example.exe", companions: [{ id: COMPANION_ID, hubId: "overlay" }] } } });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    assert.equal(JSON.parse(readFileSync(join(appData, "Sidekick", "settings.json"), "utf8")).Rules[0].Name, "Game night");
    const power = await api("/api/modules/sidekick/api/power/start", { method: "POST", body: {} });
    assert.equal(power.status, 200);
    assert.ok(hubCalls.includes("POST /api/start"));
  });

  await test("a module whose upstream is down answers 503 and keeps the worker (and GGO) responsive", async () => {
    await new Promise<void>((resolve) => hub.close(() => resolve()));
    hub.closeAllConnections();
    const down = await api("/api/modules/scripthub/api/status");
    assert.equal(down.status, 503);
    assert.equal(down.body.hubDown, true);
    assert.equal((await api("/api/modules/services")).status, 200);
    assert.equal((await api("/api/modules/scripthub/service")).body.state, "running");
  });

  await test("a routine health re-check of a running worker reads as running, not starting", async () => {
    const pid = (await supervisor.ensure("home")).health.pid;
    supervisor.forget("home");
    const recheck = supervisor.ensure("home");
    const during = await supervisor.status("home");
    await recheck;
    assert.equal(during.state, "running");
    assert.equal(during.pid, pid);
  });

  await test("Stop ends the worker process and clears its record", async () => {
    const before = (await api("/api/modules/home/service")).body.pid as number;
    const stopped = await api("/api/modules/home/service/stop", { method: "POST", body: {} });
    assert.equal(stopped.body.state, "stopped");
    await waitFor("home worker exit", async () => pidAlive(before), (alive) => !alive);
    assert.equal(existsSync(modulePaths(dataDir, "home").record), false);
  });

  await test("an idle worker exits by itself", async () => {
    const idleDir = join(root, "idle");
    const idle = new ModuleSupervisor({ dataDir: idleDir, build: "build-one", hubUrl, idleExitMs: 1_200 });
    extraSupervisors.push(idle);
    const connection = await idle.ensure("home");
    await waitFor("idle exit", () => idle.status("home"), (s) => s.state === "stopped", 20_000);
    assert.equal(pidAlive(connection.health.pid), false);
  });

  await test("a worker from an older GGO build is reported stale and replaced on next use", async () => {
    const before = (await api("/api/modules/scripthub/service")).body.pid as number;
    const newer = new ModuleSupervisor({ dataDir, build: "build-two", hubUrl, idleExitMs: 120_000 });
    extraSupervisors.push(newer);
    assert.equal((await newer.status("scripthub")).stale, true);
    const replaced = await newer.ensure("scripthub");
    assert.notEqual(replaced.health.pid, before);
    assert.equal(replaced.health.build, "build-two");
    await waitFor("old worker exit", async () => pidAlive(before), (alive) => !alive);
  });

  await test("user-started work brings its worker back at boot, and a forced Stop ends it for good", async () => {
    const armedDir = join(root, "armed");
    await mkdir(modulePaths(armedDir, "home").dir, { recursive: true });
    await writeFile(join(modulePaths(armedDir, "home").dir, "armed.json"), JSON.stringify({ reason: "recording 1 camera", at: Date.now() }));
    const booted = new ModuleSupervisor({ dataDir: armedDir, build: "build-one", hubUrl, idleExitMs: 120_000 });
    extraSupervisors.push(booted);
    await booted.resumeArmed();
    const status = await booted.status("home");
    assert.equal(status.state, "running");
    assert.equal(status.armed, "recording 1 camera");
    assert.equal((await booted.status("scripthub")).state, "stopped", "only the armed module came back");
    await booted.stop("home", { force: true });
    assert.equal((await booted.status("home")).armed, null);
    assert.equal(existsSync(join(modulePaths(armedDir, "home").dir, "armed.json")), false);
  });
} finally {
  for (const s of [supervisor, ...extraSupervisors]) {
    for (const id of MODULE_IDS) await s.stop(id, { force: true }).catch(() => undefined);
    s.dispose();
  }
  await app.close();
  if (hub.listening) hub.close();
  await rm(root, { recursive: true, force: true }).catch(() => undefined);
}

console.log(`\nmodules: ${checks} checks passed`);
