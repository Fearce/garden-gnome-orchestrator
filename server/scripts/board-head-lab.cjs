#!/usr/bin/env node
// Real-browser acceptance lab for the board header: the sort menu, "New Co-work" and the Hide done
// checkbox stay clear of an open detail pane at every desktop band; Hide done hides finished tasks and
// survives a reload; Settings → Interface → Board tabs hides individual areas (never Tasks) from the
// desktop strip, the narrow-board area select and the phone's area menu; dragging a header tab or moving
// it in Settings → Tab order reorders every one of those. Throwaway instance only.
//   npx tsc -p tsconfig.json --outDir .board-head-lab-dist
//   (cd ../web && npx vite build --outDir ../server/.lab-web-dist-board-head --emptyOutDir)
//   GGO_LAB_ENTRY=.board-head-lab-dist/index.js GGO_LAB_WEB_DIST=.lab-web-dist-board-head npm run board-head-lab -- --shots data/board-head-lab-shots

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { SERVER_ROOT, loadChromium, authPassword, requireBuild, boot, killInstance, createChecks, shotDir, isVoiceBridgeNoise } = require("./lab-harness.cjs");

const Database = require(path.join(SERVER_ROOT, "node_modules", "better-sqlite3"));
const PORT = 4492;
const BASE = `http://127.0.0.1:${PORT}`;
const DATA_DIR = path.join(os.tmpdir(), "gg-board-head-lab");
const DB_FILE = path.join(DATA_DIR, "orchestrator.sqlite");
const OPEN_TASK = "bh-lab-review";
const DONE_TASK = "bh-lab-done";
const WIDTHS = [1000, 1100, 1280, 1440, 1600, 1920, 2560];

const check = createChecks();

async function waitForSchema() {
  for (let i = 0; i < 100; i++) {
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
  insert.run(OPEN_TASK, "Audit account online with a deliberately long title", "review", SERVER_ROOT, "x", "x", now, now);
  insert.run(DONE_TASK, "Finished release checklist", "done", SERVER_ROOT, "x", "x", now - 60_000, now - 60_000);
  db.close();
}

async function open(context, errors) {
  const page = await context.newPage();
  page.on("pageerror", (error) => errors.push(String(error)));
  page.on("console", (message) => {
    if (message.type() === "error" && !isVoiceBridgeNoise(message)) errors.push(message.text());
  });
  await page.request.post(`${BASE}/api/login`, { data: { password: authPassword() } });
  await page.goto(`${BASE}/`, { timeout: 60_000 });
  await page.waitForSelector(".accounts .acct", { state: "attached", timeout: 60_000 });
  await page.waitForSelector(`[data-thread-id="${OPEN_TASK}"]`, { timeout: 30_000 });
  return page;
}

/** Every header control's box against the board's content box and the detail pane's left edge. */
const headGeometry = (page) =>
  page.evaluate(() => {
    const box = (el) => el.getBoundingClientRect();
    const board = document.querySelector(".board");
    const style = getComputedStyle(board);
    const b = box(board);
    const contentRight = b.right - parseFloat(style.paddingRight);
    const detail = document.querySelector(".detail");
    const detailLeft = detail ? box(detail).left : Infinity;
    const controls = [...document.querySelectorAll(".board-head-right > *")].map((el) => {
      const r = box(el);
      return { cls: el.className || el.tagName, left: Math.round(r.left), right: Math.round(r.right), visible: r.width > 0 && r.height > 0 };
    });
    return { contentRight: Math.round(contentRight), detailLeft: Math.round(detailLeft), controls, headHeight: Math.round(box(document.querySelector(".board-head")).height) };
  });

async function geometryPass(browser, errors, shots) {
  console.log("\nHeader controls clear of the open detail pane\n");
  for (const width of WIDTHS) {
    const context = await browser.newContext({ viewport: { width, height: 900 } });
    const page = await open(context, errors);
    await page.click(`[data-thread-id="${OPEN_TASK}"]`);
    await page.waitForSelector(".detail", { timeout: 20_000 });
    await page.waitForTimeout(400);
    const g = await headGeometry(page);
    const limit = Math.min(g.contentRight, g.detailLeft) + 1;
    const escaped = g.controls.filter((c) => !c.visible || c.right > limit);
    check(`${width}px: all ${g.controls.length} header controls sit inside the board, left of the pane`, g.controls.length >= 4 && escaped.length === 0, JSON.stringify({ limit, escaped }));
    check(`${width}px: the header stays compact (≤ 3 rows)`, g.headHeight <= 130, `${g.headHeight}px`);
    const cowork = page.locator(".board-head-right .cowork-new");
    let clickable = false;
    try {
      await cowork.click({ trial: true, timeout: 3_000 });
      clickable = true;
    } catch {
      /* covered */
    }
    check(`${width}px: "New Co-work" receives the click (nothing covers it)`, clickable);
    if (shots) await page.screenshot({ path: path.join(shots, `head-${width}.png`) });
    await context.close();
  }
}

const cardIds = (page) => page.$$eval(".lanes [data-thread-id]", (els) => els.map((el) => el.getAttribute("data-thread-id")));

async function hideDonePass(browser, errors, shots) {
  console.log("\nHide done checkbox\n");
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await open(context, errors);
  const box = page.locator(".hide-done input");
  check("the checkbox starts unchecked and the done task is on the board", !(await box.isChecked()) && (await cardIds(page)).includes(DONE_TASK));
  await box.check();
  await page.waitForFunction((id) => !document.querySelector(`.lanes [data-thread-id="${id}"]`), DONE_TASK, { timeout: 5_000 }).catch(() => {});
  const after = await cardIds(page);
  check("checking it hides the done task and keeps the review task", !after.includes(DONE_TASK) && after.includes(OPEN_TASK), after.join(", "));
  const count = await page.textContent(".board-head-right .faint");
  check("the header says how many are hidden", /1 completed hidden/.test(count ?? ""), count);
  if (shots) await page.screenshot({ path: path.join(shots, "hide-done-on.png") });

  await page.reload({ timeout: 60_000 });
  await page.waitForSelector(`[data-thread-id="${OPEN_TASK}"]`, { timeout: 30_000 });
  check("it survives a reload", (await page.locator(".hide-done input").isChecked()) && !(await cardIds(page)).includes(DONE_TASK));

  await page.click('[aria-label="Open settings"]');
  await page.click('[data-settings-category="interface"]');
  const sw = page.locator('[role="switch"][aria-label="Show completed tasks"]');
  check("Settings' Show completed tasks mirrors it (off)", (await sw.getAttribute("aria-checked")) === "false");
  await sw.click();
  await page.keyboard.press("Escape");
  await page.waitForSelector('[role="dialog"][aria-label="Settings"]', { state: "detached", timeout: 5_000 }).catch(() => {});
  check("turning the setting back on unticks the checkbox and restores the task", !(await page.locator(".hide-done input").isChecked()) && (await cardIds(page)).includes(DONE_TASK));
  await context.close();
}

const stripTabs = (page) =>
  page.$$eval(".board-tabs > *", (els) => els.map((el) => el.textContent.replace(/\d+$/, "").trim().toLowerCase()));

async function setTab(page, label, on) {
  await page.click('[aria-label="Open settings"]');
  await page.click('[data-settings-category="interface"]');
  const sw = page.locator(`[role="switch"][aria-label="${label} tab"]`);
  if ((await sw.getAttribute("aria-checked")) !== String(on)) await sw.click();
  await page.keyboard.press("Escape");
  await page.waitForSelector('[role="dialog"][aria-label="Settings"]', { state: "detached", timeout: 5_000 }).catch(() => {});
}

async function tabTogglePass(browser, errors, shots) {
  console.log("\nSettings → Board tabs\n");
  const context = await browser.newContext({ viewport: { width: 1920, height: 1000 } });
  const page = await open(context, errors);
  const before = await stripTabs(page);
  check("every area starts visible", ["tasks", "ide", "notes", "scheduled tasks", "goals", "supervisor", "patch notes"].every((t) => before.includes(t)), before.join(" | "));

  await page.click('[aria-label="Open settings"]');
  await page.click('[data-settings-category="interface"]');
  const labels = await page.$$eval('[data-settings-category-panel="interface"] [role="switch"], [role="switch"]', (els) => els.map((el) => el.getAttribute("aria-label")));
  check("there is no switch for the Tasks tab", !labels.includes("Tasks tab") && labels.includes("Goals tab") && labels.includes("Patch notes tab"));
  if (shots) await page.locator(".settings-group", { hasText: "Board tabs" }).screenshot({ path: path.join(shots, "settings-board-tabs.png") });
  await page.keyboard.press("Escape");
  await page.waitForSelector('[role="dialog"][aria-label="Settings"]', { state: "detached", timeout: 5_000 }).catch(() => {});

  await setTab(page, "Goals", false);
  await setTab(page, "Supervisor", false);
  const hidden = await stripTabs(page);
  check("Goals and Supervisor leave the strip; the rest stay", !hidden.includes("goals") && !hidden.includes("supervisor") && hidden.includes("notes") && hidden.includes("tasks"), hidden.join(" | "));

  await page.reload({ timeout: 60_000 });
  await page.waitForSelector(".accounts .acct", { state: "attached", timeout: 60_000 });
  const reloaded = await stripTabs(page);
  check("hidden tabs stay hidden after a reload", !reloaded.includes("goals") && !reloaded.includes("supervisor"), reloaded.join(" | "));
  if (shots) await page.screenshot({ path: path.join(shots, "tabs-hidden.png") });

  await page.click(".board-tab.bt-notes");
  await page.waitForSelector(".board-tabs > h2:has-text('Notes')", { timeout: 5_000 });
  await setTab(page, "Notes", false);
  const fellBack = await page.$eval(".board-tabs > h2", (el) => el.textContent.trim().toLowerCase());
  check("hiding the open tab returns the board to Tasks", fellBack === "tasks", fellBack);

  // A narrow board (detail open at 1100) swaps the strip for the area select; it reads the same list.
  await page.setViewportSize({ width: 1100, height: 900 });
  await page.click(`[data-thread-id="${OPEN_TASK}"]`);
  await page.waitForSelector(".board-area-select select", { state: "visible", timeout: 10_000 });
  const options = await page.$$eval(".board-area-select option", (els) => els.map((el) => el.value));
  check("the narrow-board area select leaves them out too", !options.includes("goals") && !options.includes("notes") && options.includes("tasks") && options.includes("ide"), options.join(","));

  await setTab(page, "Goals", true);
  await page.setViewportSize({ width: 1920, height: 1000 });
  await page.waitForFunction(() => [...document.querySelectorAll(".board-tabs > *")].some((el) => /goals/i.test(el.textContent)), null, { timeout: 5_000 }).catch(() => {});
  check("switching a tab back on restores it", (await stripTabs(page)).includes("goals"));
  await context.close();

  const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const p = await phone.newPage();
  p.on("pageerror", (error) => errors.push(String(error)));
  await p.request.post(`${BASE}/api/login`, { data: { password: authPassword() } });
  await p.addInitScript(() => localStorage.setItem("director_settings", JSON.stringify({ hiddenBoardTabs: ["supervisor", "patchnotes", "tasks"] })));
  await p.goto(`${BASE}/`, { timeout: 60_000 });
  await p.waitForSelector(".accounts .acct", { state: "attached", timeout: 60_000 });
  const phoneAreas = await p.$$eval('select[aria-label="All areas"] option', (els) => els.map((el) => el.value).filter(Boolean));
  check("the phone's All areas menu honours the setting, and a stored 'tasks' is ignored", !phoneAreas.includes("supervisor") && !phoneAreas.includes("patchnotes") && phoneAreas.includes("tasks") && phoneAreas.includes("goals"), phoneAreas.join(","));
  await phone.close();
}

/** Drags one header tab onto another with real mouse steps, past the strip's 6px activation distance. */
async function dragTab(page, from, onto) {
  const a = await page.locator(`.board-tabs > .bt-${from}`).boundingBox();
  const b = await page.locator(`.board-tabs > .bt-${onto}`).boundingBox();
  await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
  await page.mouse.down();
  for (let i = 1; i <= 12; i++) await page.mouse.move(a.x + a.width / 2 + ((b.x + 4 - a.x - a.width / 2) * i) / 12, b.y + b.height / 2);
  await page.waitForTimeout(150);
  await page.mouse.up();
}

async function tabOrderPass(browser, errors, shots) {
  console.log("\nBoard tab order\n");
  const context = await browser.newContext({ viewport: { width: 1920, height: 1000 } });
  await context.addInitScript(() => {
    if (!sessionStorage.getItem("bh-seeded")) localStorage.setItem("director_settings", JSON.stringify({ shownModuleTabs: ["surveillance"] }));
    sessionStorage.setItem("bh-seeded", "1");
  });
  const page = await open(context, errors);
  await dragTab(page, "surveillance", "ide");
  await page.waitForTimeout(300);
  const dragged = await stripTabs(page);
  check("dragging Surveillance onto IDE makes it tab #2", dragged[0] === "tasks" && dragged[1] === "surveillance" && dragged[2] === "ide", dragged.join(" | "));
  const openAfterDrag = await page.$eval(".board-tabs > h2", (el) => el.textContent.trim().toLowerCase());
  check("releasing a drag does not open the dragged tab", openAfterDrag === "tasks", openAfterDrag);
  await page.click(".board-tab.bt-notes");
  const clicked = await page.waitForSelector(".board-tabs > h2:has-text('Notes')", { timeout: 5_000 }).then(() => true, () => false);
  check("a plain click on a tab still opens it", clicked);
  if (shots) await page.screenshot({ path: path.join(shots, "tabs-reordered.png"), clip: { x: 0, y: 0, width: 1920, height: 160 } });

  await page.reload({ timeout: 60_000 });
  await page.waitForSelector(".accounts .acct", { state: "attached", timeout: 60_000 });
  const reloaded = await stripTabs(page);
  check("the order survives a reload", reloaded[1] === "surveillance", reloaded.join(" | "));

  await page.click('[aria-label="Open settings"]');
  await page.click('[data-settings-category="interface"]');
  const rows = () => page.$$eval(".tab-order-row .tab-order-label", (els) => els.map((el) => el.textContent.trim().toLowerCase()));
  const listed = await rows();
  check("Settings lists every tab in that order, switched-off ones included", listed[1] === "surveillance" && listed.includes("sidekick") && listed.includes("script hub"), listed.join(" | "));
  await page.click('button[aria-label="Move Calendar earlier"]');
  const movedUp = await rows();
  check("Move earlier swaps a tab with its neighbour", movedUp.indexOf("calendar") === listed.indexOf("calendar") - 1, movedUp.join(" | "));
  if (shots) await page.locator(".settings-group", { hasText: "Tab order" }).screenshot({ path: path.join(shots, "settings-tab-order.png") });
  await page.keyboard.press("Escape");
  await page.waitForSelector('[role="dialog"][aria-label="Settings"]', { state: "detached", timeout: 5_000 }).catch(() => {});
  const strip = await stripTabs(page);
  check("the header follows a Settings move", strip.indexOf("calendar") >= 0 && strip.indexOf("calendar") < strip.indexOf("notes"), strip.join(" | "));

  await page.setViewportSize({ width: 1100, height: 900 });
  await page.click(`[data-thread-id="${OPEN_TASK}"]`);
  await page.waitForSelector(".board-area-select select", { state: "visible", timeout: 10_000 });
  const options = await page.$$eval(".board-area-select option", (els) => els.map((el) => el.value));
  check("the narrow-board area select uses the same order", options[1] === "surveillance" && options.indexOf("calendar") < options.indexOf("notes"), options.join(","));

  await page.click('[aria-label="Open settings"]');
  await page.click('[data-settings-category="interface"]');
  await page.click("button:has-text('Reset order')");
  const reset = await rows();
  check("Reset order restores the built-in order", reset[1] === "ide" && reset.indexOf("surveillance") > reset.indexOf("patch notes"), reset.join(" | "));
  await context.close();
}

async function main() {
  requireBuild();
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
  fs.mkdirSync(DATA_DIR, { recursive: true });
  killInstance(PORT);
  const shots = shotDir(DATA_DIR);

  let child;
  let browser;
  const errors = [];
  try {
    child = await boot({ dataDir: DATA_DIR, port: PORT, env: { CAP_RETRY_MS: "0", ACCOUNT_PING_MS: "3600000", FAST_ACCOUNT_PING_MS: "3600000" } });
    await waitForSchema();
    seed();
    browser = await loadChromium().launch();
    await geometryPass(browser, errors, shots);
    await hideDonePass(browser, errors, shots);
    await tabTogglePass(browser, errors, shots);
    await tabOrderPass(browser, errors, shots);
    check("no browser console errors", errors.length === 0, errors.slice(0, 4).join(" | "));
    console.log(`\nscreenshots: ${shots}`);
  } finally {
    await browser?.close().catch(() => {});
    child?.kill();
    killInstance(PORT);
  }
  process.exit(check.summary());
}

main().catch((error) => {
  console.error("board-head lab error:", error);
  killInstance(PORT);
  process.exit(2);
});
