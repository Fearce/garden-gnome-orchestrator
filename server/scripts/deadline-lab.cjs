#!/usr/bin/env node
// Real-browser acceptance lab for active-task deadlines and the compact phone reading layout.
// It drives the built UI against a throwaway database/ports, never production or a live agent.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { SERVER_ROOT, loadChromium, authPassword, requireBuild, boot, killInstance, createChecks } = require("./lab-harness.cjs");

const Database = require(path.join(SERVER_ROOT, "node_modules", "better-sqlite3"));
const PORT = 4397;
const BASE = `http://127.0.0.1:${PORT}`;
const DATA_DIR = path.join(os.tmpdir(), "gg-deadline-lab");
const TASK_ID = "deadline-lab-task";
const DB_FILE = path.join(DATA_DIR, "orchestrator.sqlite");

const check = createChecks();

async function waitForSchema() {
  for (let i = 0; i < 60; i++) {
    try {
      const db = new Database(DB_FILE);
      const ready = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='threads'").get();
      db.close();
      if (ready) return;
    } catch {
      /* boot is still migrating */
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error("throwaway database never gained the threads schema");
}

function seed() {
  const db = new Database(DB_FILE);
  const now = Date.now();
  db.prepare(
    `INSERT INTO threads(id, title, state, workspace, brief, raw_prompt, created_at, updated_at)
     VALUES(?, ?, 'review', ?, ?, ?, ?, ?)`,
  ).run(TASK_ID, "A long-lived task with an operator budget", SERVER_ROOT, "Keep the work safe and bounded.", "Keep the work safe and bounded.", now, now);

  const message = db.prepare(
    `INSERT INTO messages(id, thread_id, role, kind, content, attachments, created_at)
     VALUES(?, ?, ?, 'text', ?, '[]', ?)`,
  );
  for (let i = 0; i < 8; i++) {
    message.run(`message-${i}`, TASK_ID, i % 2 ? "implementor" : "director", `Readable transcript paragraph ${i + 1}: this content must retain most of the phone viewport.`, now + i);
  }

  const finding = db.prepare(
    `INSERT INTO findings(id, thread_id, from_role, kind, summary, detail, path, label, severity, routed, created_at)
     VALUES(?, ?, 'implementor', 'deliverable', ?, ?, ?, ?, 'info', 0, ?)`,
  );
  for (let i = 1; i <= 4; i++) {
    finding.run(`deliverable-${i}`, TASK_ID, `Artifact ${i}`, "A seeded file used only to verify the compact disclosure.", path.join(SERVER_ROOT, "README.md"), `Artifact ${i}`, now + 20 + i);
  }
  db.close();
}

function readDeadline() {
  const db = new Database(DB_FILE, { readonly: true });
  const row = db.prepare("SELECT active_deadline_at AS deadline FROM threads WHERE id = ?").get(TASK_ID);
  db.close();
  return row?.deadline ?? null;
}

async function waitForDeadline(predicate, timeoutMs = 10_000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const value = readDeadline();
    if (predicate(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return readDeadline();
}

async function loginAndOpen(page) {
  await page.request.post(`${BASE}/api/login`, { data: { password: authPassword() } });
  await page.goto(`${BASE}/`, { timeout: 45_000 });
  await page.waitForSelector(".accounts .acct", { timeout: 30_000 });
  await page.waitForSelector(`[data-thread-id="${TASK_ID}"]`, { timeout: 30_000 });
  await page.click(`[data-thread-id="${TASK_ID}"]`);
  await page.waitForSelector(".detail", { timeout: 15_000 });
}

function captureErrors(page, into) {
  page.on("pageerror", (error) => into.push(String(error)));
  page.on("console", (message) => {
    if (message.type() === "error") into.push(message.text());
  });
}

async function desktopPass(browser, errors) {
  console.log("\nDesktop — set, edit, collapse, reload, clear\n");
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  captureErrors(page, errors);
  await loginAndOpen(page);

  check("deadline control lives inside the expanded task header", await page.$eval(".detail-head .deadline-panel", (el) => !!el));
  check("there is no standalone deadline panel in the feed chrome", (await page.$$(".detail > .deadline-panel")).length === 0);
  await page.click(".deadline-edit");
  check("absolute-time input is available", !!(await page.$('input[aria-label="Exact hard deadline"]')));
  const before = Date.now();
  await page.click('[data-deadline-minutes="180"]');
  const setAt = await waitForDeadline((value) => value >= before + 179 * 60_000 && value <= Date.now() + 181 * 60_000);
  check("3h preset round-trips through the server", setAt >= before + 179 * 60_000, String(setAt));
  check("the card gains a live hard-deadline badge", !!(await page.$(`[data-thread-id="${TASK_ID}"] .deadline-badge`)));

  await page.click(".head-toggle");
  check("collapsing the header hides the deadline control", (await page.$$(".deadline-panel")).length === 0);
  await page.reload({ timeout: 45_000 });
  await page.waitForSelector(".accounts .acct", { timeout: 30_000 });
  await page.click(`[data-thread-id="${TASK_ID}"]`);
  check("collapsed-header preference survives reload", (await page.$$(".deadline-panel")).length === 0);
  await page.click(".head-toggle");
  await page.waitForSelector(".deadline-left");
  check("persisted deadline returns with a countdown", /left/.test(await page.$eval(".deadline-left", (el) => el.textContent || "")));

  await page.click(".deadline-edit");
  const editBefore = Date.now();
  await page.click('[data-deadline-minutes="360"]');
  const edited = await waitForDeadline((value) => value >= editBefore + 359 * 60_000);
  check("editing replaces the persisted deadline", edited > setAt && edited >= editBefore + 359 * 60_000, `${setAt} -> ${edited}`);
  await page.click(".deadline-clear");
  check("clear round-trips to NULL", (await waitForDeadline((value) => value == null)) == null, String(readDeadline()));
  check("clear removes the card badge", (await page.$$(`[data-thread-id="${TASK_ID}"] .deadline-badge`)).length === 0);
  await context.close();
}

async function mobilePass(browser, errors) {
  console.log("\nPhone 390×844 touch — reading space, disclosures, header deadline\n");
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 3 });
  const page = await context.newPage();
  captureErrors(page, errors);
  await loginAndOpen(page);

  const media = await page.evaluate(() => ({ compact: matchMedia("(max-width: 899.98px)").matches, coarse: matchMedia("(pointer: coarse)").matches }));
  check("the pass really uses compact touch rules", media.compact && media.coarse, JSON.stringify(media));
  check("phone detail opens in collapsed-header reading mode", (await page.$$(".deadline-panel")).length === 0);
  check("deliverables start as one collapsed disclosure", !!(await page.$(".deliverables.collapsed")) && (await page.$$(".deliverable-strip")).length === 0);
  check("message composer starts folded", !!(await page.$(".mobile-inject-toggle")) && !(await page.isVisible(".inject-bar")));

  const feedBox = await page.locator(".feed").boundingBox();
  check("collapsed chrome leaves most of the phone for transcript text", !!feedBox && feedBox.height >= 500, JSON.stringify(feedBox));
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
  check("the detail surface has no page-level horizontal overflow", overflow <= 1, String(overflow));

  await page.tap(".head-toggle");
  await page.waitForSelector(".deadline-panel");
  check("expanding the header reveals its deadline control", !!(await page.$(".detail-head .deadline-panel")));
  await page.tap(".deadline-edit");
  const targets = await page.$$eval(".deadline-preset", (els) => els.map((el) => Math.round(el.getBoundingClientRect().height)));
  check("all six deadline presets meet the 44px touch floor", targets.length === 6 && targets.every((height) => height >= 44), targets.join(","));
  const before = Date.now();
  await page.tap('[data-deadline-minutes="60"]');
  const mobileAt = await waitForDeadline((value) => value >= before + 59 * 60_000);
  check("phone 1h preset persists through the same server API", mobileAt >= before + 59 * 60_000, String(mobileAt));
  await page.tap(".head-toggle");
  check("the deadline disappears with the header after setting", (await page.$$(".deadline-panel")).length === 0);

  await page.tap(".deliverables-label");
  check("deliverables remain reachable on demand", await page.isVisible(".deliverable-strip"));
  await page.tap(".deliverables-label");
  check("deliverables fold back to one row", (await page.$$(".deliverable-strip")).length === 0);

  await page.tap(".mobile-inject-toggle");
  check("one tap restores the full message composer", await page.isVisible(".inject-bar"));
  await page.tap(".mobile-compose-close");
  check("the composer can be hidden again without losing the feed", !(await page.isVisible(".inject-bar")));

  // Clear through the phone header so the final throwaway state also covers the mobile edit path.
  await page.tap(".head-toggle");
  await page.tap(".deadline-clear");
  check("phone Clear persists NULL", (await waitForDeadline((value) => value == null)) == null);
  await page.screenshot({ path: path.join(DATA_DIR, "deadline-phone.png"), fullPage: false });
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
    console.log(`\nphone screenshot: ${path.join(DATA_DIR, "deadline-phone.png")}`);
  } finally {
    if (browser) await browser.close().catch(() => {});
    if (child) child.kill();
    killInstance(PORT);
  }
  process.exit(check.summary());
}

main().catch((error) => {
  console.error("deadline lab error:", error);
  killInstance(PORT);
  process.exit(2);
});
