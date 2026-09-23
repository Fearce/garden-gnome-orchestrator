// Drive the Director's standing-directives button + dialog in a real browser against a THROWAWAY
// instance (own port, own temp DATA_DIR), never production.
//
//   npm run directives-lab --prefix server
//   npm run directives-lab --prefix server -- --keep --shots data/directives-lab-shots
//
// test:director-directives proves the prompt/session/dispatch logic. This proves the owner-facing half:
// the header pill, the editor, the save round-trip into kv, reload and restart persistence, the guard
// against losing typed text, and the phone header still fitting beside the Director's name.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  loadChromium,
  authPassword,
  requireBuild,
  requireFreshWebBuild,
  waitForPersisted,
  waitForSettingsReloadSafe,
  boot,
  killInstance,
  createChecks,
} = require("./lab-harness.cjs");

// Sibling labs use 4327-4497 plus each base port's +2 HTTPS listener; 4487/4489 are clear.
const PORT = 4487;
const BASE = `http://127.0.0.1:${PORT}`;
const NAV_TIMEOUT = 45_000;
const KV_KEY = "setting_director_directives";
const PILL = ".rail-head-actions .directives-toggle";
const DIALOG = ".modal.directives-modal";
const INPUT = `${DIALOG} textarea.directives-input`;
const TEXT = "Always prefer Claude models. OpenAI is our backup subscription.\nUse low effort unless a task is clearly hard.";

const check = createChecks();
const shotsArg = process.argv.indexOf("--shots");
const shots = shotsArg > 0 ? path.resolve(process.argv[shotsArg + 1]) : null;

async function shot(page, name) {
  if (!shots) return;
  fs.mkdirSync(shots, { recursive: true });
  await page.screenshot({ path: path.join(shots, `${name}.png`) });
}

async function open(page, { login = false, reload = false, directorPane = false } = {}) {
  if (login) {
    const response = await page.request.post(`${BASE}/api/login`, { data: { password: authPassword() } });
    if (!response.ok()) throw new Error(`login failed with HTTP ${response.status()}`);
  }
  if (reload) await page.reload({ timeout: NAV_TIMEOUT });
  else await page.goto(`${BASE}/`, { timeout: NAV_TIMEOUT });
  // Settings are server-authoritative; the account chip only renders once the socket's hello landed.
  await page.waitForSelector(".accounts .acct", { timeout: 25_000 });
  // The mobile console opens on the board and hides the Director rail until its tab is selected.
  if (directorPane && (page.viewportSize()?.width ?? Infinity) < 900) {
    await page.locator(".mobile-nav button").first().click();
  }
  await page.waitForSelector(PILL, { timeout: 10_000 });
}

const pillState = (page) => page.locator(PILL).evaluate((el) => (el.classList.contains("on") ? "on" : "off"));

async function verifyDesktop(browser, dataDir) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  try {
    const page = await context.newPage();
    await open(page, { login: true });
    check("the pill sits in the Director header, beside the pipeline gates", await page.locator(".rail-head-actions .agent-toggles + .directives-toggle").isVisible());
    check("it reads as unset on a fresh install", (await pillState(page)) === "off");
    check("its label is visible on desktop", await page.locator(`${PILL} .directives-label`).isVisible());
    await shot(page, "desktop-unset");

    await page.click(PILL);
    await page.waitForSelector(DIALOG, { timeout: 5_000 });
    check("the editor opens focused on the text area", await page.locator(INPUT).evaluate((el) => document.activeElement === el));
    check("Save starts disabled with nothing changed", await page.locator(`${DIALOG} button:text-is("Save")`).isDisabled());
    await page.fill(INPUT, TEXT);
    check("the counter tracks the text", (await page.locator(`${DIALOG} .directives-count`).innerText()).startsWith(`${TEXT.length} /`));
    await shot(page, "desktop-editor");

    // A stray click on the backdrop must not throw away typed instructions.
    await page.mouse.click(8, 8);
    check("a backdrop click keeps an edited dialog open", await page.locator(DIALOG).isVisible());
    await page.keyboard.press("Escape");
    check("Escape keeps an edited dialog open", await page.locator(DIALOG).isVisible());
    check("the cancel button says what it will do", (await page.locator(`${DIALOG} .m-foot button`).allInnerTexts()).includes("Discard"));

    await page.click(`${DIALOG} button:text-is("Save")`);
    await page.waitForSelector(DIALOG, { state: "detached", timeout: 5_000 });
    const stored = await waitForSettingsReloadSafe(dataDir, KV_KEY, TEXT);
    check("Save reaches the server and persists verbatim", stored === TEXT, JSON.stringify(stored));
    check("the pill reads as set", (await pillState(page)) === "on");
    const title = await page.locator(PILL).getAttribute("title");
    check("hovering the pill previews the directives", !!title && title.includes("Use low effort unless a task is clearly hard."), title ?? "");

    await open(page, { reload: true });
    check("the set state survives a reload", (await pillState(page)) === "on");
    await page.click(PILL);
    await page.waitForSelector(DIALOG);
    check("reopening shows the saved text", (await page.locator(INPUT).inputValue()) === TEXT);
    await page.keyboard.press("Escape");
    await page.waitForSelector(DIALOG, { state: "detached", timeout: 5_000 });
    check("Escape closes an unchanged dialog", true);

    // Ctrl+Enter is the keyboard save.
    await page.click(PILL);
    await page.waitForSelector(DIALOG);
    await page.locator(INPUT).press("End");
    await page.keyboard.type("\nHold every change to NASA-grade review.");
    await page.keyboard.press("Control+Enter");
    await page.waitForSelector(DIALOG, { state: "detached", timeout: 5_000 });
    const appended = await waitForPersisted(dataDir, KV_KEY, `${TEXT}\nHold every change to NASA-grade review.`);
    check("Ctrl+Enter saves", appended === `${TEXT}\nHold every change to NASA-grade review.`, JSON.stringify(appended));
  } finally {
    await context.close();
  }
}

async function verifyRestart(browser, dataDir) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  try {
    const page = await context.newPage();
    await open(page, { login: true });
    check("the directives survive a real server restart", (await pillState(page)) === "on");

    await page.click(PILL);
    await page.waitForSelector(DIALOG);
    await page.click(`${DIALOG} button:text-is("Clear")`);
    check("Clear empties the field but waits for Save", (await page.locator(INPUT).inputValue()) === "" && (await page.locator(DIALOG).isVisible()));
    await page.click(`${DIALOG} button:text-is("Save")`);
    await page.waitForSelector(DIALOG, { state: "detached", timeout: 5_000 });
    const cleared = await waitForSettingsReloadSafe(dataDir, KV_KEY, "");
    check("clearing persists an empty value", cleared === "", JSON.stringify(cleared));
    check("the pill returns to unset", (await pillState(page)) === "off");
  } finally {
    await context.close();
  }
}

async function verifyPhone(browser, dataDir) {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 3 });
  try {
    const page = await context.newPage();
    await open(page, { login: true, directorPane: true });
    const layout = await page.evaluate((pill) => {
      const box = (sel) => {
        const el = document.querySelector(sel);
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { left: Math.round(r.left), right: Math.round(r.right), width: Math.round(r.width), top: Math.round(r.top), bottom: Math.round(r.bottom) };
      };
      return {
        viewport: innerWidth,
        pill: box(pill),
        name: box(".rail-head .who"),
        label: getComputedStyle(document.querySelector(`${pill} .directives-label`)).display,
        docWidth: document.documentElement.scrollWidth,
      };
    }, PILL);
    check("the pill is on screen on a phone", !!layout.pill && layout.pill.left >= 0 && layout.pill.right <= layout.viewport, JSON.stringify(layout));
    check("it collapses to its icon on a phone", layout.label === "none", JSON.stringify(layout));
    check("the Director's name keeps usable room beside it", !!layout.name && layout.name.width >= 80, JSON.stringify(layout));
    check("the header adds no sideways scroll", layout.docWidth <= layout.viewport + 1, JSON.stringify(layout));
    await shot(page, "phone-header");

    await page.tap(PILL);
    await page.waitForSelector(DIALOG);
    const dialog = await page.locator(DIALOG).evaluate((el) => {
      const r = el.getBoundingClientRect();
      return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, vw: innerWidth, vh: innerHeight };
    });
    check("the editor fits the phone viewport", dialog.left >= 0 && dialog.right <= dialog.vw && dialog.top >= 0 && dialog.bottom <= dialog.vh, JSON.stringify(dialog));
    await page.fill(INPUT, "Use medium effort.");
    await page.tap(`${DIALOG} button:text-is("Save")`);
    const stored = await waitForPersisted(dataDir, KV_KEY, "Use medium effort.");
    check("saving from a phone persists", stored === "Use medium effort.", JSON.stringify(stored));
    await shot(page, "phone-saved");
  } finally {
    await context.close();
  }
}

async function rmWithRetry(dir) {
  for (let attempt = 0; attempt < 20; attempt++) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      return;
    } catch (error) {
      if (attempt === 19) return console.log(`  temp dir left behind (${error.code ?? "unknown error"}): ${dir}`);
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
}

async function main() {
  const keep = process.argv.includes("--keep");
  requireBuild();
  requireFreshWebBuild();
  killInstance(PORT);
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "directives-lab-"));
  let browser;
  let succeeded = false;
  try {
    await boot({ dataDir, port: PORT });
    browser = await loadChromium().launch();
    await verifyDesktop(browser, dataDir);
    killInstance(PORT);
    await boot({ dataDir, port: PORT });
    await verifyRestart(browser, dataDir);
    await verifyPhone(browser, dataDir);
    const code = check.summary();
    succeeded = code === 0;
    return code;
  } finally {
    if (browser) await browser.close().catch(() => {});
    if (!keep || !succeeded) {
      killInstance(PORT);
      await rmWithRetry(dataDir);
    } else {
      console.log(`  instance kept at ${BASE} (data: ${dataDir})`);
    }
  }
}

main().then(
  (code) => process.exit(code),
  (error) => {
    console.error(error);
    killInstance(PORT);
    process.exit(1);
  },
);
