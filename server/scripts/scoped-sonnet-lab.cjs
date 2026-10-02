// Verify the "Sonnet for well-scoped work" setting in an authenticated real browser without touching
// production: an alternate port, a temp DATA_DIR and bogus account tokens (lab-harness.cjs).
//
//   npm run scoped-sonnet-lab --prefix server
//   npm run scoped-sonnet-lab --prefix server -- --keep
//
// test:scoped-sonnet proves the dispatch resolution; this lab proves the owner-facing control renders
// in the Auto model selection group, round-trips through the WebSocket to SQLite, survives a restart,
// and that a subscription's per-role models read "Auto (…)" naming the Sonnet line while it is on.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Database = require("better-sqlite3");
const { loadChromium, authPassword, requireBuild, requireFreshWebBuild, boot, killInstance, createChecks } = require("./lab-harness.cjs");

const PORT = 4551;
const BASE = `http://127.0.0.1:${PORT}`;
const NAV_TIMEOUT = 45_000;
const KV_KEY = "setting_scoped_sonnet_routing";
const SETTINGS = '[role="dialog"][aria-label="Settings"]';
const GROUP = '.settings-group:has(.settings-group-label:text-is("Auto model selection"))';
const TOGGLE = 'button.switch[aria-label="Sonnet for well-scoped work"]';
const SUB_CARD = '.sub-card:has(button.switch[aria-label$=" account"]):has(button.sub-disclosure)';

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

async function openSettings(page, category, { login = false } = {}) {
  if (login) {
    const response = await page.request.post(`${BASE}/api/login`, { data: { password: authPassword() } });
    if (!response.ok()) throw new Error(`login failed with HTTP ${response.status()}`);
  }
  await page.goto(`${BASE}/`, { timeout: NAV_TIMEOUT });
  // Settings are server-authoritative. The account chip only appears after the WebSocket hello frame.
  await page.waitForSelector(".accounts .acct", { state: "attached", timeout: 25_000 });
  await page.click('[aria-label="Open settings"]');
  await page.waitForSelector(SETTINGS, { timeout: 20_000 });
  await showCategory(page, category);
}

async function showCategory(page, category) {
  await page.click(`[data-settings-category="${category}"]`);
}

const toggleState = (page) => page.getAttribute(TOGGLE, "aria-checked");

/** The Auto option label of each per-role model select on the first Claude subscription card. */
async function autoLabels(page) {
  const card = page.locator(SUB_CARD).first();
  const disclosure = card.locator("button.sub-disclosure");
  if (!(await disclosure.getAttribute("class")).includes("open")) await disclosure.click();
  const rows = card.locator(".sub-model-row");
  const labels = {};
  for (let i = 0; i < (await rows.count()); i++) {
    const row = rows.nth(i);
    labels[(await row.locator(".sub-model-label").innerText()).trim().toLowerCase()] = (await row.locator('select option[value=""]').innerText()).trim();
  }
  return { disclosure: (await disclosure.innerText()).replace(/\s+/g, " ").trim(), labels };
}

async function verifyOn(browser, dataDir) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  try {
    const page = await context.newPage();
    await openSettings(page, "pipeline", { login: true });
    await page.waitForSelector(GROUP, { timeout: 10_000 });
    check("the toggle renders once, inside the Auto model selection group", (await page.locator(`${GROUP} ${TOGGLE}`).count()) === 1);
    check("a fresh installation defaults it ON", (await toggleState(page)) === "true", await toggleState(page));
    check("kv has no row yet on a fresh install", readPersisted(dataDir) === null, String(readPersisted(dataDir)));
    const hint = (await page.locator(`${GROUP} .settings-row:has(${TOGGLE})`).innerText()).replace(/\s+/g, " ");
    const mustName = ["Sonnet 5.5", "Opus 5.5", "goal steps", "route note", "always wins", "continues on Opus"];
    check("the hint names both models, what stays on Opus, the precedence and the fallback", mustName.every((part) => hint.includes(part)), hint);

    await showCategory(page, "subscriptions");
    const on = await autoLabels(page);
    check("an untouched per-role matrix reads 'all on Auto'", on.disclosure.endsWith("all on Auto"), on.disclosure);
    check(
      "implementor and QA name the Sonnet line on Auto",
      on.labels.implementor === "Auto (claude-opus-5-5, Sonnet 5.5 when well-scoped)" && on.labels.qa === "Auto (claude-opus-5-5, Sonnet 5.5 when well-scoped)",
      JSON.stringify(on.labels),
    );
    check("director and planner read plain Auto on Opus", on.labels.director === "Auto (claude-opus-5-5)" && on.labels.planner === "Auto (claude-opus-5-5)", JSON.stringify(on.labels));
    await page.screenshot({ path: path.join(os.tmpdir(), "scoped-sonnet-lab-matrix.png") });

    await showCategory(page, "pipeline");
    await page.click(TOGGLE);
    const stored = await waitForPersisted(dataDir, "0");
    check("turning it OFF reaches the server and persists in kv", stored === "0", String(stored));
    await showCategory(page, "subscriptions");
    const off = await autoLabels(page);
    check("switched off, implementor's Auto reads plain Opus", off.labels.implementor === "Auto (claude-opus-5-5)", JSON.stringify(off.labels));
  } finally {
    await context.close();
  }
}

async function verifyRestart(browser, dataDir) {
  const context = await browser.newContext({ viewport: { width: 1200, height: 800 } });
  try {
    const page = await context.newPage();
    await openSettings(page, "pipeline", { login: true });
    await page.waitForSelector(TOGGLE, { timeout: 10_000 });
    check("OFF survives a real throwaway-server restart", (await toggleState(page)) === "false", await toggleState(page));
    await page.click(TOGGLE);
    const stored = await waitForPersisted(dataDir, "1");
    check("turning it back ON after a restart persists", stored === "1", String(stored));
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
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "scoped-sonnet-lab-"));
  let browser;
  let succeeded = false;
  try {
    await boot({ dataDir, port: PORT });
    browser = await loadChromium().launch();
    await verifyOn(browser, dataDir);
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
