#!/usr/bin/env node
// Real-browser acceptance lab for the per-task agent switches (planner / researcher / QA /
// self-improvement) in the task composer. Drives the built UI against a throwaway database and port —
// never production. The seeded task sits in `review` with no live agent, so no switch here can start one.
//
//   npm run task-agents-lab --prefix server

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { SERVER_ROOT, loadChromium, authPassword, requireBuild, boot, killInstance, createChecks } = require("./lab-harness.cjs");

const Database = require(path.join(SERVER_ROOT, "node_modules", "better-sqlite3"));
const PORT = 4401;
const BASE = `http://127.0.0.1:${PORT}`;
const DATA_DIR = path.join(os.tmpdir(), "gg-task-agents-lab");
const DB_FILE = path.join(DATA_DIR, "orchestrator.sqlite");
const TASK_ID = "task-agents-lab-task";
const TRIGGER = '[aria-label="Choose which agents run on this task"]';
const POPOVER = '[role="dialog"][aria-label="Task agents"]';

const check = createChecks();

async function waitForSchema() {
  for (let i = 0; i < 60; i++) {
    try {
      const db = new Database(DB_FILE);
      const ready = db.prepare("SELECT name FROM pragma_table_info('threads') WHERE name='role_toggles'").get();
      db.close();
      if (ready) return;
    } catch {
      /* boot is still migrating */
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error("throwaway database never gained the role_toggles column");
}

function seed() {
  const db = new Database(DB_FILE);
  const now = Date.now();
  db.prepare(
    `INSERT INTO threads(id, title, state, workspace, brief, raw_prompt, created_at, updated_at)
     VALUES(?, ?, 'review', ?, ?, ?, ?, ?)`,
  ).run(TASK_ID, "A task whose agents the owner steers", SERVER_ROOT, "Tidy the README wording.", "Tidy the README wording.", now, now);
  db.close();
}

function readToggles() {
  const db = new Database(DB_FILE, { readonly: true });
  const row = db.prepare("SELECT role_toggles FROM threads WHERE id = ?").get(TASK_ID);
  db.close();
  return row?.role_toggles ?? null;
}

/** The popover reflects a click optimistically; the ROW is the claim, so poll it (read-only, WAL-visible). */
async function waitForToggles(expected, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (readToggles() === expected) return expected;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return readToggles();
}

async function loginAndOpen(page) {
  await page.request.post(`${BASE}/api/login`, { data: { password: authPassword() } });
  await page.goto(`${BASE}/`, { timeout: 45_000 });
  await page.waitForSelector(".accounts .acct", { state: "attached", timeout: 30_000 });
  await page.waitForSelector(`[data-thread-id="${TASK_ID}"]`, { timeout: 30_000 });
  await page.click(`[data-thread-id="${TASK_ID}"]`);
  await page.waitForSelector(".detail", { timeout: 15_000 });
}

function captureErrors(page, into) {
  page.on("console", (message) => {
    if (message.type() === "error") into.push(message.text());
  });
  page.on("pageerror", (error) => into.push(String(error)));
}

function checkedChoices(page) {
  return page.$$eval(`${POPOVER} .task-agents-row`, (rows) =>
    Object.fromEntries(rows.map((row) => [row.getAttribute("data-role"), row.querySelector('[aria-checked="true"]')?.textContent?.trim() ?? null])),
  );
}

async function choose(page, role, label) {
  await page.click(`${POPOVER} .task-agents-row[data-role="${role}"] button:text-is("${label}")`);
}

async function desktopPass(browser, errors) {
  console.log("\nDesktop 1500×950 — switch, persist, notice, reload\n");
  const context = await browser.newContext({ viewport: { width: 1500, height: 950 } });
  const page = await context.newPage();
  captureErrors(page, errors);
  await loginAndOpen(page);

  check("the task agents control renders in the composer", (await page.locator(TRIGGER).count()) === 1);
  await page.click(TRIGGER);
  await page.waitForSelector(POPOVER);
  check("all four roles start on Auto", JSON.stringify(await checkedChoices(page)) === JSON.stringify({ planner: "Auto", researcher: "Auto", qa: "Auto", selfImprove: "Auto" }), JSON.stringify(await checkedChoices(page)));

  await choose(page, "qa", "Off");
  check("QA Off reaches the server", (await waitForToggles('{"qa":false}')) === '{"qa":false}', readToggles());
  await page.waitForSelector('.feed :text("QA switched off for this task")', { timeout: 10_000 });
  check("the feed carries the server's notice", true);
  await choose(page, "planner", "On");
  check("Planner On is stored beside it", (await waitForToggles('{"qa":false,"planner":true}')) === '{"qa":false,"planner":true}', readToggles());
  check("the trigger marks a task with overrides", await page.locator(`${TRIGGER}.pinned`).count() === 1);
  await page.locator(POPOVER).screenshot({ path: path.join(DATA_DIR, "task-agents-popover.png") });

  await page.reload({ timeout: 45_000 });
  await page.waitForSelector(".accounts .acct", { state: "attached", timeout: 30_000 });
  await page.click(`[data-thread-id="${TASK_ID}"]`);
  await page.waitForSelector(TRIGGER, { timeout: 15_000 });
  await page.click(TRIGGER);
  await page.waitForSelector(POPOVER);
  const reloaded = await checkedChoices(page);
  check("the switches survive a reload", reloaded.qa === "Off" && reloaded.planner === "On" && reloaded.researcher === "Auto", JSON.stringify(reloaded));

  await choose(page, "qa", "Auto");
  await choose(page, "planner", "Auto");
  check("Auto on both clears the stored switches", (await waitForToggles(null)) === null, readToggles());
  await page.keyboard.press("Escape");
  check("Escape closes the popover", (await page.locator(POPOVER).count()) === 0);
  await context.close();
}

async function mobilePass(browser, errors) {
  console.log("\nPhone 390×844 touch — both composer chips fit, popover stays on-screen\n");
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 3 });
  const page = await context.newPage();
  captureErrors(page, errors);
  await loginAndOpen(page);
  await page.tap(".mobile-inject-toggle");
  await page.waitForSelector(TRIGGER, { state: "visible", timeout: 10_000 });

  const boxes = await page.evaluate(() => {
    const rect = (sel) => {
      const r = document.querySelector(sel)?.getBoundingClientRect();
      return r ? { left: r.left, right: r.right, top: r.top, bottom: r.bottom } : null;
    };
    return {
      agents: rect(".task-agents-picker .task-model-trigger"),
      model: rect(".task-model-picker:not(.task-agents-picker) .task-model-trigger"),
      close: rect(".mobile-compose-close"),
    };
  });
  const apart = (a, b) => !!a && !!b && (a.right <= b.left || b.right <= a.left || a.bottom <= b.top || b.bottom <= a.top);
  check("the agents chip does not overlap the model chip", apart(boxes.agents, boxes.model), JSON.stringify(boxes));
  check("…nor the composer close button", apart(boxes.agents, boxes.close), JSON.stringify(boxes));

  await page.tap(TRIGGER);
  await page.waitForSelector(POPOVER);
  const pop = await page.locator(POPOVER).boundingBox();
  check("the popover stays inside the phone viewport", !!pop && pop.x >= 0 && pop.x + pop.width <= 390, JSON.stringify(pop));
  const targets = await page.$$eval(`${POPOVER} .segment button`, (els) => els.map((el) => Math.round(el.getBoundingClientRect().height)));
  check("every choice meets the compact touch floor (--tap-sm, 34px)", targets.length === 12 && targets.every((h) => h >= 34), targets.join(","));
  await page.tap(`${POPOVER} .task-agents-row[data-role="researcher"] button:text-is("Off")`);
  check("a phone tap persists too", (await waitForToggles('{"researcher":false}')) === '{"researcher":false}', readToggles());
  await page.screenshot({ path: path.join(DATA_DIR, "task-agents-phone.png") });
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
    await mobilePass(browser, errors);
    check("no browser console errors across desktop and phone", errors.length === 0, errors.slice(0, 4).join(" | "));
    console.log(`\nscreenshots: ${DATA_DIR}`);
  } finally {
    if (browser) await browser.close().catch(() => {});
    if (child) child.kill();
    killInstance(PORT);
  }
  process.exit(check.summary());
}

main().catch((error) => {
  console.error("task agents lab error:", error);
  killInstance(PORT);
  process.exit(2);
});
