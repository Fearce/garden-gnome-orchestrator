// Gate for the optional local-service modules (Script Hub, Surveillance, Home, Sidekick): the pure pieces
// (secret masking, Sidekick's settings edits, frame pacing) and the worker lifecycle with real worker
// processes against a stand-in Script Hub — nothing starts before it is asked for, one worker per module,
// configs migrate from the Deck, secrets never reach the browser, idle workers exit, stale builds are
// replaced, and user-started work survives a GGO restart until it is stopped. Surveillance's recording plan
// (off by default, 24/7, schedule), retention and the recordings browser run against real ffmpeg processes.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { appendFile, mkdir, mkdtemp, readdir, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { createServer, get as httpGet, type Server } from "node:http";
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
import { CONTROL_DEADLINE_MS, controlHomeAssistantContainer, findHomeAssistantContainer } from "../modules/worker/home/container.js";
import { bridgeFor, maskDevice, normalizeDevice, restoreDeviceSecrets } from "../modules/worker/home/config.js";
import { matchesProcessName, parseLogLines, buildSidekickState, type SidekickIo } from "../modules/worker/sidekick/state.js";
import { mutateRules, revisionForText } from "../modules/worker/sidekick/rules.js";
import { emptyConfig, fromDeckSection, maskCamera, maskUrl, normalizeCamera, normalizeConfig, restoreSecrets, SECRET_MASK } from "../modules/worker/surveillance/config.js";
import { RecordingLibrary } from "../modules/worker/surveillance/library.js";
import { scheduleState } from "../modules/worker/surveillance/recordingPlan.js";
import { FramePush, type Frame, type FrameSource } from "../modules/worker/surveillance/frames.js";
import { ffmpegTag } from "../modules/worker/surveillance/processes.js";
import { LineThrottle } from "../modules/worker/surveillance/logThrottle.js";
import { JsonFile } from "../modules/worker/configStore.js";
import { loadOrImport, type StoredConfig } from "../modules/worker/legacyImport.js";
import { hubJson } from "../modules/worker/hubClient.js";
import { HttpError } from "../modules/worker/router.js";

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

/** A segment file name as the recorder writes it, for a moment in local time. */
function segmentName(at: number): string {
  const d = new Date(at);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}.ts`;
}

async function writeSegment(dir: string, at: number, bytes: number, modifiedAt = at + 15 * 60_000): Promise<string> {
  const name = segmentName(at);
  await writeFile(join(dir, name), Buffer.alloc(bytes, 7));
  await utimes(join(dir, name), new Date(modifiedAt), new Date(modifiedAt));
  return name;
}

function ffmpegOnPath(): string | null {
  try {
    return execFileSync("where.exe", ["ffmpeg"], { encoding: "utf8", windowsHide: true }).split(/\r?\n/).map((l) => l.trim()).find((l) => l.toLowerCase().endsWith(".exe")) ?? null;
  } catch {
    return null;
  }
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

await test("surveillance: recording is off by default and nothing is ever deleted until the owner sets a retention", () => {
  const legacy = normalizeConfig({ recordingRoot: "recordings", cameras: [{ id: "a", name: "Yard" }] });
  assert.equal(legacy.recording.mode, "off");
  assert.equal(legacy.recording.retentionDays, 0, "a config from before retention existed deletes nothing");
  assert.equal(legacy.recording.maxGbPerCamera, 0);
  assert.equal(legacy.cameras[0]!.recordEnabled, true);
  const fresh = normalizeConfig(emptyConfig());
  assert.equal(fresh.recording.mode, "off");
  assert.equal(fresh.recording.retentionDays, 0, "a folder typed into a new setup may already hold years of footage");
  assert.equal(fresh.recording.maxGbPerCamera, 0);
  const edited = normalizeConfig({ ...fresh, recording: { mode: "sometimes", segmentMinutes: 7, retentionDays: -4, schedule: { days: [1, 9, 1], start: "25:00", end: "6:30" } } });
  assert.equal(edited.recording.mode, "off", "an unknown mode is off, never on");
  assert.equal(edited.recording.segmentMinutes, 15, "only the offered segment lengths are accepted");
  assert.equal(edited.recording.retentionDays, 0);
  assert.deepEqual(edited.recording.schedule, { days: [1], start: "22:00", end: "06:30" });
});

await test("surveillance: a schedule opens and closes at its window's edges, overnight and by weekday", () => {
  const nights = { days: [1, 2, 3, 4, 5], start: "22:00", end: "07:00" };
  const mondayLate = new Date(2026, 9, 5, 23, 0);
  const tuesdayEarly = new Date(2026, 9, 6, 6, 59);
  const tuesdayNoon = new Date(2026, 9, 6, 12, 0);
  const saturdayEarly = new Date(2026, 9, 10, 3, 0);
  const sundayLate = new Date(2026, 9, 11, 23, 0);
  assert.deepEqual(scheduleState(nights, mondayLate), { active: true, nextChangeAt: new Date(2026, 9, 6, 7, 0).getTime() });
  assert.equal(scheduleState(nights, tuesdayEarly).active, true, "Monday's window runs past midnight");
  assert.deepEqual(scheduleState(nights, tuesdayNoon), { active: false, nextChangeAt: new Date(2026, 9, 6, 22, 0).getTime() });
  assert.equal(scheduleState(nights, saturdayEarly).active, true, "Friday night's window ends Saturday morning");
  assert.deepEqual(scheduleState(nights, sundayLate), { active: false, nextChangeAt: new Date(2026, 9, 12, 22, 0).getTime() });
  assert.deepEqual(scheduleState({ days: [0, 1, 2, 3, 4, 5, 6], start: "00:00", end: "00:00" }, tuesdayNoon), { active: true, nextChangeAt: null });
  assert.deepEqual(scheduleState({ days: [], start: "08:00", end: "09:00" }, tuesdayNoon), { active: false, nextChangeAt: null });
});

await test("surveillance: the library lists recorded days and retention deletes only old segments, never the newest or other files", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ggo-recordings-"));
  try {
    const now = Date.now();
    const ancient = await writeSegment(dir, now - 40 * 86_400_000, 1000);
    const older = await writeSegment(dir, now - 3 * 86_400_000, 1000);
    const recent = await writeSegment(dir, now - 2 * 86_400_000, 1000);
    const growing = await writeSegment(dir, now - 60_000, 1000, now);
    await writeFile(join(dir, "cleanup_recordings.py"), "# the owner's own script\n");
    await writeFile(join(dir, "notes.txt"), "keep me\n");
    const library = new RecordingLibrary(() => [{ cameraId: "cam-1", name: "Yard", dir }]);

    const [summary] = await library.summary();
    assert.equal(summary!.segments, 4);
    assert.equal(summary!.bytes, 4000);
    assert.deepEqual(summary!.days.map((d) => d.day), [...new Set([growing, recent, older, ancient].map((n) => n.slice(0, 10)))]);
    const today = await library.day("cam-1", growing.slice(0, 10));
    assert.equal(today.find((segment) => segment.name === growing)?.live, true, "the segment being written is marked live");
    await assert.rejects(library.segmentFile("cam-1", "notes.txt"), /not a recording segment/);
    await assert.rejects(library.segmentFile("cam-1", `..\\${ancient}`), /not a recording segment/);
    await assert.rejects(library.segmentFile("cam-2", ancient), /no recording folder/);
    assert.equal((await library.segmentFile("cam-1", ancient)).bytes, 1000);

    const off = await library.sweep({ retentionDays: 0, maxGbPerCamera: 0 }, now);
    assert.equal(off.deletedFiles, 0, "retention off deletes nothing");
    const byAge = await library.sweep({ retentionDays: 30, maxGbPerCamera: 0 }, now);
    assert.equal(byAge.deletedFiles, 1);
    assert.deepEqual((await readdir(dir)).sort(), ["cleanup_recordings.py", growing, "notes.txt", older, recent].sort());
    const bySize = await library.sweep({ retentionDays: 0, maxGbPerCamera: 1500 / 1024 ** 3 }, now);
    assert.equal(bySize.deletedFiles, 2, "the oldest go until the folder fits, but the segment being written stays");
    assert.deepEqual((await readdir(dir)).sort(), ["cleanup_recordings.py", growing, "notes.txt"].sort());
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

await test("surveillance: a segment read while still growing is re-read once closed, and an undeletable file never holds retention back", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ggo-recordings-"));
  try {
    const now = Date.now();
    const library = new RecordingLibrary(() => [{ cameraId: "cam-1", name: "Yard", dir }]);
    const early = await writeSegment(dir, now - 5 * 86_400_000, 1000, now - 30_000);
    assert.equal((await library.summary())[0]!.bytes, 1000);
    await writeFile(join(dir, early), Buffer.alloc(5000, 7));
    await utimes(join(dir, early), new Date(now - 4 * 86_400_000), new Date(now - 4 * 86_400_000));
    await writeSegment(dir, now - 3_600_000, 10);
    await writeSegment(dir, now - 10 * 60_000, 10, now - 5 * 60_000);
    await writeSegment(dir, now - 60_000, 10, now);
    const sized = await library.sweep({ retentionDays: 2, maxGbPerCamera: 0 }, Date.now());
    assert.equal(sized.deletedFiles, 1);
    assert.equal(sized.deletedBytes, 5000, "the size it closed at, not the size first seen while it grew");

    // Once indexed, the segment is swapped for a non-empty folder of the same name: an unlink that fails everywhere.
    const stuck = await writeSegment(dir, now - 10 * 86_400_000, 100);
    const next = await writeSegment(dir, now - 9 * 86_400_000, 100);
    const sweeper = new RecordingLibrary(() => [{ cameraId: "cam-1", name: "Yard", dir }]);
    await sweeper.summary();
    await rm(join(dir, stuck));
    await mkdir(join(dir, stuck));
    await writeFile(join(dir, stuck, "held.bin"), "x");
    const first = await sweeper.sweep({ retentionDays: 2, maxGbPerCamera: 0 }, Date.now());
    assert.equal(first.failed, 1);
    assert.equal(first.deletedFiles, 1, "the file behind the stuck one is still deleted");
    assert.equal(existsSync(join(dir, next)), false);
    assert.equal(first.pending, false, "a file that cannot be deleted does not trigger the 30 s backlog sweep");
    const again = await sweeper.sweep({ retentionDays: 2, maxGbPerCamera: 0 }, Date.now());
    assert.equal(again.failed, 0, "a failed file is left alone for a while instead of retried every sweep");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
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

await test("home: a token written in device notes stays masked and survives an unrelated edit", () => {
  const stored = normalizeDevice({ id: "vac-1", token: TOKEN, statusNote: `Local token: ${TOKEN}. Source: ${TOKEN}.` });
  const masked = maskDevice(stored);
  assert.ok(!JSON.stringify(masked).includes(TOKEN));
  const edited = normalizeDevice({ ...masked, name: "Hall vacuum", statusNote: `${masked.statusNote}\nMoved downstairs.` });
  const restored = restoreDeviceSecrets(edited, stored);
  assert.equal(restored.token, TOKEN);
  assert.equal(restored.statusNote, `${stored.statusNote}\nMoved downstairs.`);
  assert.throws(() => restoreDeviceSecrets({ ...edited, statusNote: SECRET_MASK }, stored), /notes/);
});

await test("home: Home Assistant's container is found by its mounted config folder and started only on request", async () => {
  const configDir = join(tmpdir(), "ha-sample", "config");
  const calls: string[][] = [];
  let state = "exited";
  const docker = async (args: string[]) => {
    calls.push(args);
    if (args[0] === "ps") return "aaa111\nbbb222\n";
    if (args[0] === "inspect") {
      return JSON.stringify([
        { Id: "aaa111", Name: "/sample-db", State: { Status: "running" }, Mounts: [{ Source: join(tmpdir(), "db"), Destination: "/var/lib/db" }] },
        { Id: "bbb222", Name: "/sample-ha", State: { Status: state, StartedAt: "0001-01-01T00:00:00Z", FinishedAt: "2026-01-02T03:04:05Z" }, Mounts: [{ Source: `${configDir.toUpperCase()}\\`, Destination: "/config" }] },
      ]);
    }
    if (args[0] === "start") state = "running";
    return "";
  };
  const found = await findHomeAssistantContainer(configDir, docker);
  assert.deepEqual(found, { id: "bbb222", name: "sample-ha", state: "exited", startedAt: null, finishedAt: "2026-01-02T03:04:05Z" });
  assert.ok(!calls.some((args) => args[0] === "start" || args[0] === "stop"), "looking never starts or stops anything");
  assert.equal(await findHomeAssistantContainer("", docker), null);
  assert.equal(await findHomeAssistantContainer(join(tmpdir(), "elsewhere"), docker), null);
  const started = await controlHomeAssistantContainer(configDir, "start", docker);
  assert.equal(started.state, "running");
  assert.deepEqual(calls.find((args) => args[0] === "start"), ["start", "bbb222"]);
  await assert.rejects(controlHomeAssistantContainer(join(tmpdir(), "elsewhere"), "start", docker), /No Docker container mounts/);

  // A Docker that uses every millisecond it is given: lookup, start and re-check share ONE deadline, under the
  // console proxy's 90s answer limit, and a re-check that runs out of time still reports the start that happened.
  let clock = 0;
  const slowCalls: { args: string[]; timeoutMs: number }[] = [];
  state = "exited";
  const slowDocker = async (args: string[], timeoutMs: number) => {
    slowCalls.push({ args, timeoutMs });
    clock += timeoutMs;
    return docker(args);
  };
  const slow = await controlHomeAssistantContainer(configDir, "start", slowDocker, () => clock);
  assert.ok(clock <= CONTROL_DEADLINE_MS && CONTROL_DEADLINE_MS < 90_000, `start took ${clock}ms of fake time`);
  assert.ok(slowCalls.some((call) => call.args[0] === "start"), "the start itself still ran");
  assert.equal(slow.name, "sample-ha");
  clock = 0;
  const slowerDocker = async (args: string[], timeoutMs: number) => {
    clock += args[0] === "start" ? timeoutMs : 40_000;
    return docker(args);
  };
  await assert.rejects(controlHomeAssistantContainer(configDir, "start", slowerDocker, () => clock), /did not finish within 80s/);
  assert.ok(clock <= CONTROL_DEADLINE_MS, `a lookup that eats the budget stops before the start: ${clock}ms`);
});

await test("Deck import refuses failed reads without saving defaults, starts empty where no hub listens, and recovers", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ggo-import-"));
  let status = 500;
  const source = createServer((_req, res) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(status === 200 ? { value: { saved: "owner-config" } } : { error: "unavailable" }));
  });
  await new Promise<void>((resolve) => source.listen(0, "127.0.0.1", resolve));
  const hubUrl = `http://127.0.0.1:${(source.address() as AddressInfo).port}`;
  const configPath = join(dir, "config.json");
  const options = {
    file: new JsonFile<StoredConfig<{ saved: string }>>(configPath), hubUrl, sections: ["sample"],
    fromDeck: (sections: Record<string, unknown>) => sections.sample as { saved: string } | null,
    empty: () => ({ saved: "" }), log: () => undefined,
  };
  try {
    await assert.rejects(loadOrImport(options), /unavailable/);
    assert.equal(existsSync(configPath), false, "a failed import never writes editable defaults");
    status = 200;
    assert.equal((await loadOrImport(options)).value.saved, "owner-config");
    await rm(configPath);
    status = 404;
    assert.equal((await loadOrImport(options)).origin, "new", "a missing section is a valid empty setup");
    await rm(configPath);
    await new Promise<void>((resolve) => source.close(() => resolve()));
    const hubless = await loadOrImport(options);
    assert.equal(hubless.origin, "deck-unreachable", "a machine without Script Hub starts on an empty setup");
    assert.equal(hubless.value.saved, "");
    assert.equal(existsSync(configPath), false, "...which is not saved, so a hub that appears later still imports");
    await new Promise<void>((resolve) => source.listen(Number(new URL(hubUrl).port), "127.0.0.1", resolve));
    status = 200;
    assert.equal((await loadOrImport(options)).value.saved, "owner-config", "retry imports after an outage");
  } finally {
    await new Promise<void>((resolve) => source.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  }
});

await test("Script Hub: stalled and interrupted JSON bodies report unavailability and recover", async () => {
  let mode: "stall" | "disconnect" | "ok" = "stall";
  const source = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    if (mode === "ok") return res.end(JSON.stringify({ ok: true }));
    res.write("{");
    if (mode === "disconnect") setTimeout(() => res.destroy(), 25);
  });
  await new Promise<void>((resolve) => source.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(source.address() as AddressInfo).port}`;
  try {
    await assert.rejects(hubJson(url, "/api/status", { timeoutMs: 150 }), (error: unknown) =>
      error instanceof HttpError && error.status === 504 && error.extra.hubDown === true);
    mode = "disconnect";
    await assert.rejects(hubJson(url, "/api/status"), (error: unknown) =>
      error instanceof HttpError && error.status === 503 && error.extra.hubDown === true && !error.extra.hubAbsent);
    mode = "stall";
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), 150);
    try {
      await assert.rejects(hubJson(url, "/api/status", { signal: abort.signal }), (error: unknown) =>
        error instanceof Error && error.name === "AbortError" && !(error instanceof HttpError));
    } finally {
      clearTimeout(timer);
    }
    mode = "ok";
    assert.deepEqual(await hubJson(url, "/api/status"), { ok: true });
  } finally {
    source.closeAllConnections();
    await new Promise<void>((resolve) => source.close(() => resolve()));
  }
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

await test("sidekick: concurrent edits of one revision save once, reject the stale writer, and allow its retry", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ggo-sidekick-race-"));
  try {
    const settings = join(dir, "settings.json");
    const initial = JSON.stringify({ Version: 1, Rules: [], FutureField: "kept" });
    await writeFile(settings, initial);
    const revision = revisionForText(initial);
    const rule = (name: string) => ({ name, triggerProcess: "Example.exe", companions: [{ hubId: "overlay" }] });
    const results = await Promise.allSettled(["First", "Second"].map((name) => mutateRules(settings, { type: "create" }, { revision, rule: rule(name) })));
    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
    const refused = results.find((result) => result.status === "rejected");
    assert.ok(refused?.status === "rejected");
    assert.equal(refused.reason.status, 409);
    assert.equal(refused.reason.extra.code, "stale_config");
    const savedText = await readFile(settings, "utf8");
    const saved = JSON.parse(savedText);
    assert.deepEqual(saved.Rules.map((entry: { Name: string }) => entry.Name), ["First"]);
    assert.equal(saved.FutureField, "kept");
    await mutateRules(settings, { type: "create" }, { revision: revisionForText(savedText), rule: rule("Second") });
    assert.deepEqual(JSON.parse(await readFile(settings, "utf8")).Rules.map((entry: { Name: string }) => entry.Name), ["First", "Second"]);
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

    // Behind the deck's proxy: Host is rewritten, Origin names the deck, and Chromium sends no Sec-Fetch-Site on a
    // WebSocket handshake. The ticket is the guard there; an Origin-vs-Host check would refuse the owner's own cameras.
    const proxied = { cookie: authed.cookie, host: "127.0.0.1:4317", origin: "https://deck.example.com:3940" };
    const viaDeck = new WebSocket(`${base.replace("http", "ws")}/api/modules/surveillance/stream?ticket=${reused.body.ticket}`, { headers: proxied });
    const deckFrame = await new Promise<Buffer>((resolve, reject) => {
      viaDeck.once("message", (data) => resolve(data as Buffer));
      viaDeck.once("unexpected-response", (_req, res) => reject(new Error(`deck handshake answered ${res.statusCode}`)));
      viaDeck.once("error", reject);
      setTimeout(() => reject(new Error("no frame through the deck within 10s")), 10_000);
    });
    assert.equal(JSON.parse(deckFrame.subarray(2, 2 + deckFrame.readUInt16BE(0)).toString("utf8")).id, "cam-1");
    viaDeck.close();
    const { body: crossTicket } = await api("/api/modules/surveillance/ticket", { method: "POST", body: {} });
    const crossSite = new WebSocket(`${base.replace("http", "ws")}/api/modules/surveillance/stream?ticket=${crossTicket.ticket}`, { headers: { ...proxied, "sec-fetch-site": "cross-site" } });
    const crossStatus = await new Promise<number>((resolve) => {
      crossSite.once("unexpected-response", (_req, res) => resolve(res.statusCode ?? 0));
      crossSite.once("open", () => resolve(101));
      crossSite.once("error", () => resolve(-1));
    });
    assert.equal(crossStatus, 403, "a handshake the browser names cross-site is still refused");
    // Only the ticketed handshake skips the Origin fallback; an ordinary module request without Sec-Fetch-Site still needs it.
    const plainStatus = await new Promise<number>((resolve, reject) => {
      const url = new URL(`${base}/api/modules/surveillance/api/recording`);
      httpGet({ host: url.hostname, port: url.port, path: url.pathname, headers: proxied }, (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      }).once("error", reject);
    });
    assert.equal(plainStatus, 403);
  });

  await test("Surveillance: recordings list by day, seek by range, play as MP4 and refuse anything outside the camera's folder", async () => {
    const folder = join(root, "recordings", "Porch");
    await mkdir(folder, { recursive: true });
    const plain = await writeSegment(folder, Date.now() - 2 * 3_600_000, 4096);
    const listed = await api("/api/modules/surveillance/api/recordings");
    assert.equal(listed.status, 200, JSON.stringify(listed.body));
    const porch = listed.body.cameras.find((c: { cameraId: string }) => c.cameraId === "cam-1");
    assert.equal(porch.folderFound, true);
    assert.ok(porch.segments >= 1 && porch.days.length >= 1);
    assert.equal(listed.body.retention.retentionDays, 0, "an imported setup keeps everything until told otherwise");
    const day = await api(`/api/modules/surveillance/api/recordings/cam-1/days/${plain.slice(0, 10)}`);
    assert.ok(day.body.segments.some((segment: { name: string }) => segment.name === plain));

    const ranged = await fetch(`${base}/api/modules/surveillance/api/recordings/cam-1/segments/${plain}/file`, { headers: { ...authed, range: "bytes=10-19" } });
    assert.equal(ranged.status, 206);
    assert.equal(ranged.headers.get("content-range"), "bytes 10-19/4096");
    assert.match(ranged.headers.get("content-disposition") ?? "", /attachment; filename="Porch /);
    assert.equal((await ranged.arrayBuffer()).byteLength, 10);
    const backwards = await fetch(`${base}/api/modules/surveillance/api/recordings/cam-1/segments/${plain}/file`, { headers: { ...authed, range: "bytes=19-10" } });
    assert.equal(backwards.status, 200, "a range that cannot be parsed is ignored, as RFC 9110 asks");
    assert.equal((await backwards.arrayBuffer()).byteLength, 4096);
    const beyond = await fetch(`${base}/api/modules/surveillance/api/recordings/cam-1/segments/${plain}/file`, { headers: { ...authed, range: "bytes=5000-" } });
    assert.equal(beyond.status, 416);
    assert.equal(beyond.headers.get("content-range"), "bytes */4096");
    // Each must reach the segment route still encoded and be refused there, not re-routed by a decoded separator.
    for (const bad of [encodeURIComponent(`..\\..\\data\\${plain}`), "notes.txt", encodeURIComponent("../secret.ts"), encodeURIComponent(`../Porch/${plain}`)]) {
      const refused = await api(`/api/modules/surveillance/api/recordings/cam-1/segments/${bad}/file`);
      assert.equal(refused.status, 400, `${bad} answered ${refused.status}`);
      assert.match(refused.body.error, /not a recording segment/, bad);
    }
    assert.equal((await api("/api/modules/surveillance/api/recordings/cleanup", { method: "POST", body: {} })).status, 400, "cleanup refuses while retention is off");

    const ffmpeg = ffmpegOnPath();
    if (!ffmpeg) {
      console.log("  (no ffmpeg on PATH: MP4 playback not exercised)");
      return;
    }
    const clipAt = Date.now() - 3_600_000;
    const clip = segmentName(clipAt);
    execFileSync(ffmpeg, ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc=size=160x120:rate=2", "-t", "3", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-f", "mpegts", join(folder, clip)], { windowsHide: true });
    await utimes(join(folder, clip), new Date(clipAt), new Date(clipAt));
    const video = await fetch(`${base}/api/modules/surveillance/api/recordings/cam-1/segments/${clip}/video`, { headers: authed });
    assert.equal(video.status, 200, await video.clone().text());
    assert.equal(video.headers.get("content-type"), "video/mp4");
    assert.equal(video.headers.get("accept-ranges"), "bytes");
    const mp4 = Buffer.from(await video.arrayBuffer());
    assert.equal(mp4.subarray(4, 8).toString("latin1"), "ftyp", "the segment arrives re-wrapped as MP4");
    const seek = await fetch(`${base}/api/modules/surveillance/api/recordings/cam-1/segments/${clip}/video`, { headers: { ...authed, range: "bytes=0-7" } });
    assert.equal(seek.status, 206, "the cached MP4 can be seeked");

    const playUrl = (version: string) => `${base}/api/modules/surveillance/api/recordings/cam-1/segments/${clip}/video?v=${version}`;
    const pinnedBytes = (await (await fetch(playUrl("1"), { headers: authed })).arrayBuffer()).byteLength;
    await appendFile(join(folder, clip), await readFile(join(folder, clip)));
    assert.equal((await (await fetch(playUrl("1"), { headers: authed })).arrayBuffer()).byteLength, pinnedBytes, "one playback keeps reading the copy it started with while the file grows");
    assert.ok((await (await fetch(playUrl("2"), { headers: authed })).arrayBuffer()).byteLength > pinnedBytes, "a new listing plays what has been written since");
  });

  await test("Surveillance: 24/7 is off until chosen, outlives a worker restart, ignores stale config edits, and stops on Off", async () => {
    const closed = createServer();
    await new Promise<void>((resolve) => closed.listen(0, "127.0.0.1", resolve));
    const deadPort = (closed.address() as AddressInfo).port;
    await new Promise<void>((resolve) => closed.close(() => resolve()));
    const armedFile = join(modulePaths(dataDir, "surveillance").dir, "armed.json");
    const mode = (value: string) => api("/api/modules/surveillance/api/recording/mode", { method: "PUT", body: { mode: value } });

    assert.equal((await api("/api/modules/surveillance/api/recording")).body.mode, "off");
    const noStream = await mode("continuous");
    assert.equal(noStream.status, 400);
    assert.match(noStream.body.error, /RTSP stream/);
    assert.equal(existsSync(armedFile), false, "a refused plan arms nothing");

    const config = (await api("/api/modules/surveillance/api/config")).body;
    config.cameras[0].streamUrl = `rtsp://127.0.0.1:${deadPort}/live`;
    config.recording.schedule.days = [];
    assert.equal((await api("/api/modules/surveillance/api/config", { method: "PUT", body: config })).status, 200);
    const noDays = await mode("schedule");
    assert.equal(noDays.status, 400);
    assert.match(noDays.body.error, /no days/, "a schedule that can never record is refused");
    if (!ffmpegOnPath()) {
      assert.match((await mode("continuous")).body.error, /ffmpeg/);
      console.log("  (no ffmpeg on PATH: 24/7 recording not exercised)");
      return;
    }
    const on = await mode("continuous");
    assert.equal(on.status, 200, JSON.stringify(on.body));
    assert.equal(on.body.mode, "continuous");
    assert.equal(on.body.active, true);
    assert.equal((await api("/api/modules/surveillance/service")).body.busy, "recording 1 camera 24/7");
    assert.ok(existsSync(armedFile), "24/7 is declared as user-started work");

    const stale = (await api("/api/modules/surveillance/api/config")).body;
    assert.equal((await api("/api/modules/surveillance/api/config", { method: "PUT", body: { ...stale, recording: { ...stale.recording, mode: "off" } } })).status, 200);
    assert.equal((await api("/api/modules/surveillance/api/recording")).body.mode, "continuous", "a config edit never switches recording off");

    const before = (await api("/api/modules/surveillance/service")).body.pid;
    assert.equal((await api("/api/modules/surveillance/service/stop", { method: "POST", body: {} })).status, 409, "a plain Stop refuses while 24/7 runs");
    await supervisor.restart("surveillance");
    const resumed = await api("/api/modules/surveillance/api/recording");
    assert.notEqual((await api("/api/modules/surveillance/service")).body.pid, before);
    assert.equal(resumed.body.mode, "continuous");
    assert.equal(resumed.body.active, true, "24/7 comes back in the new worker");

    const off = await mode("off");
    assert.equal(off.body.active, false);
    assert.equal(existsSync(armedFile), false);
    assert.equal((await api("/api/modules/surveillance/service")).body.busy, null);

    assert.equal((await mode("continuous")).status, 200);
    await supervisor.stop("surveillance", { force: true });
    const after = await api("/api/modules/surveillance/api/recording");
    assert.equal(after.body.mode, "off", "stopping the service anyway turns 24/7 off for good");
    assert.equal(after.body.active, false);
    const saved = JSON.parse(readFileSync(modulePaths(dataDir, "surveillance").config, "utf8"));
    assert.equal(saved.value.recording.mode, "off");

    // A recording started on the build before modes existed: armed, and config.json has no recording block.
    delete saved.value.recording;
    writeFileSync(modulePaths(dataDir, "surveillance").config, JSON.stringify(saved));
    writeFileSync(armedFile, JSON.stringify({ reason: "recording 1 camera", at: Date.now() }));
    await supervisor.restart("surveillance");
    const carried = await api("/api/modules/surveillance/api/recording");
    assert.equal(carried.body.mode, "continuous", "an older build's running recording carries on as 24/7");
    assert.equal(carried.body.active, true);
    assert.equal((await mode("off")).body.active, false);
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
    const names = ["Morning", "Evening"];
    const concurrent = await Promise.all(names.map((name) => api(`/api/modules/sidekick/api/rules/${RULE_ID}`, {
      method: "PUT", body: { revision: saved.body.revision, rule: { name, triggerProcess: "Example.exe", companions: [{ id: COMPANION_ID, hubId: "overlay" }] } },
    })));
    assert.deepEqual(concurrent.map((result) => result.status).sort(), [200, 409]);
    const refused = concurrent.findIndex((result) => result.status === 409);
    assert.equal(concurrent[refused]!.body.code, "stale_config");
    const latest = await api("/api/modules/sidekick/api/state");
    assert.equal(latest.body.rules[0].name, names[1 - refused]);
    const retried = await api(`/api/modules/sidekick/api/rules/${RULE_ID}`, {
      method: "PUT", body: { revision: latest.body.settingsRevision, rule: { name: names[refused], triggerProcess: "Example.exe", companions: [{ id: COMPANION_ID, hubId: "overlay" }] } },
    });
    assert.equal(retried.status, 200);
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
    await new Promise<void>((resolve) => hub.listen(hubPort, "127.0.0.1", resolve));
  });

  await test("on a machine without Script Hub, Surveillance and Home start empty and save nothing until edited", async () => {
    const closed = createServer();
    await new Promise<void>((resolve) => closed.listen(0, "127.0.0.1", resolve));
    const nowhere = `http://127.0.0.1:${(closed.address() as AddressInfo).port}`;
    await new Promise<void>((resolve) => closed.close(() => resolve()));
    const hublessDir = join(root, "hubless");
    const hubless = new ModuleSupervisor({ dataDir: hublessDir, build: "build-one", hubUrl: nowhere, idleExitMs: 120_000 });
    extraSupervisors.push(hubless);
    for (const id of ["surveillance", "home"] as const) {
      const connection = await hubless.ensure(id);
      const config = (await (await hubless.request(connection, "/config")).json()) as { origin: string; cameras?: unknown[]; devices?: unknown[] };
      assert.equal(config.origin, "deck-unreachable", `${id} starts`);
      assert.equal(existsSync(modulePaths(hublessDir, id).config), false, `${id} saves nothing it was not asked to`);
    }
    const surveillance = await hubless.ensure("surveillance");
    const blank = (await (await hubless.request(surveillance, "/config")).json()) as Record<string, unknown>;
    const saved = await hubless.request(surveillance, "/config", { method: "PUT", body: JSON.stringify({ ...blank, recordingRoot: join(root, "hubless-recordings") }), headers: { "content-type": "application/json" } });
    assert.equal(saved.status, 200);
    const written = JSON.parse(readFileSync(modulePaths(hublessDir, "surveillance").config, "utf8"));
    assert.equal(written.origin, "new", "the owner's first save makes it a real setup");
    assert.equal(written.value.recording.retentionDays, 0, "a setup that could not import keeps everything, like any other");
    assert.equal(written.value.recording.mode, "off");
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
    // The record goes first and the process ends a moment later as it exits by itself.
    await waitFor("idle worker process gone", async () => pidAlive(connection.health.pid), (alive) => !alive, 10_000);
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
