// Verify the Token conservation mode setting in an authenticated real browser without touching
// production. The lab owns an alternate port and a temp DATA_DIR, so its toggle clicks and process
// restart cannot change the live installation's settings or wake a real account.
//
//   npm run token-conservation-lab --prefix server
//   npm run token-conservation-lab --prefix server -- --keep
//
// This is intentionally separate from test:token-conservation. That gate proves the pure
// conservationActive/conservationResolvedModel decision logic; this lab proves the owner-facing
// control actually renders in the right settings category, round-trips through the WebSocket to
// SQLite, and survives a reload — none of which a typecheck or a unit test can see.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Database = require("better-sqlite3");
const { loadChromium, authPassword, requireBuild, boot, killInstance, createChecks } = require("./lab-harness.cjs");

// Sibling labs use 4327-4397 plus each base port's +2 HTTPS listener. Keep both 4497 and 4499 clear.
const PORT = 4497;
const BASE = `http://127.0.0.1:${PORT}`;
const NAV_TIMEOUT = 45_000;
const KV_KEY = "setting_token_conservation_mode";
const SETTINGS = '[role="dialog"][aria-label="Settings"]';
const GROUP = '.settings-group:has(.settings-group-label:text-is("Usage routing"))';
const TOGGLE = 'button.switch[aria-label="Token conservation mode"]';

const check = createChecks();

function readPersisted(dataDir) {
  const file = path.join(dataDir, "orchestrator.sqlite");
  try {
    const db = new Database(file, { readonly: true });
    const row = db.prepare("SELECT value FROM kv WHERE key = ?").get(KV_KEY);
    db.close();
    return row?.value ?? null;
  } catch {
    return null;
  }
}

/** The switch updates optimistically. Wait for SQLite, the server-owned state, before trusting it. */
async function waitForPersisted(dataDir, expected, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  let actual = null;
  while (Date.now() < deadline) {
    actual = readPersisted(dataDir);
    if (actual === expected) return actual;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return actual;
}

async function authenticate(page) {
  const response = await page.request.post(`${BASE}/api/login`, { data: { password: authPassword() } });
  if (!response.ok()) throw new Error(`login failed with HTTP ${response.status()}`);
}

async function openSettings(page, { login = false, reload = false } = {}) {
  if (login) await authenticate(page);
  if (reload) await page.reload({ timeout: NAV_TIMEOUT });
  else await page.goto(`${BASE}/`, { timeout: NAV_TIMEOUT });

  // Settings are server-authoritative. The account chip only appears after the WebSocket hello frame.
  await page.waitForSelector(".accounts .acct", { timeout: 25_000 });
  await page.click('[aria-label="Open settings"]');
  await page.waitForSelector(SETTINGS, { timeout: 20_000 });
  // Settings is CATEGORIZED — the toggle lives on the "usage" page, not the default General one.
  await page.click('[data-settings-category="usage"]');
  await page.waitForSelector(GROUP, { timeout: 10_000 });
}

async function toggleState(page) {
  return page.getAttribute(TOGGLE, "aria-checked");
}

async function verifyDesktop(browser, dataDir) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  try {
    const page = await context.newPage();
    await openSettings(page, { login: true });

    check("the Usage routing group renders exactly once", (await page.locator(GROUP).count()) === 1);
    check("a fresh installation defaults token conservation mode OFF", (await toggleState(page)) === "false", await toggleState(page));
    check("kv has no row yet on a fresh install", readPersisted(dataDir) === null, String(readPersisted(dataDir)));

    const copy = (await page.locator(GROUP).locator(":has-text('Token conservation mode')").first().locator("..").innerText()).replace(/\s+/g, " ");
    const mustName = ["last 10%", "Claude Sonnet", "GPT-5.6 Luna", "24h", "model pin", "Off by default"];
    check("the hint names the threshold, both economy models, the reset grace, and the pin exemption", mustName.every((part) => copy.includes(part)), copy);

    await page.click(TOGGLE);
    const storedOn = await waitForPersisted(dataDir, "1");
    check("turning it ON reaches the server and persists in kv", storedOn === "1", String(storedOn));

    await openSettings(page, { reload: true });
    check("ON survives a browser reload", (await toggleState(page)) === "true", await toggleState(page));

    // Deliberately left ON here — verifyRestart asserts it reads back as ON (not just OFF-by-default)
    // after a real process death, which is the only way that check can fail for the reason it claims to.
  } finally {
    await context.close();
  }
}

async function verifyRestart(browser, dataDir) {
  const context = await browser.newContext({ viewport: { width: 1200, height: 800 } });
  try {
    const page = await context.newPage();
    await openSettings(page, { login: true });
    // Asserting ON (not the fresh-install default of OFF) is what makes this prove the kv row actually
    // survived the process death, rather than passing vacuously against a wiped/never-written setting.
    check("ON survives a real throwaway-server restart", (await toggleState(page)) === "true", await toggleState(page));

    await page.click(TOGGLE);
    const storedOff = await waitForPersisted(dataDir, "0");
    check("turning it back OFF after a restart still reaches the server and persists", storedOff === "0", String(storedOff));
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

  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "token-conservation-lab-"));
  let browser;
  let succeeded = false;
  try {
    await boot({ dataDir, port: PORT });
    browser = await loadChromium().launch();

    await verifyDesktop(browser, dataDir);

    // Reuse the same DATA_DIR across a real process death — proves the setting is read from kv at
    // request time, not cached in a process-lifetime variable that a restart would silently reset.
    killInstance(PORT);
    await boot({ dataDir, port: PORT });
    await verifyRestart(browser, dataDir);

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
