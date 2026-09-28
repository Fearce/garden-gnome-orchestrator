// Measures how smoothly the remote-control stream plays over an emulated tablet link: the real
// RemoteSession (ffmpeg capture of this PC's primary display) → a relay that imposes latency, jitter,
// a bandwidth bottleneck and Wi-Fi-style stalls → the real web StreamClient decoding in headless Brave,
// with a decoder that holds frames the way Android's hardware decoders do. Nothing is clicked or typed:
// the session gets a stub input helper, so the PC's desktop is only watched, never driven. It runs its
// own session, so it does not take the viewer slot from anyone connected to the live console.
//
//   npm run remote-stream-lab --prefix server [-- --seconds 20 --only wifi --quality saver]
import { createRequire } from "node:module";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer, WebSocket } from "ws";
import { DesktopHelper, ensureHelperBuilt, type DisplayInfo } from "../src/remoteControl/desktop.js";
import { managedFfmpegPath, type QualityId } from "../src/remoteControl/ffmpeg.js";
import { RemoteSession, pickDisplay } from "../src/remoteControl/session.js";

const require = createRequire(import.meta.url);
const { chromium } = require("C:/Users/theke/AppData/Roaming/npm/node_modules/playwright") as typeof import("playwright");
const esbuild = require("esbuild") as typeof import("esbuild");

const BRAVE = "C:/Program Files/BraveSoftware/Brave-Browser/Application/brave.exe";
const SERVER_DIR = fileURLToPath(new URL("..", import.meta.url));
const REMOTE_DIR = join(SERVER_DIR, "data", "remote-control");
const STREAM_CLIENT = join(SERVER_DIR, "..", "web", "src", "components", "remote", "streamClient.ts");
// A paint gap this long reads as a freeze, not as a slow frame.
const FREEZE_MS = 200;

interface Link {
  name: string;
  rttMs: number;
  jitterMs: number;
  downMbps: number;
  /** How long the viewer's decoder holds each frame before output (Android MediaCodec buffers a few). */
  decoderHoldMs: number;
  /** Periodic dead air in both directions: Wi-Fi power save, a roaming hop, a busy cell. */
  stall: { everyMs: number; forMs: number } | null;
  /** Qualities the viewer switches to, evenly spaced over the run: each one restarts the encoder. */
  switches?: QualityId[];
}

const LINKS: Link[] = [
  { name: "clean", rttMs: 25, jitterMs: 5, downMbps: 60, decoderHoldMs: 40, stall: null },
  { name: "wifi", rttMs: 40, jitterMs: 25, downMbps: 30, decoderHoldMs: 90, stall: { everyMs: 2_500, forMs: 180 } },
  { name: "tight", rttMs: 45, jitterMs: 15, downMbps: 6, decoderHoldMs: 70, stall: null },
  { name: "rough", rttMs: 70, jitterMs: 40, downMbps: 12, decoderHoldMs: 100, stall: { everyMs: 4_000, forMs: 350 } },
  // Below Data saver's own 4 Mb/s: only a lower bitrate can play this without skipping.
  { name: "slow", rttMs: 50, jitterMs: 15, downMbps: 3, decoderHoldMs: 70, stall: null },
  // A quality switch hands over to a new encoder; the picture should keep moving through it.
  { name: "switch", rttMs: 25, jitterMs: 5, downMbps: 60, decoderHoldMs: 40, stall: null, switches: ["smooth", "saver", "smooth", "saver"] },
];

function arg(name: string): string | undefined {
  const at = process.argv.indexOf(`--${name}`);
  return at > 0 ? process.argv[at + 1] : undefined;
}

const seconds = Number(arg("seconds") ?? 20);
const quality = (arg("quality") ?? "saver") as QualityId;
const only = arg("only");

/** Browser-side harness: a decoder that holds output, a paint recorder, and the real StreamClient. */
function pageHtml(bundle: string, holdMs: number, relayUrl: string): string {
  return `<!doctype html><html><body style="margin:0;background:#000"><canvas id="c"></canvas><script>
window.__relayUrl = ${JSON.stringify(relayUrl)};
window.__paints = [];
window.__state = null;
window.__switches = [];
const NativeDecoder = window.VideoDecoder;
window.VideoDecoder = class extends NativeDecoder {
  constructor(init) { super({ output: (f) => setTimeout(() => init.output(f), ${holdMs}), error: init.error }); }
};
const drawImage = CanvasRenderingContext2D.prototype.drawImage;
CanvasRenderingContext2D.prototype.drawImage = function (...args) { window.__paints.push(performance.now()); return drawImage.apply(this, args); };
</script><script>${bundle}
const client = new RC.StreamClient(document.getElementById("c"), (s) => { window.__state = s; });
client.start();
window.__client = client;
</script></body></html>`;
}

async function bundleStreamClient(): Promise<string> {
  const result = await esbuild.build({
    entryPoints: [STREAM_CLIENT],
    bundle: true,
    write: false,
    format: "iife",
    globalName: "RC",
    target: "es2022",
    plugins: [{
      name: "remote-api-shim",
      setup(build) {
        build.onResolve({ filter: /remoteApi\.js$/ }, () => ({ path: "remote-api-shim", namespace: "shim" }));
        build.onLoad({ filter: /.*/, namespace: "shim" }, () => ({
          loader: "js",
          contents: "export async function remoteRequest() { return { ticket: 'lab' }; } export function streamUrl() { return window.__relayUrl; }",
        }));
      },
    }],
  });
  return result.outputFiles[0]!.text;
}

/** Orders deliveries like TCP does: a packet never overtakes the one before it. */
class Direction {
  private freeAt = 0;
  private lastArrival = 0;
  constructor(private readonly link: Link, private readonly startedAt: number, private readonly mbps: number | null) {}

  schedule(bytes: number, deliver: () => void): void {
    const now = performance.now();
    let start = this.stallEnd(Math.max(now, this.freeAt));
    const transmitMs = this.mbps ? (bytes * 8) / (this.mbps * 1000) : 0;
    this.freeAt = start + transmitMs;
    const arrival = Math.max(this.lastArrival, this.freeAt + this.link.rttMs / 2 + Math.random() * this.link.jitterMs);
    this.lastArrival = arrival;
    setTimeout(deliver, Math.max(0, arrival - now));
  }

  private stallEnd(at: number): number {
    const stall = this.link.stall;
    if (!stall) return at;
    const phase = (at - this.startedAt) % stall.everyMs;
    return phase < stall.forMs ? at + (stall.forMs - phase) : at;
  }
}

interface RunResult {
  link: string;
  fps: number;
  freezes: number;
  frozenPct: number;
  maxGapMs: number;
  lagP50: number;
  lagP95: number;
  serverDropped: number;
  clientSkips: number;
}

function percentile(values: number[], p: number): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return Math.round(sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))]!);
}

async function runLink(link: Link, bundle: string, sessionPort: number, browser: import("playwright").Browser): Promise<RunResult> {
  const startedAt = performance.now();
  const sentAt = new Map<number, number>();
  const lags: number[] = [];
  let acks = 0;
  const http = createServer();
  const relay = new WebSocketServer({ server: http });
  relay.on("connection", (client) => {
    const upstream = new WebSocket(`ws://127.0.0.1:${sessionPort}/`);
    const down = new Direction(link, startedAt, link.downMbps);
    const up = new Direction(link, startedAt, null);
    const pendingUp: string[] = [];
    upstream.on("open", () => { for (const m of pendingUp.splice(0)) upstream.send(m); });
    upstream.on("message", (data: Buffer, isBinary) => {
      if (isBinary && data.length > 12) sentAt.set(data.readUInt32BE(2), performance.now());
      down.schedule(data.length, () => client.readyState === WebSocket.OPEN && client.send(data, { binary: isBinary }));
    });
    client.on("message", (data: Buffer) => {
      const text = data.toString();
      if (text.startsWith('{"t":"ack"')) {
        const seq = (JSON.parse(text) as { seq: number }).seq;
        acks++;
        const at = sentAt.get(seq);
        if (at !== undefined) lags.push(performance.now() - at);
        sentAt.delete(seq);
      }
      up.schedule(data.length, () => {
        if (upstream.readyState === WebSocket.OPEN) upstream.send(text);
        else pendingUp.push(text);
      });
    });
    client.on("close", () => upstream.close());
    upstream.on("close", () => client.close());
  });
  const port = await listen(http);
  const page = await browser.newPage();
  const html = pageHtml(bundle, link.decoderHoldMs, `ws://127.0.0.1:${port}/`);
  http.on("request", (_req, res) => { res.writeHead(200, { "content-type": "text/html" }); res.end(html); });
  await page.goto(`http://127.0.0.1:${port}/`);
  await page.waitForFunction(() => (window as unknown as { __paints: number[] }).__paints.length > 0, null, { timeout: 30_000 });
  // Measure only the steady state: the first paint follows ffmpeg's start-up, which is not the link.
  const firstPaint = await page.evaluate(() => (window as unknown as { __paints: number[] }).__paints.length);
  lags.length = 0;
  acks = 0;
  const switches = link.switches ?? [];
  for (const [i, id] of switches.entries()) {
    setTimeout(() => void page.evaluate((q) => (window as unknown as { __client: { send(m: unknown): void } }).__client.send({ t: "quality", id: q }) ?? (window as unknown as { __switches: number[] }).__switches.push(performance.now()), id),
      ((i + 1) * seconds * 1000) / (switches.length + 1));
  }
  await new Promise((r) => setTimeout(r, seconds * 1000));
  const measured = await page.evaluate((from) => {
    const w = window as unknown as { __paints: number[]; __switches: number[]; __state: { dropped: number; message: string | null }; __client: { stop(): void } };
    const paints = w.__paints.slice(from - 1);
    const state = w.__state;
    w.__client.stop();
    return { paints, switches: w.__switches, dropped: state?.dropped ?? 0, message: state?.message ?? null };
  }, firstPaint);
  await page.close();
  relay.close();
  http.close();
  const gaps = measured.paints.slice(1).map((t, i) => t - measured.paints[i]!);
  const spanMs = measured.paints.at(-1)! - measured.paints[0]!;
  const frozen = gaps.filter((g) => g >= FREEZE_MS);
  // Each freeze as "<gap> ms", suffixed with how long after a quality switch it began when one preceded it.
  const freezeLog = gaps.flatMap((gap, i) => {
    if (gap < FREEZE_MS) return [];
    const at = measured.paints[i]!;
    const since = measured.switches.filter((t) => t <= at).at(-1);
    return [`${Math.round(gap)}${since === undefined ? "" : `@+${Math.round(at - since)}`}`];
  });
  if (freezeLog.length || measured.message) console.log(`  ${link.name} freezes: ${freezeLog.join(" ") || "none"}${measured.message ? ` · viewer message: ${measured.message}` : ""}`);
  return {
    link: link.name,
    fps: Math.round((gaps.length * 1000) / spanMs),
    freezes: frozen.length,
    frozenPct: Math.round((frozen.reduce((a, b) => a + b, 0) / spanMs) * 1000) / 10,
    maxGapMs: Math.round(Math.max(0, ...gaps)),
    lagP50: percentile(lags, 0.5),
    lagP95: percentile(lags, 0.95),
    serverDropped: measured.dropped,
    clientSkips: Math.max(0, acks - measured.paints.length),
  };
}

function listen(server: Server): Promise<number> {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve((server.address() as { port: number }).port)));
}

async function primaryDisplays(): Promise<DisplayInfo[]> {
  const helper = new DesktopHelper(await ensureHelperBuilt(REMOTE_DIR));
  try {
    return (await helper.layout()).displays;
  } finally {
    helper.stop();
  }
}

const watchOnlyHelper = {
  onBlockedChange: () => () => {},
  move() {}, button() {}, wheel() {}, key() {}, text() {},
  clipboardText: async () => "",
  setClipboardText: async () => {},
};

async function main(): Promise<void> {
  const displays = await primaryDisplays();
  const display = pickDisplay(displays, 0);
  const sessionServer = createServer();
  const sessions = new WebSocketServer({ server: sessionServer });
  sessions.on("connection", (socket) => {
    new RemoteSession(socket, watchOnlyHelper as unknown as DesktopHelper, {
      ffmpegPath: managedFfmpegPath(REMOTE_DIR),
      encoder: "h264_nvenc",
      display: display.index,
      quality,
      displays,
      elevated: false,
      onEnd: () => {},
      onChoice: () => {},
    });
  });
  const sessionPort = await listen(sessionServer);
  const bundle = await bundleStreamClient();
  const browser = await chromium.launch({ executablePath: BRAVE });
  const results: RunResult[] = [];
  try {
    for (const link of LINKS.filter((l) => !only || l.name === only)) {
      const result = await runLink(link, bundle, sessionPort, browser);
      console.log(JSON.stringify(result));
      results.push(result);
    }
  } finally {
    await browser.close();
    sessions.close();
    sessionServer.close();
  }
  console.log(`\n${quality} on display ${display.index} (${display.width}×${display.height}), ${seconds}s per link, freeze = paint gap ≥ ${FREEZE_MS} ms`);
  console.table(results);
}

main().then(() => process.exit(0), (error) => {
  console.error(error);
  process.exit(1);
});
