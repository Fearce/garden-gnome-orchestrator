#!/usr/bin/env node
// Real-browser acceptance lab for pinned tasks: pin an old finished task from its card, see it lead the
// board, survive a reload, and fall back into the sort when unpinned; then the same toggle by touch.
// Drives the built UI against a throwaway database and ports — never production or a live agent.
//   npx tsc -p tsconfig.json --outDir .pin-lab-dist && GGO_LAB_ENTRY=.pin-lab-dist/index.js npm run pin-lab

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { SERVER_ROOT, loadChromium, authPassword, requireBuild, boot, killInstance, createChecks, isVoiceBridgeNoise } = require("./lab-harness.cjs");

const Database = require(path.join(SERVER_ROOT, "node_modules", "better-sqlite3"));
const PORT = 4398;
const BASE = `http://127.0.0.1:${PORT}`;
const DATA_DIR = path.join(os.tmpdir(), "gg-pin-lab");
const DB_FILE = path.join(DATA_DIR, "orchestrator.sqlite");
const DAY = 24 * 60 * 60 * 1000;
const OLD_TASK = "pin-lab-old-done";
// Newest first under the default sort, so the old finished task starts at the back.
const TASKS = [
  { id: "pin-lab-review", title: "Review the export fix", state: "review", ageDays: 0 },
  { id: "pin-lab-paused", title: "Paused migration work", state: "paused", ageDays: 3 },
  { id: OLD_TASK, title: "Reference: the release checklist", state: "done", ageDays: 45 },
];

const check = createChecks();

async function waitForSchema() {
  for (let i = 0; i < 60; i++) {
    try {
      const db = new Database(DB_FILE);
      const ready = db.prepare("SELECT name FROM pragma_table_info('threads') WHERE name = 'pinned_at'").get();
      db.close();
      if (ready) return;
    } catch {
      /* boot is still migrating */
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error("throwaway database never gained threads.pinned_at — is GGO_LAB_ENTRY a build with the pin column?");
}

function seed() {
  const db = new Database(DB_FILE);
  const now = Date.now();
  const insert = db.prepare(
    `INSERT INTO threads(id, title, state, workspace, brief, raw_prompt, created_at, updated_at)
     VALUES(?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const t of TASKS) insert.run(t.id, t.title, t.state, SERVER_ROOT, t.title, t.title, now - t.ageDays * DAY, now - t.ageDays * DAY + 60_000);
  db.close();
}

function readOldTask() {
  const db = new Database(DB_FILE, { readonly: true });
  const row = db.prepare("SELECT pinned_at AS pinnedAt, updated_at AS updatedAt FROM threads WHERE id = ?").get(OLD_TASK);
  db.close();
  return row;
}

async function waitForPin(pinned, timeoutMs = 10_000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if ((readOldTask().pinnedAt != null) === pinned) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return false;
}

const boardOrder = (page) => page.$$eval(".lanes [data-thread-id]", (els) => els.map((el) => el.getAttribute("data-thread-id")));
const pinOf = (id) => `[data-thread-id="${id}"] .card-pin`;

/** The pin's opacity once its 0.12s fade has settled on `want`, or whatever it reads after 2s. */
async function pinOpacity(page, id, want) {
  await page.waitForFunction(([sel, value]) => getComputedStyle(document.querySelector(sel)).opacity === value, [pinOf(id), want], { timeout: 2_000 }).catch(() => {});
  return page.$eval(pinOf(id), (el) => getComputedStyle(el).opacity);
}

async function waitForLead(page, id) {
  await page.waitForFunction((want) => document.querySelector(".lanes [data-thread-id]")?.getAttribute("data-thread-id") === want, id, { timeout: 10_000 });
}

async function open(browser, errors, options) {
  const context = await browser.newContext(options);
  const page = await context.newPage();
  page.on("pageerror", (error) => errors.push(String(error)));
  page.on("console", (message) => {
    if (message.type() === "error" && !isVoiceBridgeNoise(message)) errors.push(message.text());
  });
  await page.request.post(`${BASE}/api/login`, { data: { password: authPassword() } });
  await page.goto(`${BASE}/`, { timeout: 45_000 });
  await page.waitForSelector(`[data-thread-id="${OLD_TASK}"]`, { timeout: 30_000 });
  return { context, page };
}

async function desktopPass(browser, errors) {
  console.log("\nDesktop — pin, reload, unpin\n");
  const { context, page } = await open(browser, errors, { viewport: { width: 1440, height: 900 } });
  check("the old finished task starts at the back of the board", (await boardOrder(page)).at(-1) === OLD_TASK, (await boardOrder(page)).join(", "));
  check("an unpinned card hides its pin until hovered", (await pinOpacity(page, OLD_TASK, "0")) === "0");
  const before = readOldTask();

  await page.hover(`[data-thread-id="${OLD_TASK}"]`);
  check("hovering the card reveals the pin", (await pinOpacity(page, OLD_TASK, "1")) === "1");
  await page.click(pinOf(OLD_TASK));
  check("the pin persists on the server", await waitForPin(true));
  check("pinning leaves updated_at alone", readOldTask().updatedAt === before.updatedAt, `${before.updatedAt} -> ${readOldTask().updatedAt}`);
  await waitForLead(page, OLD_TASK);
  check("the pinned task now leads the board", (await boardOrder(page))[0] === OLD_TASK, (await boardOrder(page)).join(", "));
  check("the card did not open its detail panel", !(await page.$(".detail")));
  await page.mouse.move(5, 5);
  check("a pinned card keeps its pin lit without hover", (await pinOpacity(page, OLD_TASK, "1")) === "1");
  check("the toggle reports pressed", (await page.getAttribute(pinOf(OLD_TASK), "aria-pressed")) === "true");
  await page.screenshot({ path: path.join(DATA_DIR, "pin-desktop.png") });

  await page.reload({ timeout: 45_000 });
  await page.waitForSelector(`[data-thread-id="${OLD_TASK}"]`, { timeout: 30_000 });
  check("the pin survives a reload", (await boardOrder(page))[0] === OLD_TASK, (await boardOrder(page)).join(", "));

  await page.click('.sort-trigger');
  await page.click('.sort-list [role="option"]:has-text("Alphabetical")');
  await page.waitForFunction(() => document.querySelector(".sort-label")?.textContent === "Alphabetical", null, { timeout: 5_000 });
  const alpha = await boardOrder(page);
  check("it still leads under another sort", alpha[0] === OLD_TASK && alpha[1] === "pin-lab-paused", alpha.join(", "));

  await page.click(pinOf(OLD_TASK));
  check("unpinning persists", await waitForPin(false));
  await page.waitForFunction((id) => document.querySelector(`[data-thread-id="${id}"] .card-pin`)?.getAttribute("aria-pressed") === "false", OLD_TASK, { timeout: 10_000 });
  const unpinned = await boardOrder(page);
  check("unpinned, it falls back into the alphabetical order", unpinned.join(",") === ["pin-lab-paused", OLD_TASK, "pin-lab-review"].join(","), unpinned.join(", "));
  await context.close();
}

async function touchPass(browser, errors) {
  console.log("\nTablet 1024×1366 touch — the pin is reachable without hover\n");
  const { context, page } = await open(browser, errors, { viewport: { width: 1024, height: 1366 }, isMobile: true, hasTouch: true });
  check("the pin is visible with no hover", (await pinOpacity(page, OLD_TASK, "1")) === "1");
  const box = await page.locator(pinOf(OLD_TASK)).boundingBox();
  check("the pin is a comfortable touch target", !!box && box.width >= 34 && box.height >= 34, JSON.stringify(box));
  await page.tap(pinOf(OLD_TASK));
  check("a tap pins it", await waitForPin(true));
  await waitForLead(page, OLD_TASK);
  check("and it leads the board", (await boardOrder(page))[0] === OLD_TASK);
  check("the tap did not open the task", !(await page.$(".detail")));
  await page.screenshot({ path: path.join(DATA_DIR, "pin-tablet.png") });
  await context.close();
}

async function main() {
  requireBuild();
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
  fs.mkdirSync(DATA_DIR, { recursive: true });
  killInstance(PORT);

  let child;
  let browser;
  const errors = [];
  try {
    child = await boot({ dataDir: DATA_DIR, port: PORT, env: { CAP_RETRY_MS: "0", ACCOUNT_PING_MS: "3600000", FAST_ACCOUNT_PING_MS: "3600000" } });
    await waitForSchema();
    seed();
    browser = await loadChromium().launch();
    await desktopPass(browser, errors);
    await touchPass(browser, errors);
    check("no browser console errors", errors.length === 0, errors.slice(0, 4).join(" | "));
    console.log(`\nscreenshots: ${DATA_DIR}`);
  } finally {
    await browser?.close().catch(() => {});
    child?.kill();
    killInstance(PORT);
  }
  process.exit(check.summary());
}

main().catch((error) => {
  console.error("pin lab error:", error);
  killInstance(PORT);
  process.exit(2);
});
