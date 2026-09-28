// Drive the phone swipe gestures with REAL touch input — a headless Chromium in a mobile touch
// context, fed through CDP `Input.dispatchTouchEvent`, against a throwaway instance.
//
//   npm run swipe-lab --prefix server
//   npm run swipe-lab --prefix server -- --keep       leave the instance up to poke at
//
// What it proves (web/src/lib/swipe.ts):
//   • swiping the board right shows the Director, swiping left goes back — and a vertical scroll
//     on the board does neither;
//   • an open task closes when pulled down from its top edge, or swiped right from anywhere; a short
//     pull springs back, and a downward drag lower in the panel is a scroll, not a close;
//   • Settings and the Git console close on the same pull-down;
//   • at desktop width none of it fires.
// A synthetic `dispatchEvent(new TouchEvent(...))` would not do: the point is that the browser's
// own touch pipeline (passive listeners, cancelable moves, scroll claiming) lets the gesture through.
//
// Isolation is the same as phone-lab: temp DATA_DIR, bogus tokens, own port, killed by port owner.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Database = require("better-sqlite3");
const { SERVER_ROOT, loadChromium, authPassword, requireBuild, requireFreshWebBuild, boot, killInstance, createChecks } = require("./lab-harness.cjs");

const PORT = 4441;
const BASE = `http://127.0.0.1:${PORT}`;
const TASK_ID = "swipe-lab-task-0000";
const PHONE = { width: 390, height: 844 };

const check = createChecks();

async function openWhenMigrated(dataDir) {
  const file = path.join(dataDir, "orchestrator.sqlite");
  for (let i = 0; i < 40; i++) {
    try {
      const db = new Database(file);
      if (db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='threads'").get()) return db;
      db.close();
    } catch {
      /* not created yet */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`${file} never gained a schema — is something else on :${PORT}?`);
}

/** One task parked in `review`, so nothing spawns an agent and the card has a panel to open. */
async function seed(dataDir) {
  const db = await openWhenMigrated(dataDir);
  const now = Date.now();
  db.prepare(
    "INSERT INTO threads (id, title, state, workspace, brief, raw_prompt, created_at, updated_at) VALUES (?, ?, 'review', ?, ?, ?, ?, ?)",
  ).run(TASK_ID, "Swipe lab seeded task", SERVER_ROOT, "a seeded task", "a seeded task", now, now);
  db.close();
}

/** A finger drag from (x0,y0) to (x1,y1) over `ms`, through the browser's real touch pipeline. */
async function drag(page, cdp, [x0, y0], [x1, y1], { ms = 220, steps = 12 } = {}) {
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: x0, y: y0 }] });
  for (let i = 1; i <= steps; i++) {
    const f = i / steps;
    await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: x0 + (x1 - x0) * f, y: y0 + (y1 - y0) * f }] });
    await page.waitForTimeout(ms / steps);
  }
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  // Longer than the 190ms settle, so a committed close has unmounted and a spring-back has reset.
  await page.waitForTimeout(450);
}

const pane = (page) => page.evaluate(() => (document.querySelector(".workbench")?.className.match(/pane-(\w+)/) || [])[1]);
const detailOpen = (page) => page.evaluate(() => !!document.querySelector(".detail"));

async function openTask(page) {
  if (await detailOpen(page)) return;
  await page.tap(".lanes .card");
  await page.waitForSelector(".detail", { timeout: 10_000 });
  await page.waitForTimeout(200);
}

async function ready(page) {
  await page.goto(`${BASE}/`, { timeout: 45_000 });
  await page.waitForSelector(".lanes .card", { timeout: 30_000 });
  await page.waitForTimeout(300);
}

async function panes(page, cdp) {
  const { width: w, height: h } = PHONE;
  console.log("\n════ board ⇄ Director");
  check("starts on the board", (await pane(page)) === "board");
  await drag(page, cdp, [w * 0.5, h * 0.5], [w * 0.5, h * 0.5 - 220]);
  check("a vertical scroll on the board keeps the board", (await pane(page)) === "board", await pane(page));
  await drag(page, cdp, [w * 0.2, h * 0.5], [w * 0.2 + 200, h * 0.5 + 12]);
  check("swiping right shows the Director", (await pane(page)) === "director", await pane(page));
  const navOn = await page.evaluate(() => document.querySelector(".mobile-nav [aria-current='page']")?.textContent?.trim());
  check("the bottom nav follows the swipe", navOn === "Director", navOn);
  await drag(page, cdp, [w * 0.85, h * 0.45], [w * 0.85 - 200, h * 0.45 - 8]);
  check("swiping left goes back to the board", (await pane(page)) === "board", await pane(page));
  await drag(page, cdp, [w * 0.85, h * 0.45], [w * 0.85 - 200, h * 0.45]);
  check("swiping left again stays on the board", (await pane(page)) === "board", await pane(page));
  const residue = await page.evaluate(() => document.querySelector(".workbench").style.transform);
  check("the workbench is left untransformed", residue === "", residue);
}

async function taskPanel(page, cdp) {
  const { width: w, height: h } = PHONE;
  console.log("\n════ task panel");
  await openTask(page);
  const grab = await page.evaluate(() => {
    const r = document.querySelector(".detail .sheet-grabber")?.getBoundingClientRect();
    return r ? { top: Math.round(r.top), h: Math.round(r.height), visible: r.height > 0 } : null;
  });
  check("the grabber marks the panel's top edge", !!grab?.visible && grab.top <= 4, JSON.stringify(grab));

  await drag(page, cdp, [w * 0.5, 30], [w * 0.5, 70], { ms: 400 });
  check("a short, slow pull springs back", await detailOpen(page));
  const reset = await page.evaluate(() => document.querySelector(".detail")?.style.transform ?? "gone");
  check("…and the panel is back in place", reset === "", reset);

  await drag(page, cdp, [w * 0.5, h * 0.45], [w * 0.5, h * 0.45 + 300]);
  check("a downward drag lower in the panel is a scroll, not a close", await detailOpen(page));

  // A feed scrolled away from its top owns a downward drag near the panel's top edge: that is the
  // operator scrolling back up, and a native sheet only pulls down once its content is at the top.
  // The seeded task is too short to scroll, so pad the feed for this one check.
  const scrolled = await page.evaluate(() => {
    const body = document.querySelector(".detail .detail-body");
    const r = body?.getBoundingClientRect();
    if (!body || !r) return null;
    const pad = document.createElement("div");
    pad.id = "swipe-lab-pad";
    pad.style.cssText = "flex: none; height: 3000px";
    body.appendChild(pad);
    body.scrollTop = 600;
    return { top: Math.round(r.top), scrollTop: body.scrollTop };
  });
  check("the padded feed scrolls, and starts inside the pull zone", !!scrolled && scrolled.scrollTop > 0 && scrolled.top < 60, JSON.stringify(scrolled));
  const startY = Math.max(scrolled?.top ?? 30, 20) + 10;
  await drag(page, cdp, [w * 0.5, startY], [w * 0.5, startY + 340], { ms: 160 });
  const afterScroll = await page.evaluate(() => document.querySelector(".detail .detail-body")?.scrollTop ?? -1);
  check("a pull-down on a scrolled feed scrolls it back, not closes the task", await detailOpen(page), `scrollTop ${afterScroll}`);
  check("…and the feed did scroll up", afterScroll >= 0 && afterScroll < (scrolled?.scrollTop ?? 0),`scrollTop ${afterScroll}`);
  await page.evaluate(() => {
    document.getElementById("swipe-lab-pad")?.remove();
    const body = document.querySelector(".detail .detail-body");
    if (body) body.scrollTop = 0;
  });

  await drag(page, cdp, [w * 0.5, 20], [w * 0.5, 360]);
  check("pulling down from the top closes the task", !(await detailOpen(page)));
  check("…back on the board", (await pane(page)) === "board", await pane(page));

  await openTask(page);
  await drag(page, cdp, [w * 0.3, h * 0.4], [w * 0.3 + 230, h * 0.4 + 10]);
  check("swiping right closes the task", !(await detailOpen(page)));
  check("…and did not also flip the pane", (await pane(page)) === "board", await pane(page));

  await openTask(page);
  await drag(page, cdp, [w * 0.8, h * 0.4], [w * 0.8 - 230, h * 0.4]);
  check("swiping left leaves the task open", await detailOpen(page));
  await drag(page, cdp, [w * 0.5, 20], [w * 0.5, 360]);
  check("…and a pull-down still closes it afterwards", !(await detailOpen(page)));
}

async function sheets(page, cdp) {
  const { width: w, height: h } = PHONE;
  console.log("\n════ settings");
  await page.tap(".settings-btn");
  await page.waitForSelector(".settings-pop", { timeout: 15_000 });
  await page.waitForTimeout(300);
  const top = await page.evaluate(() => Math.round(document.querySelector(".settings-pop").getBoundingClientRect().top));
  await drag(page, cdp, [w * 0.3, top + 20], [w * 0.3, top + 380]);
  check("pulling Settings down from its top closes it", !(await page.$(".settings-pop")));

  console.log("\n════ git console");
  await page.tap(".git-btn");
  await page.waitForSelector(".gc-window", { timeout: 15_000 });
  await page.waitForTimeout(300);
  await drag(page, cdp, [w * 0.5, h * 0.5], [w * 0.5, h * 0.5 + 300]);
  check("a downward drag inside the Git console does not close it", !!(await page.$(".gc-window")));
  await drag(page, cdp, [w * 0.3, 20], [w * 0.3, 380]);
  check("pulling the Git console down from its top closes it", !(await page.$(".gc-window")));
}

async function desktop(page, cdp) {
  console.log("\n════ desktop width");
  await page.setViewportSize({ width: 1280, height: 860 });
  await page.waitForTimeout(300);
  await openTask(page);
  const top = await page.evaluate(() => Math.round(document.querySelector(".detail").getBoundingClientRect().top));
  const left = await page.evaluate(() => Math.round(document.querySelector(".detail").getBoundingClientRect().left));
  await drag(page, cdp, [left + 120, top + 20], [left + 120, top + 400]);
  check("no pull-down close at desktop width", await detailOpen(page));
  await drag(page, cdp, [left + 60, top + 300], [left + 360, top + 300]);
  check("no swipe-right close at desktop width", await detailOpen(page));
  const grabberShown = await page.evaluate(() => (document.querySelector(".detail .sheet-grabber")?.getBoundingClientRect().height ?? 0) > 0);
  check("no grabber at desktop width", !grabberShown);
}

async function rmWithRetry(dir) {
  for (let i = 0; i < 20; i++) {
    try {
      return fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      await new Promise((r) => setTimeout(r, 250));
    }
  }
}

(async () => {
  const keep = process.argv.includes("--keep");
  requireBuild();
  requireFreshWebBuild();
  killInstance(PORT);
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "swipe-lab-"));
  let browser;
  try {
    await boot({ dataDir, port: PORT });
    await seed(dataDir);
    killInstance(PORT);
    await boot({ dataDir, port: PORT });

    browser = await loadChromium().launch();
    const ctx = await browser.newContext({ viewport: PHONE, hasTouch: true, isMobile: true, deviceScaleFactor: 3 });
    const page = await ctx.newPage();
    await page.request.post(`${BASE}/api/login`, { data: { password: authPassword() } });
    const cdp = await ctx.newCDPSession(page);
    await ready(page);
    await panes(page, cdp);
    await taskPanel(page, cdp);
    await sheets(page, cdp);
    await desktop(page, cdp);
    await ctx.close();
  } finally {
    if (browser) await browser.close().catch(() => {});
    if (!keep) {
      killInstance(PORT);
      await rmWithRetry(dataDir);
    } else {
      console.log(`\n  instance: ${BASE}  (data: ${dataDir})`);
    }
  }
  process.exit(check.summary());
})().catch((e) => {
  console.error(e);
  killInstance(PORT);
  process.exit(1);
});
