// Verify "Prepare a sub for reset" (Settings → Usage & limits) in an authenticated real browser without
// touching production. The lab owns an alternate port, a temp DATA_DIR and bogus account tokens, so its
// picks cannot change the live installation's routing or wake a real account.
//
//   npm run reset-burn-lab --prefix server
//   npm run reset-burn-lab --prefix server -- --keep
//
// test:reset-burn proves the burn lifecycle and test:provider-fallback the routing; this lab proves the
// owner-facing picker renders on the right page, round-trips through the WebSocket to SQLite, shows the
// burn's status, survives a restart, and that Off really ends it.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Database = require("better-sqlite3");
const { loadChromium, authPassword, requireBuild, boot, killInstance, createChecks } = require("./lab-harness.cjs");

// Sibling labs use 4327-4533 plus each base port's +2 HTTPS listener. Keep both 4541 and 4543 clear.
const PORT = 4541;
const BASE = `http://127.0.0.1:${PORT}`;
const NAV_TIMEOUT = 45_000;
const KV_KEY = "setting_reset_burn";
const SETTINGS = '[role="dialog"][aria-label="Settings"]';
const GROUP = '.settings-group:has(.settings-group-label:text-is("Prepare a sub for reset"))';
const PICKER = 'select[aria-label="Sub to prepare for reset"]';
const STATUS = ".reset-burn-status";
const LAB_ENV = { ACCOUNT_1_LABEL: "personal", ACCOUNT_2_LABEL: "team" };

const check = createChecks();

function readPersisted(dataDir) {
  try {
    const db = new Database(path.join(dataDir, "orchestrator.sqlite"), { readonly: true });
    const row = db.prepare("SELECT value FROM kv WHERE key = ?").get(KV_KEY);
    db.close();
    return row?.value ?? null;
  } catch {
    return null;
  }
}

function writePersisted(dataDir, value) {
  const db = new Database(path.join(dataDir, "orchestrator.sqlite"));
  db.prepare("INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(KV_KEY, value);
  db.close();
}

/** The picker updates through the server. Wait for SQLite, the server-owned state, before trusting it. */
async function waitForPersisted(dataDir, predicate, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  let actual = null;
  while (Date.now() < deadline) {
    actual = readPersisted(dataDir);
    if (predicate(actual)) return actual;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return actual;
}

async function openUsageSettings(page, { login = false } = {}) {
  if (login) {
    const response = await page.request.post(`${BASE}/api/login`, { data: { password: authPassword() } });
    if (!response.ok()) throw new Error(`login failed with HTTP ${response.status()}`);
  }
  await page.goto(`${BASE}/`, { timeout: NAV_TIMEOUT });
  await page.waitForSelector(".accounts .acct", { state: "attached", timeout: 25_000 });
  await page.click('[aria-label="Open settings"]');
  await page.waitForSelector(SETTINGS, { timeout: 20_000 });
  // A phone hides the category rail behind a <select>.
  const rail = page.locator('[data-settings-category="usage"]');
  if (await rail.isVisible()) await rail.click();
  else await page.selectOption('select[aria-label="Settings category"]', "usage");
  await page.waitForSelector(GROUP, { timeout: 10_000 });
}

async function statusText(page) {
  const status = page.locator(STATUS);
  return (await status.count()) ? (await status.innerText()).replace(/\s+/g, " ") : "";
}

async function verifyPick(browser, dataDir) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  try {
    const page = await context.newPage();
    await openUsageSettings(page, { login: true });

    check("the group renders exactly once, on the Usage page", (await page.locator(GROUP).count()) === 1);
    check("a fresh installation has no burn", (await page.inputValue(PICKER)) === "" && readPersisted(dataDir) === null);
    check("no status line while off", (await statusText(page)) === "");
    const options = await page.locator(`${PICKER} option`).allInnerTexts();
    check("the picker lists Off and both Claude subs", options[0] === "Off" && options.some((o) => o.startsWith("personal")) && options.some((o) => o.startsWith("team")), options.join(" | "));
    check("Codex is not offered while it is off", !options.some((o) => o.startsWith("Codex")), options.join(" | "));

    await page.selectOption(PICKER, "acct2");
    const stored = await waitForPersisted(dataDir, (value) => value != null && JSON.parse(value).subId === "acct2");
    check("picking team reaches the server and persists", stored != null && JSON.parse(stored).subId === "acct2", String(stored));
    await page.waitForSelector(STATUS, { timeout: 10_000 });
    const status = await statusText(page);
    check("the status names the burned sub", status.includes("Preparing team for its reset"), status);
    check("an unread weekly reset says when the burn stops at the latest", status.includes("has not been read yet") && /within (7d|6d 23h) at the latest/.test(status), status);
    check("the picker shows the choice", (await page.inputValue(PICKER)) === "acct2");

    const box = await page.locator(PICKER).boundingBox();
    const dialog = await page.locator(SETTINGS).boundingBox();
    check("the picker sits inside the settings dialog", !!box && !!dialog && box.x >= dialog.x && box.x + box.width <= dialog.x + dialog.width + 0.5, JSON.stringify({ box, dialog }));
    await page.locator(GROUP).screenshot({ path: path.join(os.tmpdir(), "reset-burn-lab-desktop.png") });
  } finally {
    await context.close();
  }
}

async function verifyAnchoredAfterRestart(browser, dataDir) {
  const context = await browser.newContext({ viewport: { width: 1200, height: 800 } });
  try {
    const page = await context.newPage();
    await openUsageSettings(page, { login: true });
    check("the burn survives a real restart", (await page.inputValue(PICKER)) === "acct2");
    const status = await statusText(page);
    check("an anchored burn counts down to its weekly reset", status.includes("Ends when its weekly window resets, in 2d"), status);

    await page.selectOption(PICKER, "");
    const cleared = await waitForPersisted(dataDir, (value) => value === null);
    check("Off ends the burn on the server", cleared === null, String(cleared));
    await page.waitForSelector(STATUS, { state: "detached", timeout: 10_000 });
    check("Off removes the status line", (await statusText(page)) === "");
  } finally {
    await context.close();
  }
}

async function verifyPhone(browser) {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  try {
    const page = await context.newPage();
    await openUsageSettings(page, { login: true });
    const box = await page.locator(PICKER).boundingBox();
    check("the picker fits a phone screen", !!box && box.x >= 0 && box.x + box.width <= 390.5, JSON.stringify(box));
    await page.locator(GROUP).screenshot({ path: path.join(os.tmpdir(), "reset-burn-lab-phone.png") });
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
      if (attempt === 19) {
        console.log(`  temp dir left behind (${error.code ?? "unknown error"}): ${dir}`);
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
}

async function main() {
  const keep = process.argv.includes("--keep");
  requireBuild();
  killInstance(PORT);

  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "reset-burn-lab-"));
  let browser;
  let succeeded = false;
  try {
    await boot({ dataDir, port: PORT, env: LAB_ENV });
    browser = await loadChromium().launch();
    await verifyPick(browser, dataDir);

    // Anchor the stored burn to a weekly reset ~2.5 days out, as the first usage reading would, then
    // restart on the same DATA_DIR so the setting is proven to come back from kv rather than memory.
    killInstance(PORT);
    const burn = JSON.parse(readPersisted(dataDir));
    writePersisted(dataDir, JSON.stringify({ ...burn, windowReset: Date.now() + 60 * 60 * 60_000 }));
    await boot({ dataDir, port: PORT, env: LAB_ENV });
    await verifyAnchoredAfterRestart(browser, dataDir);
    await verifyPhone(browser);

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
