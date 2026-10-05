// Browser regression for digital camera inspection. Uses the shared throwaway-server harness;
// every module request and camera socket is mocked, so it never contacts cameras or recording.
// Run after building web: node server/scripts/surveillance-viewer-lab.cjs
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { loadChromium, authPassword, boot, killInstance, requireBuild, requireFreshWebBuild } = require("./lab-harness.cjs");
const PORT = 4486;
const BASE = `http://127.0.0.1:${PORT}`;
let checks = 0;
function check(label, value) { assert.ok(value, label); checks++; console.log(`PASS ${label}`); }

(async () => {
  requireBuild();
  requireFreshWebBuild();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "camera-viewer-lab-"));
  let child;
  let browser;
  let frameTimer;
  try {
    killInstance(PORT);
    child = await boot({ dataDir, port: PORT });
    browser = await loadChromium().launch();
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, hasTouch: true });
    const page = await context.newPage();
    const errors = [];
    const writes = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const jpeg = await page.evaluate(() => {
      const canvas = document.createElement("canvas");
      canvas.width = 640; canvas.height = 360;
      const ctx = canvas.getContext("2d");
      ctx.fillStyle = "#48786b"; ctx.fillRect(0, 0, 640, 360);
      ctx.fillStyle = "white"; ctx.fillRect(120, 80, 240, 120);
      return canvas.toDataURL("image/jpeg").split(",")[1];
    });
    const camera = { id: "sample", name: "Sample camera", vendor: "", modelPreset: "", location: "", previewStrategy: "snapshot", snapshotUrl: "", gridSpan: 6, previewHeight: 0, uiCollapsed: false, privacyMode: null };
    const recording = { mode: "off", schedule: { days: [1], start: "09:00", end: "17:00" }, segmentMinutes: 15, retentionDays: 0, maxGbPerCamera: 0 };
    await page.route("**/api/modules/**", async (route) => {
      const request = route.request();
      const pathname = new URL(request.url()).pathname;
      if (request.method() !== "GET" && !pathname.endsWith("/ticket")) writes.push(pathname);
      let json;
      if (pathname.endsWith("/api/config")) json = { origin: "new", ffmpegFound: true, recordingRoot: "", recording, cameras: [camera, { ...camera, id: "waiting", name: "Waiting camera" }] };
      else if (pathname.endsWith("/api/recording")) json = { ...recording, cameras: [], active: false };
      else if (pathname.endsWith("/ticket")) json = { ticket: "synthetic" };
      else if (pathname.endsWith("/service")) json = { module: "surveillance", state: "running", pid: null, stale: false, busy: null, rssBytes: 0 };
      else throw new Error(`Unexpected module request: ${pathname}`);
      await route.fulfill({ json });
    });
    let sockets = 0;
    await page.routeWebSocket("**/api/modules/surveillance/stream**", (socket) => {
      sockets++;
      const send = () => {
        const header = Buffer.from(JSON.stringify({ id: "sample", at: Date.now() }));
        const length = Buffer.alloc(2); length.writeUInt16BE(header.length);
        socket.send(Buffer.concat([length, header, Buffer.from(jpeg, "base64")]));
      };
      send(); frameTimer = setInterval(send, 300);
      socket.onClose(() => clearInterval(frameTimer));
    });
    await page.request.post(`${BASE}/api/login`, { data: { password: authPassword() } });
    await page.goto(BASE);
    await page.waitForSelector(".accounts .acct", { state: "attached" });
    await page.click('[aria-label="Open settings"]');
    await page.click('[data-settings-category="interface"]');
    await page.click('[role="switch"][aria-label="Surveillance tab"]');
    await page.click('[aria-label="Close settings"]');
    await page.click(".board-tab.bt-surveillance");
    await page.waitForFunction(() => document.querySelector(".sv-open-camera img")?.naturalWidth > 0);
    const opener = page.getByRole("button", { name: "Open Sample camera fullscreen", exact: true });
    await opener.click();
    await page.waitForSelector(".sv-viewer");
    await page.waitForFunction(() => document.fullscreenElement?.classList.contains("sv-viewer"));
    check("picture click opens native fullscreen", await page.locator(".sv-viewer").isVisible());
    const geometry = () => page.evaluate(() => {
      const box = document.querySelector(".sv-viewer").getBoundingClientRect();
      return box.x === 0 && box.y === 0 && Math.abs(box.width - innerWidth) < 2 && Math.abs(box.height - innerHeight) < 2;
    });
    check("viewer fills the viewport", await geometry());
    const zoom = () => page.locator('[aria-label="Zoom level"]').textContent();
    const matrix = () => page.locator(".sv-viewer-picture").evaluate((el) => {
      const m = new DOMMatrix(getComputedStyle(el).transform); return { scale: m.a, x: m.e, y: m.f };
    });
    await page.getByRole("button", { name: "Zoom in", exact: true }).click();
    check("zoom button magnifies the picture", await zoom() === "125%" && (await matrix()).scale === 1.25);
    const viewport = page.locator(".sv-viewer-viewport");
    const box = await viewport.boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down(); await page.mouse.move(box.x + box.width / 2 + 80, box.y + box.height / 2 + 35, { steps: 5 }); await page.mouse.up();
    check("drag pans the zoomed picture", (await matrix()).x > 40 && (await matrix()).y > 20);
    await page.mouse.wheel(0, -100);
    await page.waitForFunction(() => Number(document.querySelector('[aria-label="Zoom level"]').textContent.replace("%", "")) > 125);
    check("wheel zooms", (await matrix()).scale > 1.25);
    await page.getByRole("button", { name: "Reset view", exact: true }).click();
    check("reset restores fit and centering", await zoom() === "100%" && (await matrix()).x === 0 && (await matrix()).y === 0);
    await page.keyboard.press("+");
    await page.keyboard.press("ArrowLeft");
    check("keyboard zoom and pan work after a button click", await zoom() === "125%" && (await matrix()).x > 0);
    for (let i = 0; i < 12; i++) await page.keyboard.press("+");
    check("zoom is bounded at 800%", await zoom() === "800%");
    await page.keyboard.press("0");
    check("keyboard reset fits", await zoom() === "100%");
    await page.keyboard.press("Shift+Tab");
    check("tab focus remains in the viewer", await page.evaluate(() => !!document.activeElement.closest(".sv-viewer")));
    const frameAt = await page.locator(".sv-viewer-picture img").getAttribute("src");
    await page.waitForFunction((previous) => document.querySelector(".sv-viewer-picture img").src !== previous, frameAt);
    check("live frames continue on the same socket", sockets === 1);
    await page.getByRole("button", { name: "Close camera view", exact: true }).click();
    await page.waitForSelector(".sv-viewer", { state: "detached" });
    check("close restores opener focus and exits fullscreen", await opener.evaluate((el) => document.activeElement === el) && await page.evaluate(() => !document.fullscreenElement));

    await page.evaluate(() => { HTMLElement.prototype.requestFullscreen = () => Promise.reject(new Error("Fullscreen unavailable in test")); });
    await page.setViewportSize({ width: 390, height: 844 });
    await opener.click();
    await page.waitForSelector(".sv-viewer");
    check("phone fallback still fills the viewport", await geometry());
    const mobileBox = await viewport.boundingBox();
    const cdp = await context.newCDPSession(page);
    const point = (x, y, id) => ({ x, y, id });
    const midX = mobileBox.x + mobileBox.width / 2;
    const midY = mobileBox.y + mobileBox.height / 2;
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [point(midX - 30, midY, 1), point(midX + 30, midY, 2)] });
    await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [point(midX - 70, midY, 1), point(midX + 70, midY, 2)] });
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    check("touch pinch magnifies", (await matrix()).scale > 1.5);
    const oldX = (await matrix()).x;
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [point(midX, midY, 1)] });
    await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [point(midX + 50, midY, 1)] });
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    check("touch drag pans", (await matrix()).x > oldX + 20);
    check("phone controls stay within viewport", await page.locator(".sv-viewer button").evaluateAll((buttons) => buttons.every((button) => { const r = button.getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth && r.bottom <= innerHeight; })));
    await page.keyboard.press("Escape");
    await page.waitForSelector(".sv-viewer", { state: "detached" });
    await page.getByRole("button", { name: "Enlarge Waiting camera", exact: true }).click();
    check("enlarge opens cameras without a frame", await page.locator(".sv-viewer .sv-frame-empty").isVisible());
    check("each new camera starts at fit", await zoom() === "100%");
    await page.getByRole("button", { name: "Close camera view", exact: true }).click();
    check("viewing sends no module mutations", writes.length === 0);
    check("no browser exceptions", errors.length === 0);
    console.log(`${checks}/${checks} camera viewer checks passed`);
  } finally {
    clearInterval(frameTimer);
    if (browser) await browser.close();
    if (child) child.kill();
    killInstance(PORT);
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
