// Drives the console's Remote control tab in a real browser against a THROWAWAY instance: sets remote
// control up through the same API Settings uses, opens the tab, and checks the viewer streams. Then it
// throttles the page's network below Data saver's bitrate and checks the PC steps the bitrate down and
// the toolbar says so. The throwaway has its own viewer slot, so an owner connected to the live console
// is never kicked. The canvas is never clicked: it drives this PC's real mouse.
//
//   npm run remote-viewer-lab --prefix server
//
// Uncommitted server work: `npx tsc -p tsconfig.json --outDir .remote-lab-dist` and
// GGO_LAB_ENTRY=.remote-lab-dist/index.js; uncommitted web work: `npm run build:lab --prefix web` and
// GGO_LAB_WEB_DIST=.lab-web-dist (both from server/). The stream smoothness itself is `remote-stream-lab`.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { SERVER_ROOT, loadChromium, authPassword, requireBuild, boot, killInstance, createChecks } = require("./lab-harness.cjs");

const PORT = 4353;
const BASE = `http://127.0.0.1:${PORT}`;
// WebCodecs H.264 in headless needs a browser that ships the codec; Playwright's Chromium does not.
const BRAVE = "C:/Program Files/BraveSoftware/Brave-Browser/Application/brave.exe";
const MANAGED_FFMPEG = path.join(SERVER_ROOT, "data", "remote-control", "ffmpeg-8.0.1", "ffmpeg.exe");
// Below Data saver's 4 Mb/s, so only a lower bitrate plays it.
const THROTTLED_BYTES_PER_SEC = (2.6 * 1_000_000) / 8;

async function setUpRemoteControl(request) {
  const put = (data) => request.put(`${BASE}/api/remote-control/config`, { data });
  await put({ customFfmpegPath: MANAGED_FFMPEG });
  const check = await (await request.post(`${BASE}/api/remote-control/check`, { timeout: 180_000 })).json();
  if (!check.recommended) throw new Error(`the check found no working encoder: ${JSON.stringify(check.ffmpeg)}`);
  const saved = await put({ enabled: true, ffmpegPath: check.recommended.ffmpegPath, encoder: check.recommended.encoder, quality: "saver" });
  if (!saved.ok()) throw new Error(`enabling failed: ${await saved.text()}`);
  return check.recommended;
}

async function metricsText(page) {
  return (await page.locator(".rc-metrics").textContent({ timeout: 5_000 }).catch(() => "")) ?? "";
}

async function main() {
  const check = createChecks();
  requireBuild();
  killInstance(PORT);
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "remote-viewer-lab-"));
  const instance = await boot({ dataDir, port: PORT });
  const browser = await loadChromium().launch({ executablePath: BRAVE });
  try {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(String(error)));
    await page.request.post(`${BASE}/api/login`, { data: { password: authPassword() } });
    const recommended = await setUpRemoteControl(page.request);
    check("setup picks a working encoder", !!recommended.encoder, JSON.stringify(recommended));

    await page.goto(`${BASE}/`);
    await page.locator(".board-tab.bt-remote").click({ timeout: 60_000 });
    await page.waitForSelector(".rc-status-streaming", { timeout: 60_000 });
    await page.waitForFunction(() => /\d+ ms · \d+ fps/.test(document.querySelector(".rc-metrics")?.textContent ?? ""), null, { timeout: 15_000 });
    const full = await metricsText(page);
    check("the viewer streams and shows round trip and frame rate", /\d+ ms · \d+ fps/.test(full), full);
    check("at the full rate no lowered-bitrate note shows", (await page.locator(".rc-rate-reduced").count()) === 0, full);
    const canvas = await page.evaluate(() => { const c = document.querySelector(".rc-viewer canvas"); return c ? [c.width, c.height] : null; });
    check("the canvas takes Data saver's 1280×720", canvas?.[0] === 1280 && canvas?.[1] === 720, JSON.stringify(canvas));

    const cdp = await context.newCDPSession(page);
    await cdp.send("Network.enable");
    await cdp.send("Network.emulateNetworkConditions", { offline: false, latency: 40, downloadThroughput: THROTTLED_BYTES_PER_SEC, uploadThroughput: THROTTLED_BYTES_PER_SEC });
    const lowered = await page.waitForSelector(".rc-rate-reduced", { timeout: 90_000 }).then(() => true, () => false);
    const reduced = await metricsText(page);
    check("on a link below the bitrate the PC lowers it and the toolbar says so", lowered && /\d\.\d Mb\/s/.test(reduced), reduced);
    check("the stream is still playing after the handover", await page.locator(".rc-status-streaming").count() === 1 && /\b[1-9]\d* fps/.test(reduced), reduced);
    await page.screenshot({ path: path.join(os.tmpdir(), "remote-viewer-lab.png") });

    check("no page errors", errors.length === 0, errors.join(" | "));
  } finally {
    await browser.close();
    instance.kill();
    killInstance(PORT);
  }
  process.exit(check.summary());
}

main().catch((error) => {
  console.error(error);
  killInstance(PORT);
  process.exit(1);
});
