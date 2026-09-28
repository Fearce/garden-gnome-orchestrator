import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify from "fastify";
import websocket from "@fastify/websocket";
import WebSocket from "ws";
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

  await app.close();
  console.log(`\nremote control: ${checks} checks passed`);
} finally {
  await rm(dataDir, { recursive: true, force: true });
}
