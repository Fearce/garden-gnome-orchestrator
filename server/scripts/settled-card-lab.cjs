#!/usr/bin/env node
// Real-browser acceptance lab for settled cards: done / failed / cancelled cards recede on the board so the
// live and waiting ones stand out, and hovering or opening a settled card brings it back to full strength.
// Drives the built UI against a throwaway database and ports — never production or a live agent.
//   npx tsc -p tsconfig.json --outDir .settled-lab-dist && GGO_LAB_ENTRY=.settled-lab-dist/index.js npm run settled-card-lab

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { SERVER_ROOT, loadChromium, authPassword, requireBuild, boot, killInstance, createChecks, isVoiceBridgeNoise } = require("./lab-harness.cjs");

const Database = require(path.join(SERVER_ROOT, "node_modules", "better-sqlite3"));
const PORT = 4396;
const BASE = `http://127.0.0.1:${PORT}`;
const DATA_DIR = path.join(os.tmpdir(), "gg-settled-card-lab");
const DB_FILE = path.join(DATA_DIR, "orchestrator.sqlite");
const MINUTE = 60_000;
const TASKS = [
  { id: "settled-lab-live", title: "Implementing the export fix", state: "implementing", settled: false },
  { id: "settled-lab-review", title: "Review the parser change", state: "review", settled: false },
  { id: "settled-lab-paused", title: "Paused migration work", state: "paused", settled: false },
  { id: "settled-lab-done", title: "Shipped the release checklist", state: "done", settled: true },
  { id: "settled-lab-failed", title: "Failed flaky-test hunt", state: "failed", settled: true },
  { id: "settled-lab-cancelled", title: "Cancelled logo tweak", state: "cancelled", settled: true },
];

const check = createChecks();
const card = (id) => `[data-thread-id="${id}"]`;

async function waitForSchema() {
  for (let i = 0; i < 60; i++) {
    try {
      const db = new Database(DB_FILE);
      const ready = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'threads'").get();
      db.close();
      if (ready) return;
    } catch {
      /* boot is still migrating */
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error("throwaway database never gained a threads table");
}

function seed() {
  const db = new Database(DB_FILE);
  const now = Date.now();
  const insert = db.prepare(
    `INSERT INTO threads(id, title, state, workspace, brief, raw_prompt, created_at, updated_at)
     VALUES(?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  TASKS.forEach((t, i) => insert.run(t.id, t.title, t.state, SERVER_ROOT, t.title, t.title, now - (i + 1) * MINUTE, now - i * MINUTE));
  db.close();
}

/** The card's title opacity once its 0.14s fade has settled on `want`, or whatever it reads after 2s. */
async function titleOpacity(page, id, want) {
  const sel = `${card(id)} .title`;
  await page.waitForFunction(([s, value]) => getComputedStyle(document.querySelector(s)).opacity === value, [sel, want], { timeout: 2_000 }).catch(() => {});
  return page.$eval(sel, (el) => getComputedStyle(el).opacity);
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
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();
    page.on("pageerror", (error) => errors.push(String(error)));
    page.on("console", (message) => {
      if (message.type() === "error" && !isVoiceBridgeNoise(message)) errors.push(message.text());
    });
    await page.request.post(`${BASE}/api/login`, { data: { password: authPassword() } });
    await page.goto(`${BASE}/`, { timeout: 45_000 });
    for (const t of TASKS) await page.waitForSelector(card(t.id), { timeout: 30_000 });
    await page.mouse.move(2, 2);

    for (const t of TASKS) {
      const settled = await page.$eval(card(t.id), (el) => el.classList.contains("settled"));
      check(`${t.state} card is ${t.settled ? "" : "not "}marked settled`, settled === t.settled);
      const opacity = Number(await titleOpacity(page, t.id, t.settled ? "0.5" : "1"));
      check(`${t.state} card title reads at ${t.settled ? "reduced" : "full"} strength`, t.settled ? opacity < 0.7 : opacity === 1, String(opacity));
    }
    await page.screenshot({ path: path.join(DATA_DIR, "settled-board.png") });

    await page.hover(card("settled-lab-done"));
    check("hovering a settled card restores it", (await titleOpacity(page, "settled-lab-done", "1")) === "1");
    const dismiss = await page.$eval(`${card("settled-lab-done")} .card-dismiss`, (el) => getComputedStyle(el).opacity);
    check("its close button still appears on hover", dismiss === "1", dismiss);

    await page.click(`${card("settled-lab-done")} .title`);
    await page.waitForSelector(".detail", { timeout: 10_000 });
    await page.mouse.move(2, 2);
    check("an open settled card stays at full strength", (await titleOpacity(page, "settled-lab-done", "1")) === "1");
    const ring = await page.$eval(card("settled-lab-done"), (el) => getComputedStyle(el).boxShadow);
    check("an open settled card keeps its selection ring", ring !== "none", ring);
    await page.screenshot({ path: path.join(DATA_DIR, "settled-selected.png") });
    await context.close();

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
  console.error("settled card lab error:", error);
  killInstance(PORT);
  process.exit(2);
});
