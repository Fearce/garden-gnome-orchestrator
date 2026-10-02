// Lab for the iPhone task-layer navigation (`npm run ios-nav-lab`). The owner got stuck in a work memo
// on a phone and found closing a task confusing. Two causes, both only visible in a browser: the
// console wrote no history, so the Back gesture skipped every layer and left the app; and each layer's
// exit sat somewhere else (the task's ✕ bottom-right beside a look-alike chevron, the memo's small ×
// top-right under the status bar, the deliverable and diff previews with a third button).
//
// By the owner's call the fix is iPhone-only (web/src/lib/iosPhone.ts), so this lab drives three
// devices:
//   iPhone (390x664 and 320x568, iPhone UA, touch): the task, its work memo (from the pin and from the
//     final report), a deliverable preview and the diff all close by the same labelled Close in the
//     bottom-right corner; history Back closes the top layer and Forward reopens it; repeated
//     open/close does not grow history; the board's scroll and the feed's scroll survive the round
//     trip; the Close stays on screen with a long memo and with a short (keyboard-open) viewport.
//   Android phone (390x664, Pixel UA): negative control. No `ios-phone` class, no history entries, the
//     original controls.
//   Desktop (1440x900): negative control. No bar, the memo's × and Escape still close it.
//
//   npm run ios-nav-lab --prefix server
//   npm run ios-nav-lab --prefix server -- --keep --shots data/ios-nav-lab-shots
//
// Safe against prod: temp DATA_DIR, bogus tokens, its own port, killed by port owner (lab-harness.cjs).

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Database = require("better-sqlite3");
const { loadChromium, authPassword, requireBuild, boot, killInstance, createChecks, shotDir, isVoiceBridgeNoise } = require("./lab-harness.cjs");

const PORT = 5363;
const BASE = `http://127.0.0.1:${PORT}`;
const TASK_ID = "ios-nav-lab-task-000000000000001";
const TASK_TITLE = "Memo navigation task";
const FILLER = 12;
const IPHONE_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";
const ANDROID_UA =
  "Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36";
const LONG = Array.from({ length: 70 }, (_, i) => `Paragraph ${i + 1}: implemented a step with a sentence long enough to wrap on a phone.`).join("\n\n");

function seed(dataDir) {
  const workspace = path.join(dataDir, "workspace");
  fs.mkdirSync(path.join(workspace, "out"), { recursive: true });
  const report = path.join(workspace, "out", "notes.md");
  fs.writeFileSync(report, "# Notes\n\nA deliverable to preview.\n", "utf8");

  const db = new Database(path.join(dataDir, "orchestrator.sqlite"));
  const now = Date.now();
  const thread = db.prepare(
    "INSERT INTO threads (id, title, state, workspace, brief, raw_prompt, stage_outputs, created_at, updated_at) VALUES (?, ?, ?, ?, 'b', 'b', '{}', ?, ?)",
  );
  // The memo task is the OLDEST, so on a phone it sits below the filler and opening it needs a scroll.
  thread.run(TASK_ID, TASK_TITLE, "done", workspace, now - 9_000_000, now - 8_000_000);
  for (let i = 0; i < FILLER; i++) thread.run(`ios-nav-filler-${String(i).padStart(18, "0")}`, `Filler task ${i + 1}`, "review", workspace, now - 600_000 + i, now - 500_000 + i);
  const run = db.prepare("INSERT INTO agent_runs (id, thread_id, role, model, account, state, started_at, ended_at) VALUES (?, ?, 'implementor', 'claude-opus-5-5', 'subscription-a', 'done', ?, ?)");
  run.run("inl-r1", TASK_ID, now - 8_900_000, now - 8_600_000);
  run.run("inl-r2", TASK_ID, now - 8_500_000, now - 8_100_000);
  db.prepare("INSERT INTO messages (id, thread_id, run_id, role, kind, content, created_at) VALUES ('inl-m1', ?, 'inl-r2', 'implementor', 'text', ?, ?)").run(TASK_ID, LONG, now - 8_100_000);
  const memo = db.prepare(
    "INSERT INTO implementation_memos (id, thread_id, run_id, work_revision, revision, outcome, handoff, report, model, account, deliverables, source, started_at, completed_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'completed', 'done', ?, 'claude-opus-5-5', 'subscription-a', '[]', 'run', ?, ?, ?, ?)",
  );
  memo.run("inl-memo-1", TASK_ID, "inl-r1", "implementation:1", 1, `First revision.\n\n${LONG}`, now - 8_900_000, now - 8_600_000, now - 8_600_000, now - 8_600_000);
  memo.run("inl-memo-2", TASK_ID, "inl-r2", "implementation:2", 2, `Second revision.\n\n${LONG}`, now - 8_500_000, now - 8_100_000, now - 8_100_000, now - 8_100_000);
  db.prepare(
    "INSERT INTO findings (id, thread_id, from_run_id, from_role, kind, summary, detail, path, label, severity, routed, created_at) VALUES ('inl-f1', ?, 'inl-r2', 'implementor', 'deliverable', 'Notes', 'A note', ?, 'Notes', 'info', 0, ?)",
  ).run(TASK_ID, report, now - 8_200_000);
  db.close();
}

/** Geometry of one control, in viewport coordinates, plus whether it is the element a tap would hit. */
async function control(page, selector) {
  return page.evaluate((sel) => {
    const el = [...document.querySelectorAll(sel)].find((e) => e.getClientRects().length > 0);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return {
      top: r.top, bottom: r.bottom, left: r.left, right: r.right, width: r.width, height: r.height,
      text: (el.innerText ?? "").replace(/\s+/g, " ").trim(),
      tappable: !!hit && (hit === el || el.contains(hit)),
      vw: innerWidth, vh: innerHeight,
    };
  }, selector);
}

const onScreen = (c) => !!c && c.top >= 0 && c.left >= 0 && c.bottom <= c.vh + 0.5 && c.right <= c.vw + 0.5;
const bottomRight = (c) => !!c && c.bottom >= c.vh * 0.75 && c.right >= c.vw - 24;
const comfortable = (c) => !!c && c.width >= 44 && c.height >= 44;

async function boardScroll(page) {
  return page.evaluate(() => {
    let el = document.querySelector(".card");
    while (el && el !== document.body) {
      const style = getComputedStyle(el);
      if (/(auto|scroll)/.test(style.overflowY) && el.scrollHeight > el.clientHeight) return { top: el.scrollTop, cls: el.className };
      el = el.parentElement;
    }
    return { top: document.scrollingElement?.scrollTop ?? 0, cls: "document" };
  });
}

async function scrollBoardTo(page, selector) {
  await page.locator(selector).scrollIntoViewIfNeeded({ timeout: 20_000 });
  await page.waitForTimeout(200);
}

const state = (page) =>
  page.evaluate(() => ({
    memo: !!document.querySelector(".modal.implementation-memo-modal"),
    revision: document.querySelector("#implementation-memo-title")?.textContent ?? null,
    deliverable: !!document.querySelector(".modal.deliverable"),
    changes: !!document.querySelector(".modal.changes"),
    task: !!document.querySelector(".detail .detail-head"),
    history: history.length,
  }));

async function settle(page) {
  await page.waitForTimeout(250);
}

async function openConsole(page) {
  await page.goto(`${BASE}/`, { timeout: 45_000 });
  await page.waitForSelector(".accounts .acct", { state: "attached", timeout: 30_000 });
}

async function openTask(page) {
  const card = `.card:has-text("${TASK_TITLE}")`;
  await scrollBoardTo(page, card);
  await page.click(card, { timeout: 20_000 });
  await page.waitForSelector(".detail .implementation-memo-open", { timeout: 20_000 });
  await settle(page);
}

async function drivePhone(browser, check, dataDir, viewport, label) {
  const ctx = await browser.newContext({ viewport, hasTouch: true, isMobile: true, deviceScaleFactor: 2, userAgent: IPHONE_UA });
  try {
    const page = await ctx.newPage();
    const errors = [];
    page.on("console", (m) => { if (m.type() === "error" && !isVoiceBridgeNoise(m)) errors.push(m.text()); });
    page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
    await page.request.post(`${BASE}/api/login`, { data: { password: authPassword() } });
    await openConsole(page);
    const shots = shotDir(dataDir);
    console.log(`\nIPHONE ${label} (${viewport.width}x${viewport.height})`);
    check(`${label}: the document is marked ios-phone`, await page.evaluate(() => document.documentElement.classList.contains("ios-phone")));

    const startLength = await page.evaluate(() => history.length);
    await openTask(page);
    const boardBefore = await boardScroll(page);
    check(`${label}: the memo task needed a board scroll to reach`, boardBefore.top > 0, JSON.stringify(boardBefore));

    // ---- the task's own Close ----
    let close = await control(page, ".detail-title-actions .task-close");
    check(`${label}: the task's Close reads "Close"`, close?.text.includes("Close") ?? false, JSON.stringify(close));
    check(`${label}: ...is a comfortable target`, comfortable(close), JSON.stringify(close));
    check(`${label}: ...sits in the bottom-right corner, on screen and unobstructed`, bottomRight(close) && onScreen(close) && !!close?.tappable, JSON.stringify(close));
    const chevron = await control(page, ".detail-title-actions .head-toggle");
    check(`${label}: ...and does not overlap the collapse chevron`, !!chevron && !!close && chevron.right <= close.left, JSON.stringify({ chevron, close }));
    const title = await control(page, ".detail-head .editable-title");
    check(`${label}: ...or the task title`, !!title && !!chevron && title.right <= chevron.left + 0.5, JSON.stringify({ title, chevron }));
    await page.screenshot({ path: path.join(shots, `ios-${viewport.width}-task.png`) });
    check(`${label}: opening the task added one history entry`, (await page.evaluate(() => history.length)) === startLength + 1);

    // ---- the work memo from the pin ----
    await page.click(".implementation-memo-open");
    await page.waitForSelector(".modal.implementation-memo-modal", { timeout: 5_000 });
    // The tap itself scrolls the pin into view, so park the feed somewhere distinctive only once the
    // memo covers it: the claim is that closing the memo gives the owner back this exact position.
    const feedBefore = await page.evaluate(() => {
      const el = document.querySelector(".detail-body");
      el.scrollTop = Math.floor(el.scrollHeight / 3);
      return el.scrollTop;
    });
    const memoBox = await control(page, ".modal.implementation-memo-modal");
    check(`${label}: the memo fills the screen`, !!memoBox && memoBox.top <= 0.5 && memoBox.left <= 0.5 && memoBox.width >= memoBox.vw - 0.5 && memoBox.height >= memoBox.vh - 0.5, JSON.stringify(memoBox));
    check(`${label}: the memo's top-corner × gives way to the bar`, (await control(page, '[aria-label="Close memo"]')) === null);
    let layerClose = await control(page, ".modal.implementation-memo-modal .layer-close");
    check(`${label}: the memo's Close matches the task's: same label, size and corner`,
      !!layerClose && !!close && layerClose.text.includes("Close") && layerClose.text === close.text && Math.abs(layerClose.width - close.width) < 1 && Math.abs(layerClose.right - close.right) < 1 && bottomRight(layerClose) && layerClose.tappable,
      JSON.stringify({ layerClose, close }));
    await page.evaluate(() => { const b = document.querySelector(".implementation-memo-body"); b.scrollTop = b.scrollHeight; });
    await settle(page);
    layerClose = await control(page, ".modal.implementation-memo-modal .layer-close");
    const bodyEnd = await page.evaluate(() => { const b = document.querySelector(".implementation-memo-body"); return { scrolled: b.scrollTop > 0, end: Math.abs(b.scrollHeight - b.clientHeight - b.scrollTop) < 2 }; });
    check(`${label}: a long memo scrolls to its end with the Close still on screen`, bodyEnd.scrolled && bodyEnd.end && onScreen(layerClose) && !!layerClose?.tappable, JSON.stringify({ bodyEnd, layerClose }));
    await page.screenshot({ path: path.join(shots, `ios-${viewport.width}-memo.png`) });

    await page.click(".modal.implementation-memo-modal .layer-close");
    await page.waitForSelector(".modal.implementation-memo-modal", { state: "detached", timeout: 5_000 });
    await settle(page);
    let s = await state(page);
    check(`${label}: Close on the memo returns to the task`, s.task && !s.memo, JSON.stringify(s));
    const feedAfter = await page.evaluate(() => document.querySelector(".detail-body").scrollTop);
    check(`${label}: ...with the feed where it was`, Math.abs(feedAfter - feedBefore) < 2, `${feedBefore} -> ${feedAfter}`);
    check(`${label}: ...and history back at the task's entry`, s.history === startLength + 2, JSON.stringify(s));

    // ---- history Back/Forward through the layers ----
    await page.click(".implementation-memo-open");
    await page.waitForSelector(".modal.implementation-memo-modal", { timeout: 5_000 });
    await page.click('.implementation-memo-history button:has-text("Revision 1")');
    await page.goBack();
    await settle(page);
    s = await state(page);
    check(`${label}: Back closes the memo and keeps the task open`, s.task && !s.memo, JSON.stringify(s));
    await page.goForward();
    await page.waitForSelector(".modal.implementation-memo-modal", { timeout: 5_000 });
    s = await state(page);
    check(`${label}: Forward reopens the memo`, s.memo && s.task, JSON.stringify(s));
    await page.goBack();
    await settle(page);
    await page.goBack();
    await settle(page);
    s = await state(page);
    check(`${label}: a second Back closes the task`, !s.task && !s.memo, JSON.stringify(s));
    const boardAfter = await boardScroll(page);
    check(`${label}: ...and the board is still scrolled where the owner left it`, Math.abs(boardAfter.top - boardBefore.top) < 2, `${boardBefore.top} -> ${boardAfter.top}`);
    check(`${label}: ...still inside the console`, page.url().startsWith(BASE));
    await page.goForward();
    await page.waitForSelector(".detail .implementation-memo-open", { timeout: 10_000 });
    s = await state(page);
    check(`${label}: Forward reopens the task`, s.task && !s.memo, JSON.stringify(s));

    // ---- repeated open/close does not grow history ----
    const lengthBefore = (await state(page)).history;
    for (let i = 0; i < 4; i++) {
      await page.click(".implementation-memo-open");
      await page.waitForSelector(".modal.implementation-memo-modal", { timeout: 5_000 });
      await page.click(".modal.implementation-memo-modal .layer-close");
      await page.waitForSelector(".modal.implementation-memo-modal", { state: "detached", timeout: 5_000 });
      await settle(page);
    }
    s = await state(page);
    check(`${label}: four memo open/close rounds leave history the same length`, s.history === lengthBefore && s.task, `${lengthBefore} -> ${s.history}`);

    // ---- the final report's memo button opens the same layer ----
    await page.evaluate(() => document.querySelector(".detail .fi.final-report .final-report-open")?.scrollIntoView({ block: "center" }));
    await page.click(".fi.final-report .final-report-open");
    await page.waitForSelector(".modal.implementation-memo-modal", { timeout: 5_000 });
    check(`${label}: the final report opens the same memo layer`, (await control(page, ".modal.implementation-memo-modal .layer-close"))?.tappable ?? false);
    await page.goBack();
    await page.waitForSelector(".modal.implementation-memo-modal", { state: "detached", timeout: 5_000 });
    check(`${label}: ...and Back closes it`, (await state(page)).task);

    // ---- deliverable preview ----
    await page.click(".deliverables-label");
    await page.click(".deliverable-strip .dl-chip-btn");
    await page.waitForSelector(".modal.deliverable", { timeout: 10_000 });
    const dlClose = await control(page, ".modal.deliverable .layer-close");
    check(`${label}: the deliverable preview has the same Close in the same corner`, !!dlClose && !!close && Math.abs(dlClose.right - close.right) < 1 && bottomRight(dlClose) && dlClose.tappable, JSON.stringify(dlClose));
    check(`${label}: ...and no second ✕ in its header`, (await control(page, ".modal.deliverable .layer-head-close")) === null);
    await page.screenshot({ path: path.join(shots, `ios-${viewport.width}-deliverable.png`) });
    await page.goBack();
    await page.waitForSelector(".modal.deliverable", { state: "detached", timeout: 5_000 });
    check(`${label}: Back closes the preview, not the task`, (await state(page)).task);
    await page.goForward();
    await page.waitForSelector(".modal.deliverable", { timeout: 5_000 });
    await page.click(".modal.deliverable .layer-close");
    await page.waitForSelector(".modal.deliverable", { state: "detached", timeout: 5_000 });
    check(`${label}: Forward reopens it and its Close returns to the task`, (await state(page)).task);

    // ---- diff ----
    if (!(await page.isVisible('.detail-head button:text-is("Diff")'))) await page.click(".detail-title-actions .head-toggle");
    await page.click('.detail-head button:text-is("Diff")');
    await page.waitForSelector(".modal.changes", { timeout: 10_000 });
    const diffClose = await control(page, ".modal.changes .layer-close");
    check(`${label}: the diff has the same Close in the same corner`, !!diffClose && !!close && Math.abs(diffClose.right - close.right) < 1 && bottomRight(diffClose) && diffClose.tappable, JSON.stringify(diffClose));
    check(`${label}: ...and no second ✕ in its header`, (await control(page, ".modal.changes .layer-head-close")) === null);
    await page.screenshot({ path: path.join(shots, `ios-${viewport.width}-diff.png`) });
    await page.goBack();
    await page.waitForSelector(".modal.changes", { state: "detached", timeout: 5_000 });
    check(`${label}: Back closes the diff, not the task`, (await state(page)).task);

    // ---- the task's Close, then the keyboard-sized viewport ----
    await page.click(".detail-title-actions .task-close");
    await page.waitForSelector(".detail .detail-head", { state: "detached", timeout: 5_000 });
    await settle(page);
    s = await state(page);
    const boardAfterClose = await boardScroll(page);
    check(`${label}: the task's Close returns to the board`, !s.task, JSON.stringify(s));
    check(`${label}: ...at the same scroll position`, Math.abs(boardAfterClose.top - boardBefore.top) < 2, `${boardBefore.top} -> ${boardAfterClose.top}`);
    await page.goBack();
    await settle(page);
    check(`${label}: Back after Close does not reopen the task`, !(await state(page)).task);

    await page.goForward().catch(() => {});
    await settle(page);
    if (!(await state(page)).task) await openTask(page);
    await page.click(".mobile-inject-toggle");
    await page.focus(".inject-bar textarea");
    // interactive-widget=resizes-content shrinks the layout viewport by the keyboard's height.
    await page.setViewportSize({ width: viewport.width, height: Math.round(viewport.height * 0.55) });
    await settle(page);
    // While typing, the header docked under the composer sits behind the keyboard (on iOS the keyboard
    // overlays the page). The way out is the composer's own fold control, which stays on screen; folding
    // it brings the task's Close back without the keyboard having to go anywhere first.
    const fold = await control(page, '[aria-label="Hide message composer"]');
    check(`${label}: with the keyboard up the composer's fold control is on screen and tappable`, onScreen(fold) && !!fold?.tappable && comfortable(fold), JSON.stringify(fold));
    await page.screenshot({ path: path.join(shots, `ios-${viewport.width}-keyboard.png`) });
    await page.click('[aria-label="Hide message composer"]');
    await settle(page);
    close = await control(page, ".detail-title-actions .task-close");
    check(`${label}: ...and folding it brings the task's Close back on screen`, onScreen(close) && !!close?.tappable, JSON.stringify(close));

    // Landscape: still the phone layout below 900px, and the shortest screen the header has to fit.
    await page.setViewportSize({ width: viewport.height, height: viewport.width });
    await settle(page);
    close = await control(page, ".detail-title-actions .task-close");
    check(`${label}: in landscape the task's Close is on screen and tappable`, onScreen(close) && !!close?.tappable, JSON.stringify(close));
    await page.screenshot({ path: path.join(shots, `ios-${viewport.width}-landscape.png`) });
    await page.setViewportSize(viewport);

    check(`${label}: no console errors`, errors.length === 0, errors.join(" | "));
  } finally {
    await ctx.close();
  }
}

async function driveAndroid(browser, check, dataDir) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 664 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2, userAgent: ANDROID_UA });
  try {
    const page = await ctx.newPage();
    await page.request.post(`${BASE}/api/login`, { data: { password: authPassword() } });
    await openConsole(page);
    console.log("\nANDROID (negative control, 390x664)");
    check("android: the document is NOT marked ios-phone", !(await page.evaluate(() => document.documentElement.classList.contains("ios-phone"))));
    const startLength = await page.evaluate(() => history.length);
    await openTask(page);
    const close = await control(page, ".detail-title-actions .task-close");
    check("android: the task keeps its bare ✕ (no label)", close?.text === "✕" && Math.round(close.width) === 44, JSON.stringify(close));
    await page.click(".implementation-memo-open");
    await page.waitForSelector(".modal.implementation-memo-modal", { timeout: 5_000 });
    check("android: the memo keeps its own ×", (await control(page, '[aria-label="Close memo"]')) !== null);
    check("android: no Close bar", (await control(page, ".modal.implementation-memo-modal .layer-close")) === null);
    const memoBox = await control(page, ".modal.implementation-memo-modal");
    check("android: the memo keeps its original phone sizing (no safe-area padding)", !!memoBox && (await page.evaluate(() => getComputedStyle(document.querySelector(".modal.implementation-memo-modal")).paddingTop)) === "0px", JSON.stringify(memoBox));
    check("android: no history entries were written", (await page.evaluate(() => history.length)) === startLength);
    await page.screenshot({ path: path.join(shotDir(dataDir), "android-memo.png") });
    await page.click('[aria-label="Close memo"]');
    await page.waitForSelector(".modal.implementation-memo-modal", { state: "detached", timeout: 5_000 });
  } finally {
    await ctx.close();
  }
}

async function driveDesktop(browser, check, dataDir) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  try {
    const page = await ctx.newPage();
    await page.request.post(`${BASE}/api/login`, { data: { password: authPassword() } });
    await openConsole(page);
    console.log("\nDESKTOP (negative control, 1440x900)");
    const startLength = await page.evaluate(() => history.length);
    await openTask(page);
    const close = await control(page, ".detail-title-actions .task-close");
    check("desktop: the task keeps its ✕", close?.text === "✕", JSON.stringify(close));
    await page.click(".implementation-memo-open");
    await page.waitForSelector(".modal.implementation-memo-modal", { timeout: 5_000 });
    const memoBox = await control(page, ".modal.implementation-memo-modal");
    check("desktop: the memo stays a centered dialog", !!memoBox && memoBox.left > 0 && memoBox.width < memoBox.vw, JSON.stringify(memoBox));
    check("desktop: no Close bar", (await control(page, ".modal.implementation-memo-modal .layer-close")) === null);
    await page.screenshot({ path: path.join(shotDir(dataDir), "desktop-memo.png") });
    await page.keyboard.press("Escape");
    await page.waitForSelector(".modal.implementation-memo-modal", { state: "detached", timeout: 5_000 });
    check("desktop: Escape still closes the memo", (await state(page)).task);
    await page.click(".implementation-memo-open");
    await page.click('[aria-label="Close memo"]');
    await page.waitForSelector(".modal.implementation-memo-modal", { state: "detached", timeout: 5_000 });
    check("desktop: the memo's × still closes it", (await state(page)).task);
    check("desktop: no history entries were written", (await page.evaluate(() => history.length)) === startLength);
  } finally {
    await ctx.close();
  }
}

async function main() {
  requireBuild();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "ios-nav-lab-"));
  console.log(`ios-nav-lab: one done task with two memo revisions, a deliverable and ${FILLER} filler tasks on ${BASE}`);
  const check = createChecks();
  killInstance(PORT);
  let child = null;
  let browser = null;
  try {
    child = await boot({ dataDir, port: PORT });
    child.kill();
    killInstance(PORT);
    seed(dataDir);
    child = await boot({ dataDir, port: PORT });
    browser = await loadChromium().launch();
    await drivePhone(browser, check, dataDir, { width: 390, height: 664 }, "390");
    await drivePhone(browser, check, dataDir, { width: 320, height: 568 }, "320");
    await driveAndroid(browser, check, dataDir);
    await driveDesktop(browser, check, dataDir);
    console.log(`\nscreenshots: ${shotDir(dataDir)}`);
  } finally {
    if (browser) await browser.close();
    try {
      if (child) child.kill();
    } catch {
      /* already gone */
    }
    killInstance(PORT);
    if (process.argv.includes("--keep")) console.log(`  kept ${dataDir}`);
    else fs.rmSync(dataDir, { recursive: true, force: true });
  }
  return check.summary();
}

main().then(
  (code) => process.exit(code),
  (e) => {
    console.error(e);
    killInstance(PORT);
    process.exit(2);
  },
);
