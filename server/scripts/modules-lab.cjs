// Lab for the optional local-service tabs (`npm run modules-lab --prefix server`): Script Hub,
// Surveillance, Home and Sidekick, driven in a real browser against a throwaway instance that imports the
// owner's real Script Hub settings (read-only) the way the live console does on first use.
//
// What the unit gate (`test:modules`) cannot see: that a hidden tab really starts nothing, that the
// Settings switches persist across a reload on desktop AND phone, that each tab renders its migrated data,
// that leaving a tab closes its streams and polling, that a recording the owner starts survives leaving
// the tab and stops only on Stop, that a killed worker is replaced on the next request, and how GGO's own
// HTTP, socket and owner-message latency hold up while the modules work.
//
// Safe by construction: it never starts or stops a Script Hub script, never sends a vacuum command and
// never toggles Sidekick's power. The one write to real hardware is reading camera streams, and the one
// recording it makes goes to the lab's own temp folder and is stopped before the run ends.
//
// Needs an isolated build (the lab refuses to boot without one):
//   from server/: npx tsc -p tsconfig.json --outDir .modules-lab-dist
//   from web/:    npx vite build --outDir ../server/.lab-web-dist-modules --emptyOutDir
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { loadChromium, authPassword, requireBuild, boot, killInstance, createChecks, shotDir } = require("./lab-harness.cjs");
const { login } = require("./inject-thread.cjs");
const { sampleLatency } = require("./module-latency.cjs");

process.env.GGO_LAB_ENTRY ||= ".modules-lab-dist/index.js";
process.env.GGO_LAB_WEB_DIST ||= ".lab-web-dist-modules";

const PORT = 4425;
const BASE = `http://127.0.0.1:${PORT}`;
const MODULES = ["scripthub", "surveillance", "home", "sidekick"];
const LABELS = { scripthub: "Script Hub", surveillance: "Surveillance", home: "Home", sidekick: "Sidekick" };
const check = createChecks();
// The server's mask for a stored secret (worker/surveillance/config.ts SECRET_MASK).
const SECRET_MASK = "********";
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** node.exe workers launched from this lab's build, and ffmpeg children carrying this instance's tag. */
function labProcesses() {
  const marker = path.basename(path.dirname(path.resolve(__dirname, "..", process.env.GGO_LAB_ENTRY)));
  const script = `Get-CimInstance Win32_Process -Filter "Name='node.exe' OR Name='ffmpeg.exe'" | Where-Object { $_.CommandLine -like '*${marker}*worker*' } | ForEach-Object { "$($_.ProcessId) $($_.Name)" }`;
  const out = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { encoding: "utf8", windowsHide: true });
  return out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
}

/** Every password the imported config holds, straight from disk, so the browser check knows what must stay hidden. */
function storedCameraSecrets(file) {
  const secrets = new Set();
  for (const camera of JSON.parse(fs.readFileSync(file, "utf8")).value.cameras) {
    if (camera.password) secrets.add(camera.password);
    for (const field of ["snapshotUrl", "streamUrl", "subStreamUrl", "onvifUrl"]) {
      try {
        const url = new URL(camera[field]);
        if (url.password) secrets.add(decodeURIComponent(url.password));
        for (const [key, value] of url.searchParams) if (/^(password|pwd|pass|token)$/i.test(key) && value) secrets.add(value);
      } catch {
        /* blank or not a URL */
      }
    }
  }
  return [...secrets].filter((secret) => secret !== SECRET_MASK);
}

async function api(cookie, method, route, body) {
  const res = await fetch(`${BASE}${route}`, {
    method,
    headers: { cookie, ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* not json */
  }
  return { status: res.status, json, text };
}

async function services(cookie) {
  return (await api(cookie, "GET", "/api/modules/services")).json ?? [];
}

async function shownTabs(page) {
  return page.$$eval(".board-tabs .board-tab", (els) => els.map((el) => [...el.classList].find((c) => c.startsWith("bt-"))?.slice(3)).filter(Boolean));
}

async function openTab(page, id) {
  await page.click(`.board-tabs .board-tab.bt-${id}`);
}

async function waitHello(page) {
  await page.waitForSelector(".accounts .acct", { state: "attached", timeout: 60_000 });
}

async function soft(label, fn) {
  try {
    return await fn();
  } catch (error) {
    check(label, false, error instanceof Error ? error.message.split("\n")[0] : String(error));
    return null;
  }
}

(async () => {
  requireBuild();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "modules-lab-"));
  const shots = shotDir(dataDir);
  killInstance(PORT);
  const child = await boot({ dataDir, port: PORT });
  const cookie = await login(BASE, authPassword());
  const report = { at: new Date().toISOString() };
  let browser = null;
  try {
    // ---- with every tab hidden, nothing exists: no worker, no folder, no process ----
    report.baseline = await sampleLatency({ base: BASE, cookie, count: 40, ownerMessages: 5 });
    const idle = await services(cookie);
    check("every module service reports stopped on a fresh instance", idle.length === 4 && idle.every((s) => s.state === "stopped"), JSON.stringify(idle.map((s) => s.state)));
    check("no module folder is created while the tabs are hidden", !fs.existsSync(path.join(dataDir, "modules")));
    check("no worker or camera process runs while the tabs are hidden", labProcesses().length === 0, labProcesses().join(", "));

    const chromium = loadChromium();
    browser = await chromium.launch();
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await ctx.newPage();
    const pageErrors = [];
    page.on("pageerror", (e) => pageErrors.push(e.message));
    await page.request.post(`${BASE}/api/login`, { data: { password: authPassword() } });
    await page.goto(`${BASE}/`, { timeout: 60_000 });
    await waitHello(page);
    check("no module tab is shown by default", (await shownTabs(page)).every((v) => !MODULES.includes(v)), JSON.stringify(await shownTabs(page)));

    // ---- Settings: switch all four on; showing a tab starts nothing ----
    await page.click('[aria-label="Open settings"]');
    await page.waitForSelector('[role="dialog"][aria-label="Settings"]');
    await page.click('[data-settings-category="interface"]');
    for (const id of MODULES) {
      const sw = page.locator(`[role="switch"][aria-label="${LABELS[id]} tab"]`);
      check(`Settings lists the ${LABELS[id]} switch, off`, (await sw.getAttribute("aria-checked")) === "false");
      await sw.click();
    }
    await page.screenshot({ path: path.join(shots, "settings-module-tabs.png") });
    await page.click('[aria-label="Close settings"]');
    await page.waitForSelector('[role="dialog"][aria-label="Settings"]', { state: "detached" });
    check("all four tabs join the board header", (await shownTabs(page)).filter((v) => MODULES.includes(v)).length === 4, JSON.stringify(await shownTabs(page)));
    const stored = await page.evaluate(() => localStorage.getItem("director_settings"));
    check("the choice is stored in this browser", MODULES.every((id) => JSON.parse(stored ?? "{}").shownModuleTabs?.includes(id)), stored);
    await delay(5_000);
    check("showing the tabs started no service", (await services(cookie)).every((s) => s.state === "stopped") && labProcesses().length === 0, labProcesses().join(", "));
    await page.reload();
    await waitHello(page);
    check("the tabs survive a reload", (await shownTabs(page)).filter((v) => MODULES.includes(v)).length === 4, JSON.stringify(await shownTabs(page)));

    // ---- Script Hub: the hub's real scripts, filters, a live log that closes with the tab ----
    await soft("Script Hub renders the hub's scripts", async () => {
      const started = Date.now();
      await openTab(page, "scripthub");
      await page.waitForSelector(".sh-card", { timeout: 90_000 });
      report.coldStartMs = { scripthub: Date.now() - started };
      const cards = await page.locator(".sh-card").count();
      check("Script Hub renders the hub's scripts", cards > 0, `${cards} cards, first paint ${report.coldStartMs.scripthub}ms`);
      const headerRunning = await page.waitForSelector(".mod-service-running", { timeout: 5_000 }).then(() => true, () => false);
      check("the header shows the worker running within seconds, not on the next 15 s read", headerRunning, await page.locator(".mod-service-text").first().textContent());
      check("opening the tab started its service", (await services(cookie)).find((s) => s.module === "scripthub")?.state === "running");
      const first = ((await page.locator(".sh-card h4").first().textContent()) ?? "").trim();
      await page.fill('[aria-label="Search scripts"]', first);
      await page.waitForFunction((n) => document.querySelectorAll(".sh-card").length < n || n === 1, cards, { timeout: 10_000 });
      check("the search narrows the list", (await page.locator(".sh-card").count()) <= cards, first);
      await page.fill('[aria-label="Search scripts"]', "");
      await page.screenshot({ path: path.join(shots, "scripthub.png") });
      const logUrl = { url: null, closed: false };
      page.on("request", (req) => {
        if (/\/api\/modules\/scripthub\/api\/scripts\/.+\/logs/.test(req.url())) logUrl.url = req.url();
      });
      const closedLog = (req) => {
        if (req.url() === logUrl.url) logUrl.closed = true;
      };
      page.on("requestfailed", closedLog);
      page.on("requestfinished", closedLog);
      await page.locator(".sh-card .sh-actions button:has-text('Logs')").first().click();
      await page.waitForSelector(".sh-log", { timeout: 15_000 });
      await page.waitForFunction(() => !/Connecting…/.test(document.querySelector(".sh-log pre")?.textContent ?? "Connecting…") || document.querySelector(".sh-log-error"), null, { timeout: 20_000 }).catch(() => undefined);
      check("a script's log streams into the panel", logUrl.url !== null, logUrl.url ?? "no log request");
      await openTab(page, "tasks");
      await delay(3_000);
      check("leaving the tab closes the log stream", logUrl.closed, logUrl.url);
    });

    await soft("no module traffic while on Tasks", async () => {
      const seen = [];
      const watch = (req) => {
        if (req.url().includes("/api/modules/")) seen.push(req.url());
      };
      page.on("request", watch);
      await delay(15_000);
      page.off("request", watch);
      check("on another tab the module stops polling", seen.length === 0, seen.slice(0, 3).join(", "));
    });

    // ---- Surveillance: live frames over a ticketed socket, explicit recording ----
    const recordDir = path.join(dataDir, "recordings");
    fs.mkdirSync(recordDir);
    const cfg = await api(cookie, "GET", "/api/modules/surveillance/api/config");
    const cameras = cfg.json?.cameras ?? [];
    report.cameras = cameras.length;
    check("the Deck's cameras were imported", cameras.length > 0, `${cameras.length} cameras`);
    const secrets = storedCameraSecrets(path.join(dataDir, "modules", "surveillance", "config.json"));
    const leaks = secrets.filter((secret) => cfg.text.includes(secret));
    check("imported camera passwords never reach the browser", secrets.length > 0 && leaks.length === 0, `${leaks.length} of ${secrets.length} stored secret(s) visible`);
    check("an imported setup starts with recording stopped", (await api(cookie, "GET", "/api/modules/surveillance/api/recording")).json?.active === false);
    await api(cookie, "PUT", "/api/modules/surveillance/api/config", { ...cfg.json, recordingRoot: recordDir });

    const sockets = [];
    page.on("websocket", (ws) => {
      if (!ws.url().includes("/api/modules/surveillance/stream")) return;
      const entry = { url: ws.url(), frames: 0, closed: false };
      ws.on("framereceived", () => entry.frames++);
      ws.on("close", () => (entry.closed = true));
      sockets.push(entry);
    });
    await soft("Surveillance shows live pictures", async () => {
      await openTab(page, "surveillance");
      await page.waitForSelector(".sv-grid", { timeout: 60_000 });
      await page.waitForSelector(".sv-grid img", { timeout: 60_000 });
      const tiles = await page.locator(".sv-grid > *").count();
      const live = await page.locator(".sv-grid img").count();
      check("Surveillance shows live pictures", live > 0, `${live} of ${tiles} tiles showing a picture`);
      await delay(6_000);
      report.framesIn6s = sockets.at(-1)?.frames ?? 0;
      check("frames arrive over the module socket", (sockets.at(-1)?.frames ?? 0) > 0, `${report.framesIn6s} frames in 6s`);
      await page.screenshot({ path: path.join(shots, "surveillance.png") });
    });

    await soft("recording starts on Start and keeps going off the tab", async () => {
      await page.click(".sv-bar button:has-text('Start recording')");
      await page.waitForSelector(".sv-rec.on", { timeout: 60_000 });
      await page.screenshot({ path: path.join(shots, "surveillance-recording.png") });
      // Representative load: frames streaming to this page, every camera recording, and the other three
      // modules answering requests in parallel.
      const background = [];
      let loading = true;
      const hammer = async (route) => {
        while (loading) {
          await api(cookie, "GET", route).catch(() => undefined);
          await delay(1_000);
        }
      };
      background.push(hammer("/api/modules/scripthub/api/status"), hammer("/api/modules/home/api/config"), hammer("/api/modules/sidekick/api/state"));
      report.underLoad = await sampleLatency({ base: BASE, cookie, count: 40, ownerMessages: 5 });
      loading = false;
      await Promise.all(background);
      report.workers = (await services(cookie)).map((s) => ({ id: s.module, state: s.state, rssMB: s.rssBytes ? Math.round(s.rssBytes / 1048576) : null, busy: s.busy ?? null }));
      report.processes = labProcesses();

      await openTab(page, "tasks");
      await delay(3_000);
      check("leaving Surveillance closes its frame socket", sockets.every((s) => s.closed), JSON.stringify(sockets.map((s) => s.closed)));
      await delay(10_000);
      const rec = (await api(cookie, "GET", "/api/modules/surveillance/api/recording")).json;
      check("the recording keeps going after the owner leaves the tab", rec?.active === true, JSON.stringify(rec?.cameras?.map((c) => c.state)));
      check("...and it is remembered across a GGO restart", fs.existsSync(path.join(dataDir, "modules", "surveillance", "armed.json")));
      const files = fs.readdirSync(recordDir, { recursive: true }).filter((f) => /\.(mp4|mkv|ts)$/i.test(String(f)));
      check("...writing files into the chosen folder", files.length > 0, `${files.length} file(s)`);

      await openTab(page, "surveillance");
      await page.waitForSelector(".sv-rec.on", { timeout: 30_000 });
      page.once("dialog", (dialog) => void dialog.accept());
      await page.click(".sv-bar button:has-text('Stop recording')");
      await page.waitForSelector(".sv-rec:not(.on)", { timeout: 60_000 });
      const after = (await api(cookie, "GET", "/api/modules/surveillance/api/recording")).json;
      check("Stop ends the recording", after?.active === false);
      check("...and forgets it", !fs.existsSync(path.join(dataDir, "modules", "surveillance", "armed.json")));
    });

    // ---- Home: the migrated device, and an upstream that is down ----
    await soft("Home renders the migrated devices", async () => {
      await openTab(page, "home");
      await page.waitForSelector(".home-card, .mod-empty", { timeout: 60_000 });
      const cards = await page.locator(".home-card").count();
      check("Home renders the migrated devices", cards > 0, `${cards} device(s)`);
      await page.waitForFunction(() => !document.querySelector(".mod-loading"), null, { timeout: 30_000 }).catch(() => undefined);
      const notices = await page.$$eval(".mod-notice strong", (els) => els.map((e) => e.textContent));
      report.homeNotices = notices;
      const ha = (await api(cookie, "GET", "/api/modules/home/api/home-assistant")).json;
      report.homeAssistant = ha;
      check("Home Assistant's state is reported, not hung", ha !== null, JSON.stringify(ha)?.slice(0, 200));
      if (ha && !ha.reachable) {
        check("a Home Assistant outage is reported once, not once per device", notices.filter((n) => /not answering/.test(n ?? "")).length === 1, JSON.stringify(notices));
        check("...and its devices' controls are disabled meanwhile", await page.locator(".home-actions button:has-text('Start')").first().isDisabled());
      }
      await page.screenshot({ path: path.join(shots, "home.png") });
    });

    // ---- Sidekick: the tray app's own rules, an editor that writes nothing on cancel ----
    await soft("Sidekick renders its rules", async () => {
      await openTab(page, "sidekick");
      await page.waitForSelector(".sk-bar", { timeout: 60_000 });
      await page.waitForSelector(".sk-rule, .mod-empty, .mod-notice", { timeout: 30_000 });
      const rules = await page.locator(".sk-rule").count();
      const state = (await api(cookie, "GET", "/api/modules/sidekick/api/state")).json;
      check("Sidekick renders the tray app's rules", rules === (state?.rules?.length ?? -1), `${rules} rules on screen, ${state?.rules?.length} in its settings`);
      if (rules > 0) {
        const before = state.revision;
        await page.locator(".sk-rule .mod-icon-btn[aria-label^='Edit']").first().click();
        await page.waitForSelector('[role="dialog"].mod-dialog');
        await page.screenshot({ path: path.join(shots, "sidekick-editor.png") });
        await page.keyboard.press("Escape");
        await page.waitForSelector('[role="dialog"].mod-dialog', { state: "detached" });
        const again = (await api(cookie, "GET", "/api/modules/sidekick/api/state")).json;
        check("cancelling the editor writes nothing", again?.revision === before);
      }
      await page.screenshot({ path: path.join(shots, "sidekick.png") });
    });

    // ---- recovery: a worker that dies is replaced on the next request; GGO stays responsive ----
    await soft("a killed worker is replaced", async () => {
      const victim = (await services(cookie)).find((s) => s.module === "scripthub");
      execFileSync("taskkill", ["/F", "/PID", String(victim.pid)], { windowsHide: true });
      const t = Date.now();
      const me = await fetch(`${BASE}/api/me`, { headers: { cookie } });
      check("GGO answers at once while a worker is dead", me.ok && Date.now() - t < 1_000, `${Date.now() - t}ms`);
      await openTab(page, "scripthub");
      await page.waitForSelector(".sh-card", { timeout: 90_000 });
      const next = (await services(cookie)).find((s) => s.module === "scripthub");
      check("the next request starts a fresh worker", next.state === "running" && next.pid !== victim.pid, `${victim.pid} -> ${next.pid}`);
      await openTab(page, "tasks");
    });

    // ---- the phone: the area menu offers the shown tabs, and a module renders at phone width ----
    await soft("phone layout", async () => {
      await ctx.close();
      const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
      await phone.addInitScript((value) => localStorage.setItem("director_settings", value), stored);
      const p = await phone.newPage();
      await p.request.post(`${BASE}/api/login`, { data: { password: authPassword() } });
      await p.goto(`${BASE}/`, { timeout: 60_000 });
      await waitHello(p);
      const options = await p.$$eval('select[aria-label="All areas"] option', (els) => els.map((e) => e.value));
      check("the phone's area menu lists the shown tabs", MODULES.every((id) => options.includes(id)), JSON.stringify(options));
      await p.selectOption('select[aria-label="All areas"]', "sidekick");
      await p.waitForSelector(".sk-bar", { timeout: 60_000 });
      const overflow = await p.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      check("a module fits the phone's width", overflow <= 1, `${overflow}px overflow`);
      await p.screenshot({ path: path.join(shots, "phone-sidekick.png"), fullPage: false });
      await p.selectOption('select[aria-label="All areas"]', "surveillance");
      await p.waitForSelector(".sv-grid, .sv-bar", { timeout: 60_000 });
      await p.screenshot({ path: path.join(shots, "phone-surveillance.png"), fullPage: false });
      await phone.close();
    });

    check("no page errors", pageErrors.length === 0, pageErrors.slice(0, 3).join(" | "));

    // ---- Stop ends every worker; nothing is left behind ----
    for (const id of MODULES) await api(cookie, "POST", `/api/modules/${id}/service/stop`, { force: true });
    await delay(2_000);
    check("Stop leaves no worker or camera process behind", labProcesses().length === 0, labProcesses().join(", "));
  } finally {
    if (browser) await browser.close();
    for (const id of MODULES) await api(cookie, "POST", `/api/modules/${id}/service/stop`, { force: true }).catch(() => undefined);
    const reportFile = path.join(shots, "modules-lab-report.json");
    fs.writeFileSync(reportFile, JSON.stringify(report, null, 2));
    console.log(`\nreport: ${reportFile}`);
    console.log(JSON.stringify({ baseline: report.baseline, underLoad: report.underLoad, workers: report.workers }, null, 2));
    child.kill();
    killInstance(PORT);
    const failed = check.summary();
    if (!process.argv.includes("--keep")) fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5 });
    process.exit(failed ? 1 : 0);
  }
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
