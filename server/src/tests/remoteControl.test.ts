import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify from "fastify";
import websocket from "@fastify/websocket";
import WebSocket from "ws";
import { Capture, type CaptureEvents } from "../remoteControl/capture.js";
import { AdaptiveRate, FrameFlow, LOST_FRAME_MS, MAX_BACKLOG_MS, MAX_SOCKET_BUFFER_BYTES, RATE_LADDER } from "../remoteControl/flowControl.js";
import { FlvDemuxer, avcCodecString } from "../remoteControl/flv.js";
import { scanKeyFor } from "../remoteControl/keymap.js";
import { QUALITY_PRESETS, captureFilter, explainEncoderError, fitSize, streamArgs, type FfmpegProbe } from "../remoteControl/ffmpeg.js";
import { RemoteControlError, RemoteControlService, recommend } from "../remoteControl/service.js";
import { registerRemoteControlRoutes } from "../remoteControl/routes.js";

let checks = 0;
async function test(name: string, fn: () => Promise<void> | void) {
  await fn();
  console.log(`✓ ${name}`);
  checks++;
}

const AVCC = Buffer.from([1, 0x64, 0x00, 0x2a, 0xff, 0xe1, 0x00, 0x04, 0x67, 0x64, 0x00, 0x2a, 0x01, 0x00, 0x02, 0x68, 0xce]);

function flvTag(type: number, timestampMs: number, body: Buffer): Buffer {
  const header = Buffer.alloc(11);
  header[0] = type;
  header.writeUIntBE(body.length, 1, 3);
  header.writeUIntBE(timestampMs & 0xffffff, 4, 3);
  header[7] = (timestampMs >>> 24) & 0xff;
  const previous = Buffer.alloc(4);
  previous.writeUInt32BE(11 + body.length);
  return Buffer.concat([header, body, previous]);
}

function flvStream(): Buffer {
  const fileHeader = Buffer.from([0x46, 0x4c, 0x56, 1, 1, 0, 0, 0, 9, 0, 0, 0, 0]);
  const script = flvTag(18, 0, Buffer.from([2, 0, 10, ...Buffer.from("onMetaData")]));
  const config = flvTag(9, 0, Buffer.concat([Buffer.from([0x17, 0, 0, 0, 0]), AVCC]));
  const key = flvTag(9, 0, Buffer.concat([Buffer.from([0x17, 1, 0, 0, 0]), Buffer.from([0, 0, 0, 2, 0x65, 0x88])]));
  const delta = flvTag(9, 0x01_000_010, Buffer.concat([Buffer.from([0x27, 1, 0, 0, 0]), Buffer.from([0, 0, 0, 2, 0x41, 0x9a])]));
  return Buffer.concat([fileHeader, script, config, key, delta]);
}

/**
 * Streams `seconds` of 30 fps video through a FrameFlow on a fake clock. `ackDelay(t)` is how long the
 * viewer takes to ack a frame sent at t; keyframes come once a second.
 */
function simulateFlow(seconds: number, ackDelay: (t: number) => number, bufferedBytes = 0): boolean[] {
  let now = 0;
  const flow = new FrameFlow(() => now);
  let acks: { at: number; seq: number }[] = [];
  const admitted: boolean[] = [];
  for (let frame = 0; frame < seconds * 30; frame++) {
    now = frame * (1000 / 30);
    for (const ack of acks) if (ack.at <= now) flow.acked(ack.seq);
    acks = acks.filter((ack) => ack.at > now);
    const ok = flow.admit(frame % 30 === 0, bufferedBytes);
    admitted.push(ok);
    if (ok) acks.push({ at: now + ackDelay(now), seq: flow.sent() });
  }
  return admitted;
}

/** Feeds an AdaptiveRate one skip episode per `at`, each followed by a calm frame half a second later. */
function skips(rate: AdaptiveRate, clock: { now: number }, ...at: number[]): boolean {
  let changed = false;
  for (const t of at) {
    clock.now = t;
    changed = rate.observe(MAX_BACKLOG_MS + 100, true) || changed;
    clock.now = t + 500;
    changed = rate.observe(50, false) || changed;
  }
  return changed;
}

const DISPLAY = { index: 0, name: "test", x: 0, y: 0, width: 1920, height: 1080, primary: true };

/**
 * Runs a Capture with node standing in for ffmpeg: the child writes `flvStream()`, its pid to `pidFile`,
 * then `stderr`, and either exits or stays alive like a capture does.
 */
function fakeCapture(pidFile: string, stayAlive: boolean, events: Partial<CaptureEvents>): Capture {
  const script = `require("fs").writeFileSync(process.argv[2], String(process.pid));
process.stdout.write(Buffer.from(process.argv[1], "base64"));
process.stderr.write("fake encoder done");
if (${stayAlive}) setInterval(() => {}, 1000);`;
  const noop = () => {};
  return new Capture(process.execPath, ["-e", script, flvStream().toString("base64"), pidFile], DISPLAY, { width: 1920, height: 1080 }, {
    onConfig: events.onConfig ?? noop,
    onFrame: events.onFrame ?? noop,
    onExit: events.onExit ?? noop,
  });
}

async function until(condition: () => boolean, what: string, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function memoryDb() {
  const kv = new Map<string, string>();
  return { kvGet: (key: string) => kv.get(key) ?? null, kvSet: (key: string, value: string) => void kv.set(key, value), kv };
}

const dataDir = await mkdtemp(join(tmpdir(), "ggo-remote-control-test-"));
try {
  await test("FLV demuxer emits config and frames as soon as each tag completes, across any chunking", () => {
    const stream = flvStream();
    for (const size of [1, 3, 7, stream.length]) {
      const demuxer = new FlvDemuxer();
      const packets = [];
      for (let i = 0; i < stream.length; i += size) packets.push(...demuxer.push(stream.subarray(i, i + size)));
      assert.equal(packets.length, 3, `chunk ${size}`);
      assert.deepEqual(packets[0], { kind: "config", avcc: AVCC, codec: "avc1.64002a" });
      assert.equal(packets[1]!.kind === "frame" && packets[1]!.key, true);
      assert.ok(packets[2]!.kind === "frame" && !packets[2]!.key && packets[2]!.timestampMs === 0x01_000_010);
      assert.deepEqual(packets[2]!.kind === "frame" && [...packets[2]!.data], [0, 0, 0, 2, 0x41, 0x9a]);
    }
  });

  await test("FLV demuxer refuses a stream that is not FLV, not H.264, or has an absurd tag length", () => {
    assert.throws(() => new FlvDemuxer().push(Buffer.from("NOPE-not-flv-at-all")), /not an FLV/);
    const hevc = Buffer.concat([flvStream().subarray(0, 13), flvTag(9, 0, Buffer.from([0x1c, 0, 0, 0, 0, 1]))]);
    assert.throws(() => new FlvDemuxer().push(hevc), /not H\.264/);
    const huge = Buffer.concat([flvStream().subarray(0, 13), Buffer.from([9, 0xff, 0xff, 0xff, 0, 0, 0, 0, 0, 0, 0])]);
    assert.throws(() => new FlvDemuxer().push(huge), /not plausible/);
    assert.throws(() => avcCodecString(Buffer.from([0, 1, 2, 3])), /AVCDecoderConfigurationRecord/);
  });

  await test("key codes map to set-1 scancodes, extended where the E0 prefix is needed", () => {
    assert.deepEqual(scanKeyFor("KeyA"), { scan: 0x1e, extended: false });
    assert.deepEqual(scanKeyFor("Enter"), { scan: 0x1c, extended: false });
    assert.deepEqual(scanKeyFor("NumpadEnter"), { scan: 0x1c, extended: true });
    assert.deepEqual(scanKeyFor("ArrowLeft"), { scan: 0x4b, extended: true });
    assert.deepEqual(scanKeyFor("MetaLeft"), { scan: 0x5b, extended: true });
    assert.equal(scanKeyFor("toString"), null);
    assert.equal(scanKeyFor("NotAKey"), null);
  });

  await test("capture size fits the preset box, keeps aspect, stays even, and never upscales", () => {
    assert.deepEqual(fitSize({ width: 2560, height: 1440 }, QUALITY_PRESETS.smooth), { width: 1920, height: 1080 });
    assert.deepEqual(fitSize({ width: 2560, height: 1440 }, QUALITY_PRESETS.sharp), { width: 2560, height: 1440 });
    assert.deepEqual(fitSize({ width: 3440, height: 1440 }, QUALITY_PRESETS.saver), { width: 1280, height: 536 });
    assert.deepEqual(fitSize({ width: 1366, height: 768 }, QUALITY_PRESETS.smooth), { width: 1366, height: 768 });
  });

  await test("stream args: GPU path scales on the GPU to NV12, native size skips the scale, output is flushed FLV", () => {
    const scaled = streamArgs("h264_nvenc", 1, { width: 2560, height: 1440 }, QUALITY_PRESETS.smooth);
    const graph = scaled.args[scaled.args.indexOf("-filter_complex") + 1]!;
    assert.equal(graph, "ddagrab=output_idx=1:framerate=60:draw_mouse=1,scale_d3d11=width=1920:height=1080:format=nv12");
    assert.ok(scaled.args.includes("-bf") && scaled.args[scaled.args.indexOf("-bf") + 1] === "0");
    assert.deepEqual(scaled.args.slice(-7), ["-f", "flv", "-flvflags", "no_duration_filesize", "-flush_packets", "1", "pipe:1"]);
    const native = streamArgs("h264_nvenc", 0, { width: 1920, height: 1080 }, QUALITY_PRESETS.smooth);
    assert.equal(native.args[native.args.indexOf("-filter_complex") + 1], "ddagrab=output_idx=0:framerate=60:draw_mouse=1,scale_d3d11=format=nv12");
    assert.equal(captureFilter("libx264", 2, 30, { width: 1280, height: 720 }), "ddagrab=output_idx=2:framerate=30:draw_mouse=1,hwdownload,format=bgra,scale=1280:720:flags=bilinear,format=yuv420p");
  });

  await test("encoder failures are explained in owner terms", () => {
    const driver = "[h264_nvenc @ 0x1] Driver does not support the required nvenc API version. Required: 13.1 Found: 13.0\n[h264_nvenc @ 0x1] The minimum required Nvidia driver for nvenc is 610.00 or newer";
    assert.match(explainEncoderError(driver), /NVENC API 13\.1.*13\.0.*610\.00\+.*8\.0\.1/);
    assert.equal(explainEncoderError("Cannot load nvcuda.dll"), "No NVIDIA GPU with NVENC is available.");
    assert.match(explainEncoderError("[Parsed_ddagrab_0 @ 1] Failed to duplicate output"), /screen may be locked/);
    assert.equal(explainEncoderError("[x @ 1] Something odd\nConversion failed!"), "Something odd");
  });

  await test("the recommendation prefers a working GPU encoder over the CPU fallback, in any ffmpeg", () => {
    const probe = (path: string, nvenc: boolean): FfmpegProbe => ({
      path, source: "path", version: "x", ddagrab: true,
      encoders: [{ encoder: "h264_nvenc", ok: nvenc }, { encoder: "libx264", ok: true }],
    });
    assert.deepEqual(recommend([probe("a.exe", false), probe("b.exe", true)]), { ffmpegPath: "b.exe", encoder: "h264_nvenc" });
    assert.deepEqual(recommend([probe("a.exe", false)]), { ffmpegPath: "a.exe", encoder: "libx264" });
    assert.equal(recommend([]), null);
  });

  const db = memoryDb();
  const service = new RemoteControlService(db, dataDir);

  await test("setup refuses to switch on without a checked encoder, or to run an ffmpeg no check has seen", async () => {
    if (!service.supported) {
      await assert.rejects(service.saveConfig({ enabled: true }), (e) => e instanceof RemoteControlError && e.status === 501);
      return;
    }
    await assert.rejects(service.saveConfig({ enabled: true }), /Run the check and choose an encoder/);
    await assert.rejects(service.saveConfig({ ffmpegPath: "C:\\Windows\\System32\\calc.exe" }), /has not been probed/);
    await assert.rejects(service.thumbnail(0, "C:\\Windows\\System32\\calc.exe"), /has not been probed/);
    assert.throws(() => service.issueTicket(), (e) => e instanceof RemoteControlError && e.status === 409);
    assert.equal(service.config().enabled, false);
  });

  await test("stream tickets are single-use and expire", () => {
    if (!service.supported) return;
    db.kv.set("remote_control_config", JSON.stringify({ enabled: true, ffmpegPath: "ffmpeg.exe", encoder: "libx264" }));
    const ticket = service.issueTicket();
    assert.equal(service.redeemTicket(ticket), true);
    assert.equal(service.redeemTicket(ticket), false);
    assert.equal(service.redeemTicket(undefined), false);
    assert.equal(service.redeemTicket("made-up"), false);
    const realNow = Date.now;
    const stale = service.issueTicket();
    Date.now = () => realNow() + 60_000;
    try {
      assert.equal(service.redeemTicket(stale), false);
    } finally {
      Date.now = realNow;
    }
  });

  const app = Fastify();
  await app.register(websocket);
  registerRemoteControlRoutes(app, service, (cookie) => cookie === "session=test");
  await app.listen({ port: 0, host: "127.0.0.1" });
  const port = (app.server.address() as { port: number }).port;
  const authed = { cookie: "session=test" };

  await test("every route needs the session and refuses cross-site callers", async () => {
    assert.equal((await app.inject({ url: "/api/remote-control/status" })).statusCode, 401);
    assert.equal((await app.inject({ method: "POST", url: "/api/remote-control/ticket" })).statusCode, 401);
    assert.equal((await app.inject({ url: "/api/remote-control/status", headers: { ...authed, "sec-fetch-site": "cross-site" } })).statusCode, 403);
    assert.equal((await app.inject({ url: "/api/remote-control/status", headers: { ...authed, "sec-fetch-site": "same-site" } })).statusCode, 403);
    const ok = await app.inject({ url: "/api/remote-control/status", headers: { ...authed, "sec-fetch-site": "same-origin" } });
    assert.equal(ok.statusCode, 200);
    assert.equal(ok.headers["cache-control"], "no-store");
    const bad = await app.inject({ method: "PUT", url: "/api/remote-control/config", headers: authed, payload: { encoder: "evil" } });
    assert.equal(bad.statusCode, 400);
    const extra = await app.inject({ method: "PUT", url: "/api/remote-control/config", headers: authed, payload: { setupAt: 1 } });
    assert.equal(extra.statusCode, 400);
  });

  await test("the stream socket refuses a missing or reused ticket, and a request without the session", async () => {
    const closeCode = (url: string, headers: Record<string, string>) => new Promise<number | string>((resolve) => {
      const socket = new WebSocket(url, { headers });
      socket.on("close", (code) => resolve(code));
      socket.on("unexpected-response", (_req, res) => { resolve(`http ${res.statusCode}`); socket.terminate(); });
      socket.on("error", () => undefined);
    });
    const base = `ws://127.0.0.1:${port}/api/remote-control/stream`;
    assert.equal(await closeCode(base, authed), 4403);
    assert.equal(await closeCode(`${base}?ticket=made-up`, authed), 4403);
    assert.equal(await closeCode(`${base}?ticket=whatever`, {}), "http 401");
    if (service.supported) {
      const ticket = service.issueTicket();
      service.redeemTicket(ticket);
      assert.equal(await closeCode(`${base}?ticket=${ticket}`, authed), 4403);
    }
  });

  await test("flow control: a long but steady round trip is latency, not backlog, so nothing is skipped", () => {
    // 350 ms from send to paint is ~10 frames in flight at 30 fps: RTT plus an Android decoder's buffering.
    const admitted = simulateFlow(10, () => 350 + Math.random() * 40);
    assert.equal(admitted.filter((ok) => !ok).length, 0);
  });

  await test("flow control: a stall past the backlog bound skips to a keyframe, and resumes there once drained", () => {
    // The viewer's acks stop arriving between 3 s and 4.5 s (a dead link), then it catches up.
    const admitted = simulateFlow(8, (t) => (t >= 3000 && t < 4500 ? 4500 - t + 100 : 100));
    const firstSkip = admitted.indexOf(false);
    assert.ok(firstSkip > 90 && firstSkip * (1000 / 30) < 3000 + 100 + MAX_BACKLOG_MS + 50, `first skip at frame ${firstSkip}`);
    const resumed = admitted.indexOf(true, firstSkip);
    assert.equal(resumed % 30, 0, "sending resumes on a keyframe");
    assert.ok(admitted.slice(resumed).every(Boolean), "and keeps sending once caught up");
  });

  await test("flow control: a queue creeping up too slowly to stand out in the floor window is still caught", () => {
    // Each frame waits 40 ms longer per second than the last: the link is slightly slower than the stream,
    // so the growth inside any floor window stays under the backlog bound.
    const admitted = simulateFlow(30, (t) => 100 + (t / 1000) * 40);
    assert.ok(admitted.includes(false), "the capped floor exposes the growing queue");
  });

  await test("flow control: frames the viewer never acknowledges are written off, so skipping cannot last forever", () => {
    // A decoder error on the viewer swallows the acks of every frame sent from 10 s until the skip starts.
    // Nothing is sent while skipping, so no later ack can ever move past them.
    const admitted = simulateFlow(20, (t) => (t >= 10_000 && t < 11_000 ? Number.POSITIVE_INFINITY : 100));
    const firstSkip = admitted.indexOf(false);
    assert.ok(firstSkip * (1000 / 30) > 10_000, `first skip at frame ${firstSkip}`);
    const resumed = admitted.indexOf(true, firstSkip);
    assert.ok(resumed > 0 && resumed * (1000 / 30) < 10_000 + LOST_FRAME_MS + 1_100, `resumed at frame ${resumed}`);
    assert.equal(resumed % 30, 0, "sending resumes on a keyframe");
    assert.ok(admitted.slice(resumed).every(Boolean), "and keeps sending");
  });

  await test("flow control: a restart lets the next keyframe out even mid-skip, as a handover needs", () => {
    let now = 0;
    const flow = new FrameFlow(() => now);
    flow.sent();
    now = MAX_BACKLOG_MS + 100;
    assert.equal(flow.admit(false, 0), false);
    assert.equal(flow.skipping, true);
    flow.restart();
    assert.equal(flow.admit(true, 0), true, "the new capture's first keyframe goes out");
    assert.equal(flow.admit(true, MAX_SOCKET_BUFFER_BYTES + 1), false, "but never into a full socket");
  });

  await test("flow control: a viewer that stops reading fills the socket buffer and is skipped at once", () => {
    assert.ok(simulateFlow(1, () => 50, MAX_SOCKET_BUFFER_BYTES + 1).every((ok) => !ok));
  });

  await test("adaptive rate: one stall keeps the rate, repeated skips step it down, calm steps it back up", () => {
    const clock = { now: 0 };
    const rate = new AdaptiveRate(() => clock.now);
    assert.equal(skips(rate, clock, 5_000), false, "a single skip is a stall");
    assert.equal(skips(rate, clock, 40_000), false, "two skips far apart are two stalls");
    assert.equal(skips(rate, clock, 45_000), true, "two within the window step down");
    assert.equal(rate.factor, RATE_LADDER[1]);
    clock.now = 60_000;
    assert.equal(rate.observe(50, false), false, "not calm long enough yet");
    clock.now = 76_000;
    assert.equal(rate.observe(50, false), true, "30 s calm steps back up");
    assert.equal(rate.factor, 1);
  });

  await test("adaptive rate: a raise that fails right away waits twice as long next time, and a new quality resets it", () => {
    const clock = { now: 0 };
    const rate = new AdaptiveRate(() => clock.now);
    skips(rate, clock, 1_000, 5_000);
    assert.equal(rate.factor, RATE_LADDER[1]);
    clock.now = 36_000;
    assert.equal(rate.observe(50, false), true, "raised after 30 s calm");
    skips(rate, clock, 40_000, 44_000);
    assert.equal(rate.factor, RATE_LADDER[1], "the raise failed");
    clock.now = 44_500 + 31_000;
    assert.equal(rate.observe(50, false), false, "30 s is no longer enough");
    clock.now = 44_500 + 61_000;
    assert.equal(rate.observe(50, false), true, "60 s is");
    skips(rate, clock, 110_000, 114_000);
    assert.equal(rate.factor, RATE_LADDER[1]);
    rate.reset();
    assert.equal(rate.factor, 1);
  });

  await test("capture: the worker's ffmpeg output is demuxed into config and frames, and stop() kills it", async () => {
    const pidFile = join(dataDir, "capture-stop.pid");
    const seen: string[] = [];
    let exited = false;
    const capture = fakeCapture(pidFile, true, {
      onConfig: (_c, packet) => seen.push(`config ${packet.codec}`),
      onFrame: (_c, packet) => seen.push(packet.key ? "key" : "delta"),
      onExit: () => { exited = true; },
    });
    await until(() => capture.frames === 2, "both frames");
    assert.deepEqual(seen, ["config avc1.64002a", "key", "delta"]);
    await until(() => existsSync(pidFile), "the child's pid");
    const pid = Number(readFileSync(pidFile, "utf8"));
    assert.ok(alive(pid), "the capture is running");
    capture.stop();
    await until(() => !alive(pid), "the child to be killed");
    assert.equal(exited, false, "a stop is not reported as the capture dying");
  });

  await test("capture: a child that ends on its own is reported with its stderr", async () => {
    let stderr: string | null = null;
    fakeCapture(join(dataDir, "capture-exit.pid"), false, { onExit: (_c, text) => { stderr = text; } });
    await until(() => stderr !== null, "the exit report");
    assert.match(stderr!, /fake encoder done/);
  });

  await app.close();
  console.log(`\nremote control: ${checks} checks passed`);
} finally {
  await rm(dataDir, { recursive: true, force: true });
}
