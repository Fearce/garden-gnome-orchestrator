// Lab for the desktop app (`npm run lab --prefix desktop`). Drives the REAL Electron app (Playwright's
// `_electron`) against a throwaway GGO the app itself starts from this checkout, plus a headless browser
// beside it, through what the unit tests cannot show: a port held by another program, "Start GGO",
// password sign-in, the console's bridge and isolation, task navigation, an owner instruction delivered
// from the window and live updates arriving from a browser, a deliverable download, "Open in web" and
// "Open in desktop" (one-time tickets, a second instance, a fresh profile), external links, a server
// restart, a lost connection, a crashed renderer, and closing the window while the server keeps running.
//
//   npm run lab --prefix desktop
//   npm run lab --prefix desktop -- --shots ../server/data/desktop-lab-shots   (keep the screenshots)
//   npm run lab --prefix desktop -- --keep                                      (keep the temp dirs)
//
// It never touches the owner's GGO: the instance runs on its own port and data directory with bogus
// account tokens (server/scripts/lab-harness.cjs), each app run gets its own profile
// (GGO_DESKTOP_USER_DATA, which also skips the ggo:// registration), and shell.openExternal and
// notifications are stubbed so nothing opens the real browser or toasts the desktop.
const { spawn, execFileSync } = require("node:child_process");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const Database = require("../../server/node_modules/better-sqlite3");
const harness = require("../../server/scripts/lab-harness.cjs");
const { loadPlaywright } = require("./loadPlaywright.cjs");
const { electronBinary } = require("./electronBinary.cjs");

const PORT = 4397;
const BASE = `http://127.0.0.1:${PORT}`;
const DESKTOP = path.resolve(__dirname, "..");
const ELECTRON = electronBinary();
const TASK = "61111111-1111-4111-8111-111111111111";
const OTHER = "62222222-2222-4222-8222-222222222222";
const TASK_TITLE = "DESKTOP LAB TASK";
const OTHER_TITLE = "SECOND LAB TASK";
const DELIVERABLE = "Lab Report";
const DELIVERABLE_TEXT = "# Desktop lab report\n\nDownloaded through the desktop window.\n";
const keep = process.argv.includes("--keep");
const check = harness.createChecks();
const timings = {};
const metrics = {};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const verbose = process.argv.includes("--verbose");
const step = (n) => console.log(`[step ${n}]`);

/** Everything the app (and so the server it starts) inherits: the lab instance's env from the harness. */
function appEnv(dataDir, profile) {
  // Background mode: the windows open on a secondary monitor without taking focus.
  return { ...harness.labChildEnv({ dataDir, port: PORT }), GGO_DESKTOP_USER_DATA: profile, GGO_DESKTOP_BACKGROUND: "1", ELECTRON_ENABLE_LOGGING: "0" };
}

function seedProfile(profile) {
  fs.mkdirSync(profile, { recursive: true });
  fs.writeFileSync(path.join(profile, "desktop-settings.json"), JSON.stringify({ serverUrl: `${BASE}/`, checkoutDir: null, bounds: null }));
}

async function launchApp(playwright, dataDir, profile, extraArgs = []) {
  const started = Date.now();
  const app = await playwright._electron.launch({ executablePath: ELECTRON, args: [DESKTOP, ...extraArgs], cwd: DESKTOP, env: appEnv(dataDir, profile), timeout: 60_000 });
  // Nothing in a lab may reach the real browser or the notification centre.
  await app.evaluate(({ shell, Notification }) => {
    globalThis.__opened = [];
    shell.openExternal = async (url) => {
      globalThis.__opened.push(url);
    };
    Notification.isSupported = () => false;
  });
  const child = app.process();
  child.on("exit", (exitCode, signal) => verbose && console.log(`[app ${child.pid} exited ${exitCode ?? signal}]`));
  if (verbose) for (const stream of [child.stdout, child.stderr]) stream?.on("data", (d) => process.stdout.write(`[app] ${d}`));
  const page = await app.firstWindow();
  return { app, page, started };
}

const opened = (app) => app.evaluate(() => globalThis.__opened.slice());

async function connectTitle(page, text, timeout = 30_000) {
  try {
    await page.waitForFunction((t) => location.protocol === "ggo-app:" && document.getElementById("title")?.textContent === t, text, { timeout });
    return true;
  } catch {
    return false;
  }
}

async function connectState(page) {
  return page.evaluate(() =>
    location.protocol === "ggo-app:"
      ? { title: document.getElementById("title")?.textContent, detail: document.getElementById("detail")?.textContent, buttons: [...document.querySelectorAll("#actions button")].map((b) => b.textContent) }
      : { url: location.href },
  );
}

async function waitForConsole(page, timeout = 60_000) {
  await page.waitForFunction(() => location.protocol.startsWith("http") && !!document.querySelector(".accounts .acct"), null, { timeout });
}

async function openTask(page, title) {
  await page.locator(`.card:has-text("${title}")`).click({ position: { x: 14, y: 10 } });
  await page.waitForFunction((t) => document.querySelector(".detail-head")?.textContent?.includes(t), title, { timeout: 20_000 });
}

async function inject(page, text) {
  await page.fill(".inject-bar textarea", text);
  await page.click('.inject-bar .row button:text-is("Inject")');
}

const feedHas = (page, text, timeout = 20_000) =>
  page
    .waitForFunction((t) => [...document.querySelectorAll(".fi")].some((n) => n.textContent?.includes(t)), text, { timeout })
    .then(() => true)
    .catch(() => false);

function seed(dataDir) {
  const workspace = path.join(dataDir, "workspace");
  fs.mkdirSync(workspace, { recursive: true });
  const report = path.join(workspace, "report.md");
  fs.writeFileSync(report, DELIVERABLE_TEXT);
  const db = new Database(path.join(dataDir, "orchestrator.sqlite"));
  const now = Date.now();
  const thread = db.prepare("INSERT INTO threads (id, title, raw_prompt, brief, workspace, state, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)");
  // At the approval gate nothing runs, so an instruction is stored without starting an agent.
  thread.run(TASK, TASK_TITLE, "p", "b", workspace, "awaiting_approval", now, now);
  thread.run(OTHER, OTHER_TITLE, "p", "b", workspace, "awaiting_approval", now - 1000, now - 1000);
  db.prepare(
    "INSERT INTO findings (id, thread_id, from_run_id, from_role, kind, summary, detail, path, label, severity, routed, created_at) VALUES (?, ?, NULL, 'implementor', 'deliverable', ?, ?, ?, ?, 'info', 0, ?)",
  ).run("desktop-lab-report", TASK, DELIVERABLE, "A report seeded for the desktop lab.", report, DELIVERABLE, now);
  db.close();
  return report;
}

function storedCount(dataDir, text) {
  const db = new Database(path.join(dataDir, "orchestrator.sqlite"), { readonly: true });
  const n = db.prepare("SELECT COUNT(*) AS n FROM messages WHERE content LIKE ?").get(`%${text}%`).n;
  db.close();
  return n;
}

/** The listener on PORT and the supervisor above it, read by PowerShell (Node has no process tree).
 *  The supervisor runs tsx, which runs the server, so the supervisor is two levels up, not one. */
function serverProcesses() {
  const script = `$l = Get-NetTCPConnection -LocalPort ${PORT} -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
if ($l) { $chain = @(); $id = $l.OwningProcess; for ($i = 0; $i -lt 4 -and $id; $i++) { $p = Get-CimInstance Win32_Process -Filter "ProcessId=$id"; if (-not $p) { break }; $chain += "$($p.ProcessId)~$($p.CommandLine -replace '[|~]', ' ')"; $id = $p.ParentProcessId }; $chain -join '|' }`;
  const out = execFileSync("powershell", ["-NoProfile", "-Command", script], { windowsHide: true }).toString().trim();
  if (!out) return null;
  const chain = out.split("|").map((entry) => {
    const [pid, command] = entry.split("~");
    return { pid: Number(pid), command: command ?? "" };
  });
  const at = chain.findIndex((p) => /supervise\.cjs/.test(p.command));
  return { server: chain[0].pid, supervisor: at > 0 ? chain[at].pid : null, between: at > 0 ? chain.slice(1, at).map((p) => p.pid) : [] };
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Stop the app-started server for good: its supervisor first, or it would start the server again. */
function stopServer() {
  const procs = serverProcesses();
  for (const pid of [procs?.supervisor, ...(procs?.between ?? []), procs?.server]) {
    if (!pid) continue;
    try {
      process.kill(pid);
    } catch {
      /* already gone */
    }
  }
  harness.killInstance(PORT);
}

async function answers() {
  try {
    return (await fetch(`${BASE}/api/me`)).ok;
  } catch {
    return false;
  }
}

async function waitFor(predicate, timeout, step = 500) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await sleep(step);
  }
  return false;
}

async function appMemoryMb(app) {
  const all = await app.evaluate(({ app: electronApp }) => electronApp.getAppMetrics().map((m) => ({ type: m.type, kb: m.memory.workingSetSize, privateKb: m.memory.privateBytes ?? 0 })));
  const sum = (key) => Math.round(all.reduce((total, m) => total + m[key], 0) / 1024);
  return { processes: all.length, workingSetMb: sum("kb"), privateMb: sum("privateKb"), byType: all.map((m) => `${m.type}:${Math.round(m.kb / 1024)}MB`).join(" ") };
}

/**
 * The window as the user sees it, OS title-bar buttons included (a page screenshot leaves them out).
 * Drawn by the window itself (PrintWindow), never copied off the screen: a background-mode window sits
 * behind the owner's own windows, and a screen copy would capture those instead.
 */
async function captureWindow(app, file) {
  const { hwnd, minimized } = await app.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0];
    return { hwnd: win.getNativeWindowHandle().readBigInt64LE(0).toString(), minimized: win.isMinimized() };
  });
  // Minimized (the owner put it away): it paints nothing, and restoring it would put it back in their way.
  if (minimized) return console.log(`  (no ${path.basename(file)}: the window is minimized)`);
  const script = path.join(os.tmpdir(), `desktop-lab-capture-${process.pid}.ps1`);
  fs.writeFileSync(
    script,
    [
      "Add-Type -AssemblyName System.Drawing",
      "Add-Type -TypeDefinition @'",
      "using System; using System.Runtime.InteropServices;",
      "public class LabWin {",
      "  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }",
      '  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();',
      '  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);',
      '  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr hdc, uint flags);',
      "}",
      "'@",
      "[LabWin]::SetProcessDPIAware() | Out-Null",
      `$h = [IntPtr]::new([long]${hwnd})`,
      "$r = New-Object LabWin+RECT",
      "if (-not [LabWin]::GetWindowRect($h, [ref]$r)) { exit 1 }",
      "$bmp = New-Object System.Drawing.Bitmap ($r.Right - $r.Left), ($r.Bottom - $r.Top)",
      "$g = [System.Drawing.Graphics]::FromImage($bmp)",
      "$hdc = $g.GetHdc()",
      // 2 = PW_RENDERFULLCONTENT: needed for Chromium's composited content.
      "$ok = [LabWin]::PrintWindow($h, $hdc, 2)",
      "$g.ReleaseHdc($hdc)",
      "if (-not $ok) { exit 1 }",
      `$bmp.Save('${file.replace(/'/g, "''")}', [System.Drawing.Imaging.ImageFormat]::Png)`,
    ].join("\n"),
  );
  try {
    execFileSync("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script], { windowsHide: true });
  } catch {
    /* a capture is evidence, not a check */
  }
  fs.rmSync(script, { force: true });
}

/** Quit an app run, killing it if it doesn't exit in time, so a stuck quit fails a check instead of
 *  hanging the lab. True when it quit on its own. */
async function closeApp(app) {
  const pid = await app.evaluate(() => process.pid).catch(() => app.process().pid);
  const quit = await Promise.race([app.close().then(() => true, () => false), sleep(20_000).then(() => false)]);
  if (!quit && pid && alive(pid)) {
    try {
      execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
    } catch {
      /* gone meanwhile */
    }
  }
  return quit;
}

const redeemLink = (ticket) => `${BASE}/api/desktop/redeem?ticket=${ticket}`;

/** Something that is not GGO, holding the port: what a port conflict looks like to the app. */
function squat() {
  const server = http.createServer((_req, res) => res.writeHead(404, { "content-type": "text/html" }).end("<h1>not ggo</h1>"));
  return new Promise((done) => server.listen(PORT, "127.0.0.1", () => done(server)));
}

(async () => {
  if (!fs.existsSync(path.join(DESKTOP, "dist", "main.js"))) {
    console.error("missing desktop/dist — run `npm run build --prefix desktop`.");
    process.exit(2);
  }
  const webDist = harness.labWebDist();
  if (!fs.existsSync(path.join(webDist, "index.html"))) {
    console.error(`missing ${webDist} — build the web bundle for the lab first (see the header of server/scripts/lab-harness.cjs).`);
    process.exit(2);
  }
  harness.requireFreshWebBuild();
  if (await answers()) {
    console.error(`something already answers on ${BASE}; stop it first (this lab starts its own server there).`);
    process.exit(2);
  }

  const playwright = loadPlaywright();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "desktop-lab-"));
  const profileA = path.join(dataDir, "profile-a");
  const profileB = path.join(dataDir, "profile-b");
  const downloads = path.join(dataDir, "downloads");
  const shots = harness.shotDir(dataDir);
  seedProfile(profileA);
  seedProfile(profileB);
  let code = 1;
  const apps = [];
  let browser = null;
  try {
    // ---- 1. a port held by another program: no Start, a plain explanation ----
    step("1");
    const squatter = await squat();
    let run = await launchApp(playwright, dataDir, profileA);
    apps.push(run.app);
    let { app, page } = run;
    const firstPaint = await connectTitle(page, "GGO isn't running", 30_000);
    timings.launchToConnectScreenMs = Date.now() - run.started;
    let state = await connectState(page);
    check("a port held by another program reads as a conflict", firstPaint && /Something other than GGO/.test(state.detail ?? ""), JSON.stringify(state));
    check("…and offers no Start GGO", !state.buttons?.includes("Start GGO"), JSON.stringify(state.buttons));
    check("the connection page gets only its own bridge", await page.evaluate(() => typeof window.ggoConnect === "object" && typeof window.ggoDesktop === "undefined" && typeof window.require === "undefined" && typeof process === "undefined"));
    await page.screenshot({ path: path.join(shots, "01-conflict.png") });
    await new Promise((done) => squatter.close(done));

    // ---- 2. nothing running: Start GGO launches this checkout's server, detached ----
    step("2");
    await page.click('#actions button:text-is("Try again")');
    const offline = await connectTitle(page, "GGO isn't running", 20_000);
    state = await connectState(page);
    check("with the port free the app offers Start GGO", offline && !!state.buttons?.includes("Start GGO"), JSON.stringify(state));

    // An installed copy learns its checkout through the folder picker. A different configured port
    // must replace Start GGO immediately, without waiting for a later retry to refresh the view.
    const otherCheckout = path.join(dataDir, "other-checkout");
    fs.mkdirSync(path.join(otherCheckout, "server", "scripts"), { recursive: true });
    fs.mkdirSync(path.join(otherCheckout, "web"), { recursive: true });
    fs.writeFileSync(path.join(otherCheckout, "server", "scripts", "supervise.cjs"), "");
    fs.writeFileSync(path.join(otherCheckout, "server", "package.json"), "{}");
    fs.writeFileSync(path.join(otherCheckout, "web", "package.json"), "{}");
    fs.writeFileSync(path.join(otherCheckout, "server", ".env"), "PORT=4498\n");
    await app.evaluate(({ dialog }, picked) => {
      globalThis.__originalPicker = dialog.showOpenDialog;
      globalThis.__originalPort = process.env.PORT;
      delete process.env.PORT;
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [picked] });
    }, otherCheckout);
    await page.evaluate(() => window.ggoConnect.chooseCheckout());
    const chosen = await page.evaluate(() => window.ggoConnect.state());
    check("choosing a checkout refreshes its configured port immediately", chosen.checkoutPort === 4498 && chosen.checkout === otherCheckout, JSON.stringify(chosen));
    check("a chosen checkout on another port offers Use port instead of Start GGO", (await connectState(page)).buttons?.includes("Use port 4498") && !(await connectState(page)).buttons?.includes("Start GGO"));
    await app.evaluate(({ dialog }, picked) => {
      process.env.PORT = globalThis.__originalPort;
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [picked] });
    }, path.resolve(DESKTOP, ".."));
    await page.evaluate(() => window.ggoConnect.chooseCheckout());
    await app.evaluate(({ dialog }) => { dialog.showOpenDialog = globalThis.__originalPicker; });
    check("choosing the matching checkout restores Start GGO immediately", (await connectState(page)).buttons?.includes("Start GGO"));
    await page.screenshot({ path: path.join(shots, "02-offline.png") });
    const startClicked = Date.now();
    await page.click('#actions button:text-is("Start GGO")');
    const starting = await connectTitle(page, "Starting GGO", 15_000);
    check("Start GGO shows the starting screen", starting, JSON.stringify(await connectState(page)));
    await page.screenshot({ path: path.join(shots, "03-starting.png") });
    await page.waitForFunction(() => location.protocol.startsWith("http") && !!document.querySelector('input[type="password"]'), null, { timeout: 200_000 });
    timings.startGgoToSignInMs = Date.now() - startClicked;
    const procs = serverProcesses();
    check("the server runs under the supervisor, not the app", !!procs?.supervisor, JSON.stringify(procs));

    // ---- 3. password sign-in and the console's own bridge ----
    step("3");
    await page.screenshot({ path: path.join(shots, "04-sign-in.png") });
    const signInChrome = await page.evaluate(() => {
      const scrim = document.querySelector(".scrim");
      const strip = scrim && getComputedStyle(scrim, "::before");
      const region = (style) => style?.getPropertyValue("-webkit-app-region") || style?.getPropertyValue("app-region");
      return { strip: region(strip), height: strip?.height, modal: region(getComputedStyle(document.querySelector(".modal.login"))) };
    });
    check("the sign-in screen has a title strip that moves the window", signInChrome.strip === "drag" && parseFloat(signInChrome.height) >= 28 && signInChrome.modal === "no-drag", JSON.stringify(signInChrome));
    // Seeded before the first signed-in connection, as the other labs do: a task written into the
    // database under an already-connected console does not reach its board.
    seed(dataDir);
    await page.fill('input[type="password"]', harness.authPassword());
    await page.click('button:text-is("Enter")');
    await waitForConsole(page);
    const bridge = await page.evaluate(() => ({
      shell: document.documentElement.dataset.shell,
      desktop: Object.keys(window.ggoDesktop ?? {}).sort(),
      links: window.ggoDesktop?.linksRegistered,
      version: window.ggoDesktop?.version,
      connect: typeof window.ggoConnect,
      require: typeof window.require,
      process: typeof process,
      ua: navigator.userAgent.includes("GGODesktop/"),
    }));
    check("the console runs in desktop mode with only the narrow bridge", bridge.shell === "desktop" && bridge.desktop.join(",") === "linksRegistered,onOpenThread,openInBrowser,platform,setTitleBarStyle,version" && bridge.connect === "undefined", JSON.stringify(bridge));
    check("no Node.js reaches the console page", bridge.require === "undefined" && bridge.process === "undefined", JSON.stringify(bridge));
    check("the window identifies itself as the desktop app", bridge.ua);
    const chrome = await page.evaluate(() => {
      const bar = document.querySelector(".topbar");
      const region = (el) => (el ? getComputedStyle(el).getPropertyValue("-webkit-app-region") || getComputedStyle(el).getPropertyValue("app-region") : "");
      return {
        bar: region(bar),
        button: region(document.querySelector(".shell-switch")),
        padRight: parseFloat(getComputedStyle(bar).paddingRight),
        label: document.querySelector(".shell-switch")?.getAttribute("aria-label"),
      };
    });
    check("the top bar is the title bar: it drags, its buttons don't", chrome.bar === "drag" && chrome.button === "no-drag", JSON.stringify(chrome));
    check("…and keeps clear of the window buttons", chrome.padRight >= 100, JSON.stringify(chrome));
    check("the desktop app shows Open in web", chrome.label === "Open in web", JSON.stringify(chrome));
    const overlays = await app.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows()[0];
      globalThis.__overlay = [];
      const original = win.setTitleBarOverlay.bind(win);
      win.setTitleBarOverlay = (options) => {
        globalThis.__overlay.push(options);
        original(options);
      };
      return true;
    });
    await page.evaluate(() => {
      document.documentElement.dataset.theme = "nocturne";
    });
    await waitFor(() => app.evaluate(() => globalThis.__overlay.length > 0), 5_000, 200);
    const pushed = await app.evaluate(() => globalThis.__overlay.at(-1) ?? null);
    const expected = await page.evaluate(() => {
      const c = document.createElement("canvas").getContext("2d");
      c.fillStyle = getComputedStyle(document.querySelector(".topbar")).getPropertyValue("--shell-bar").trim();
      c.fillRect(0, 0, 1, 1);
      const [r, g, b] = c.getImageData(0, 0, 1, 1).data;
      return `rgb(${r}, ${g}, ${b})`;
    });
    check("the window buttons follow the theme", overlays && pushed?.color === expected, JSON.stringify({ pushed, expected }));
    await page.evaluate(() => {
      delete document.documentElement.dataset.theme;
    });
    await sleep(600);
    await captureWindow(app, path.join(shots, "05-console-window.png"));

    // ---- 4. task navigation, an instruction from the window, live updates from a browser ----
    step("4");
    await openTask(page, TASK_TITLE);
    check("a task opens from the board", true);
    const fromDesktop = `desktop instruction ${Date.now()}`;
    await inject(page, fromDesktop);
    check("an instruction typed in the window shows in its feed", await feedHas(page, fromDesktop));
    check("…and is stored exactly once", (await waitFor(async () => storedCount(dataDir, fromDesktop) === 1, 10_000)) && storedCount(dataDir, fromDesktop) === 1, String(storedCount(dataDir, fromDesktop)));

    browser = await harness.loadChromium().launch();
    const ctx = await browser.newContext({ viewport: { width: 1500, height: 950 } });
    await ctx.request.post(`${BASE}/api/login`, { data: { password: harness.authPassword() } });
    const web = await ctx.newPage();
    const webConsole = [];
    web.on("console", (message) => webConsole.push(message.text()));
    await web.goto(`${BASE}/`);
    await web.waitForSelector(".accounts .acct", { state: "attached", timeout: 45_000 });
    await openTask(web, TASK_TITLE);
    check("the browser sees the desktop's instruction", await feedHas(web, fromDesktop));
    const fromBrowser = `browser instruction ${Date.now()}`;
    await inject(web, fromBrowser);
    check("an instruction from the browser streams into the open window, no reload", await feedHas(page, fromBrowser));
    const plainWeb = await web.evaluate(() => ({ shell: document.documentElement.dataset.shell ?? null, bridge: typeof window.ggoDesktop }));
    check("the browser console stays a plain web page", plainWeb.shell === null && plainWeb.bridge === "undefined", JSON.stringify(plainWeb));
    await page.screenshot({ path: path.join(shots, "06-task-live.png") });

    // ---- 5. a deliverable downloads into Downloads ----
    step("5");
    fs.mkdirSync(downloads, { recursive: true });
    await app.evaluate(({ app: electronApp }, dir) => electronApp.setPath("downloads", dir), downloads);
    const chip = page.locator(`.dl-chip:has(.dl-chip-btn[aria-label="${DELIVERABLE}"])`);
    await chip.hover();
    await chip.locator('a.btn:has-text("Download")').click();
    const saved = path.join(downloads, "report.md");
    const downloaded = await waitFor(async () => fs.existsSync(saved) && fs.readFileSync(saved, "utf8") === DELIVERABLE_TEXT, 15_000);
    check("Download saves the real file to the Downloads folder without a dialog", downloaded, fs.existsSync(downloads) ? fs.readdirSync(downloads).join(",") : "no folder");
    await chip.hover();
    await chip.locator('a.btn:has-text("Download")').click();
    check("a second download is numbered, not overwritten", await waitFor(async () => fs.existsSync(path.join(downloads, "report (1).md")), 15_000), fs.readdirSync(downloads).join(","));
    const downloadUrl = await chip.locator('a.btn:has-text("Download")').evaluate((link) => link.href);
    await app.evaluate(({ BrowserWindow }, url) => {
      const contents = BrowserWindow.getAllWindows()[0].webContents;
      contents.downloadURL(url);
      contents.downloadURL(url);
    }, downloadUrl);
    check("simultaneous downloads keep separate complete files", await waitFor(async () => ["report (2).md", "report (3).md"].every((name) => fs.existsSync(path.join(downloads, name)) && fs.readFileSync(path.join(downloads, name), "utf8") === DELIVERABLE_TEXT), 15_000), fs.readdirSync(downloads).join(","));
    await page.mouse.move(5, 300);

    // ---- 6. external links leave for the system browser; nothing else leaves at all ----
    step("6");
    const before = (await opened(app)).length;
    const popup = await page.evaluate(() => window.open("https://example.com/docs") === null);
    await page.evaluate(() => {
      location.href = "https://example.com/away";
    });
    await sleep(800);
    await page.evaluate(() => {
      location.href = "file:///C:/";
    });
    await sleep(800);
    const external = (await opened(app)).slice(before);
    check("window.open of a web link goes to the system browser", popup && external.includes("https://example.com/docs"), JSON.stringify(external));
    check("navigating off the console goes to the system browser instead", external.includes("https://example.com/away") && page.url().startsWith(BASE), page.url());
    check("a file:// navigation is refused outright", !external.some((u) => u.startsWith("file:")) && page.url().startsWith(BASE));
    const windows = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length);
    check("no extra windows were opened", windows === 1, String(windows));
    const settled = await app.evaluate(({ BrowserWindow }) => !BrowserWindow.getAllWindows()[0].webContents.isLoading());
    check("…and the console is left idle and usable", settled && (await page.evaluate(() => !!document.querySelector(".detail-head"))));
    // Playwright keeps waiting on a navigation the app cancelled in will-navigate, so every later click
    // would stall on it; a reload hands it a fresh document. The window itself is fine, as checked above.
    await page.reload();
    await waitForConsole(page);
    await openTask(page, TASK_TITLE);

    // ---- 7. Open in web hands the browser a one-time sign-in on this task ----
    step("7");
    const beforeWeb = (await opened(app)).length;
    await page.click('.shell-switch[aria-label="Open in web"]');
    await waitFor(async () => (await opened(app)).length > beforeWeb, 10_000, 200);
    const webLink = (await opened(app)).slice(beforeWeb)[0] ?? "";
    check("Open in web opens a redeem link for this task", new RegExp(`^${BASE}/api/desktop/redeem\\?ticket=[A-Za-z0-9_-]{43}&thread=${TASK}$`).test(webLink), webLink);
    await ctx.close();
    const fresh = await browser.newContext({ viewport: { width: 1500, height: 950 } });
    const landed = await fresh.newPage();
    await landed.goto(webLink);
    await landed.waitForSelector(".accounts .acct", { state: "attached", timeout: 45_000 }).catch(() => undefined);
    const landedHead = await landed.waitForFunction((t) => document.querySelector(".detail-head")?.textContent?.includes(t), TASK_TITLE, { timeout: 20_000 }).then(() => true).catch(() => false);
    check("…which signs a browser with no session in, on the same task", landedHead, landed.url());
    check("…and leaves no ticket or thread in the address bar", landed.url() === `${BASE}/`, landed.url());
    const replay = await fresh.request.get(webLink, { maxRedirects: 0 });
    check("the ticket works once", /e=desktop/.test(replay.headers().location ?? ""), JSON.stringify(replay.headers().location));
    await landed.screenshot({ path: path.join(shots, "07-open-in-web.png") });

    // ---- 8. Open in desktop: offered where the app has run, and its link signs a fresh profile in ----
    step("8");
    const availability = async () => (await fetch(`${BASE}/api/desktop/availability`, { headers: { cookie: await sessionCookie(app) } })).json();
    const unregistered = await availability();
    check("an app on a throwaway profile (no ggo:// handler) never offers itself to browsers", unregistered.available === false && bridge.links === false, JSON.stringify({ unregistered, links: bridge.links }));
    // What an installed app, which does register ggo://, reports on connecting.
    await fetch(`${BASE}/api/desktop/presence`, { method: "POST", headers: { cookie: await sessionCookie(app), "user-agent": `Mozilla/5.0 GGODesktop/${bridge.version}` } });
    const browserTab = landed;
    await browserTab.reload();
    await browserTab.waitForSelector(".accounts .acct", { state: "attached", timeout: 45_000 });
    // The reload lands on the board (the address bar no longer names the task), so reopen it.
    await openTask(browserTab, TASK_TITLE);
    const offered = await browserTab.waitForSelector('.shell-switch[aria-label="Open in desktop"]', { timeout: 15_000 }).then(() => true).catch(() => false);
    check("the browser console offers Open in desktop on this machine", offered);
    const ticketCall = browserTab.waitForResponse((r) => r.url().endsWith("/api/desktop/ticket"), { timeout: 10_000 }).catch(() => null);
    const launchAttempt = new Promise((resolve) => {
      const done = (text) => resolve(text);
      browserTab.on("console", (m) => /ggo:\/\/open/.test(m.text()) && done(m.text()));
      browserTab.on("request", (r) => r.url().startsWith("ggo:") && done(r.url()));
      setTimeout(() => done(null), 6_000);
    });
    await browserTab.click('.shell-switch[aria-label="Open in desktop"]');
    const ticketResponse = await ticketCall;
    check("Open in desktop asks the server for a ticket", ticketResponse?.status() === 200, String(ticketResponse?.status()));
    const attempt = await launchAttempt;
    check("…and launches a ggo://open link carrying it and the task", !attempt || new RegExp(`ggo://open/?\\?ticket=[A-Za-z0-9_-]{43}&server=${encodeURIComponent(new URL(BASE).origin)}&thread=${TASK}`).test(attempt), String(attempt));
    await browserTab.screenshot({ path: path.join(shots, "08-open-in-desktop-offered.png") });
    await fresh.close();

    // A fresh profile opened by such a link lands signed in on the task, with no password typed.
    const ticketForB = (await (await fetch(`${BASE}/api/desktop/ticket`, { method: "POST", headers: { cookie: await sessionCookie(app) } })).json()).ticket;
    const runB = await launchApp(playwright, dataDir, profileB, [`ggo://open?ticket=${ticketForB}&server=${encodeURIComponent(new URL(BASE).origin)}&thread=${OTHER}`]);
    apps.push(runB.app);
    const bOnTask = await runB.page.waitForFunction((t) => document.querySelector(".detail-head")?.textContent?.includes(t), OTHER_TITLE, { timeout: 60_000 }).then(() => true).catch(() => false);
    check("a ggo://open link signs a fresh desktop profile in, on its task", bOnTask, runB.page.url());
    await runB.page.screenshot({ path: path.join(shots, "09-deep-link-fresh-profile.png") });

    // A second launch on a running profile hands its link over instead of opening a second app.
    const second = spawn(ELECTRON, [DESKTOP, `ggo://open?thread=${TASK}`], { cwd: DESKTOP, env: appEnv(dataDir, profileB), stdio: "ignore", windowsHide: true });
    const secondExit = await new Promise((done) => {
      second.once("exit", (exitCode) => done(exitCode));
      setTimeout(() => done("still running"), 30_000);
    });
    const bSwitched = await runB.page.waitForFunction((t) => document.querySelector(".detail-head")?.textContent?.includes(t), TASK_TITLE, { timeout: 20_000 }).then(() => true).catch(() => false);
    check("a second launch exits and forwards its link to the open window", secondExit === 0 && bSwitched, `exit ${secondExit}, switched ${bSwitched}`);

    // A link minted by a console on another server: its ticket and task mean nothing here.
    const foreignTicket = (await (await fetch(`${BASE}/api/desktop/ticket`, { method: "POST", headers: { cookie: await sessionCookie(app) } })).json()).ticket;
    const foreign = spawn(ELECTRON, [DESKTOP, `ggo://open?ticket=${foreignTicket}&server=${encodeURIComponent("http://192.0.2.10:4317")}&thread=${OTHER}`], { cwd: DESKTOP, env: appEnv(dataDir, profileB), stdio: "ignore", windowsHide: true });
    await new Promise((done) => {
      foreign.once("exit", done);
      setTimeout(done, 30_000);
    });
    await sleep(3_000);
    const stayed = await runB.page.evaluate((t) => document.querySelector(".detail-head")?.textContent?.includes(t), TASK_TITLE);
    const unspent = await fetch(redeemLink(foreignTicket), { redirect: "manual" });
    check("a link from another server's console neither redeems its ticket nor switches the task", stayed && !/e=desktop/.test(unspent.headers.get("location") ?? ""), JSON.stringify({ stayed, location: unspent.headers.get("location") }));
    check("the second profile's app quits cleanly", await closeApp(runB.app));
    apps.splice(apps.indexOf(runB.app), 1);
    const presence = await availability();
    check("an installed app's registration makes this machine offer Open in desktop", presence.available === true, JSON.stringify(presence));

    // ---- 9. a server restart: the console reconnects on its own ----
    step("9");
    metrics.idleConsole = await appMemoryMb(app);
    const restartFrom = serverProcesses();
    process.kill(restartFrom.server);
    const dropped = await page.waitForFunction(() => /reconnecting/.test(document.querySelector(".conn")?.textContent ?? ""), null, { timeout: 30_000 }).then(() => true).catch(() => false);
    const restarted = Date.now();
    const back = await page.waitForFunction(() => /live/.test(document.querySelector(".conn")?.textContent ?? ""), null, { timeout: 180_000 }).then(() => true).catch(() => false);
    timings.serverRestartReconnectMs = Date.now() - restarted;
    check("when the server restarts the window shows reconnecting, then live again", dropped && back, `dropped ${dropped}, back ${back}`);
    check("…on the same supervisor", serverProcesses()?.supervisor === restartFrom.supervisor);

    // ---- 10. a dead server under a reload: the app's own lost screen, then back where it was ----
    step("10");
    await openTask(page, TASK_TITLE);
    stopServer();
    await waitFor(async () => !(await answers()), 20_000);
    await page.reload().catch(() => undefined);
    const lost = await connectTitle(page, "Lost the connection", 30_000);
    state = await connectState(page);
    check("a page that can't load shows Lost the connection with Start GGO", lost && !!state.buttons?.includes("Start GGO"), JSON.stringify(state));
    await page.screenshot({ path: path.join(shots, "10-lost.png") });
    await page.click('#actions button:text-is("Start GGO")');
    await waitForConsole(page, 200_000).catch(() => undefined);
    check("Start GGO from the lost screen brings the console back, still signed in", page.url().startsWith(BASE) && (await page.locator(".accounts .acct").count()) > 0, page.url());

    // ---- 11. a crashed renderer ----
    step("11");
    // Playwright's page dies with the renderer it was attached to, so the window is read through the
    // main process from here until the relaunch in step 12.
    // executeJavaScript never settles while the renderer is gone, so each call is bounded.
    const windowState = () => app.evaluate(({ BrowserWindow }) => {
      const contents = BrowserWindow.getAllWindows()[0].webContents;
      return { url: contents.getURL(), crashed: contents.isCrashed(), loading: contents.isLoading() };
    });
    const inWindow = (script) =>
      Promise.race([app.evaluate(({ BrowserWindow }, source) => BrowserWindow.getAllWindows()[0].webContents.executeJavaScript(source), script).catch(() => null), sleep(3_000).then(() => null)]);
    const settledOn = async (prefix) => {
      const s = await windowState();
      return s.url.startsWith(prefix) && !s.crashed && !s.loading;
    };
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.forcefullyCrashRenderer());
    const crashed = await waitFor(async () => (await settledOn("ggo-app:")) && (await inWindow(`document.getElementById("title")?.textContent`)) === "This window stopped", 20_000, 300);
    const atCrash = await windowState();
    await sleep(500);
    await captureWindow(app, path.join(shots, "11-crashed.png"));
    if (crashed) await inWindow(`[...document.querySelectorAll("#actions button")].find((b) => b.textContent === "Reload")?.click()`);
    const recovered = await waitFor(async () => (await settledOn(BASE)) && (await inWindow(`!!document.querySelector(".accounts .acct")`)) === true, 60_000);
    check("a crashed window says so and Reload brings the console back", crashed && recovered, JSON.stringify({ crashed, recovered, atCrash, now: await windowState() }));

    // ---- 12. closing the window never stops the server; reopening lands straight in the console ----
    step("12");
    // Moved within whichever monitor the window is on, so the lab never drags it onto the main one. A
    // minimized window ignores the move; it must then come back at the bounds it had before.
    const setTo = await app.evaluate(({ BrowserWindow, screen }) => {
      const win = BrowserWindow.getAllWindows()[0];
      const { workArea } = screen.getDisplayMatching(win.getNormalBounds());
      if (!win.isMinimized()) win.setBounds({ x: workArea.x + 40, y: workArea.y + 30, width: 1320, height: 860 });
      return win.getNormalBounds();
    });
    const serverBefore = serverProcesses();
    check("the app quits cleanly with its server still running", await closeApp(app));
    const savedSettings = fs.readFileSync(path.join(profileA, "desktop-settings.json"), "utf8");
    apps.splice(apps.indexOf(app), 1);
    await sleep(2_000);
    check("closing the window leaves the server running", (await answers()) && alive(serverBefore.server) && alive(serverBefore.supervisor), JSON.stringify(serverBefore));
    const lateNote = `typed while the window was closed ${Date.now()}`;
    const cookieJar = await browser.newContext();
    await cookieJar.request.post(`${BASE}/api/login`, { data: { password: harness.authPassword() } });
    const writer = await cookieJar.newPage();
    await writer.goto(`${BASE}/`);
    await writer.waitForSelector(".accounts .acct", { state: "attached", timeout: 45_000 });
    await openTask(writer, TASK_TITLE);
    await inject(writer, lateNote);
    await feedHas(writer, lateNote);
    await cookieJar.close();

    run = await launchApp(playwright, dataDir, profileA);
    apps.push(run.app);
    ({ app, page } = run);
    await waitForConsole(page);
    timings.relaunchToLiveConsoleMs = Date.now() - run.started;
    check("reopening skips sign-in: the session persisted", (await page.locator('input[type="password"]').count()) === 0);
    const bounds = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getNormalBounds());
    check("the window reopens where it was", Math.abs(bounds.x - setTo.x) <= 2 && Math.abs(bounds.y - setTo.y) <= 2 && Math.abs(bounds.width - setTo.width) <= 2, JSON.stringify({ bounds, setTo, savedSettings }));
    await openTask(page, TASK_TITLE);
    check("work done while it was closed is there on reopen", await feedHas(page, lateNote));
    await sleep(8_000);
    metrics.reopenedConsole = await appMemoryMb(app);
    await page.screenshot({ path: path.join(shots, "12-reopened.png") });
    check("the reopened app quits cleanly", await closeApp(app));
    apps.splice(apps.indexOf(app), 1);

    fs.writeFileSync(path.join(shots, "desktop-lab-metrics.json"), `${JSON.stringify({ timings, metrics }, null, 2)}\n`);
    console.log(`\ntimings: ${JSON.stringify(timings)}\nmemory: ${JSON.stringify(metrics)}\nscreenshots: ${shots}`);
    code = check.summary();
  } catch (error) {
    // Reported before the cleanup below, which can be slow, so a crash names its step at once.
    console.error("[lab crashed]", error);
  } finally {
    for (const open of apps) await closeApp(open);
    if (browser) await browser.close().catch(() => undefined);
    stopServer();
    if (!keep) {
      await sleep(1_500);
      fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
    } else {
      console.log(`kept ${dataDir}`);
    }
  }
  process.exit(code);
})().catch((error) => {
  console.error(error);
  stopServer();
  process.exit(2);
});

/** The window's session cookie, to call the lab server as the signed-in owner from Node. */
async function sessionCookie(app) {
  const cookies = await app.evaluate(({ session }, url) => session.defaultSession.cookies.get({ url }), BASE);
  return cookies.map((c) => `${c.name}=${c.value}`).join("; ");
}
