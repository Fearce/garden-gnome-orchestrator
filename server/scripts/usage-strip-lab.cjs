// Drive the top bar's usage-strip toggle (the gauge button) in a real browser, headlessly, against a
// THROWAWAY instance.
//
//   npm run usage-strip-lab --prefix server
//   npm run usage-strip-lab --prefix server -- --keep --shots data/usage-strip-lab-shots
//
// One button, two jobs: on a desktop it folds the account burn strip away in place (persisted per
// browser, like the rail and focus toggles); below 900px it stays the pop-over trigger it always was.
// Every claim is geometric — the chips are GONE (not dimmed), the wrapped second row is given back to
// the board, the choice survives a reload, and a desktop "hidden" never leaks into the phone pop-over.
//
// Never prod: its own port, its own empty DATA_DIR, bogus account tokens (see lab-harness.cjs).

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { loadChromium, authPassword, requireBuild, boot, killInstance, createChecks, shotDir } = require("./lab-harness.cjs");

const PORT = 4523;
const BASE = `http://127.0.0.1:${PORT}`;
const NAV_TIMEOUT = 45_000; // this box runs near 100% CPU; a cold goto has measured 28s

// 1440 sits in the band where the strip wraps to its own row; 1920 is the single-row bar.
const WRAPPED = { width: 1440, height: 900 };
const WIDE = { width: 1920, height: 1000 };
const PHONE = { width: 390, height: 844 };
const TOGGLE = ".accounts-toggle";

async function openConsole(context) {
  const page = await context.newPage();
  await page.request.post(`${BASE}/api/login`, { data: { password: authPassword() } });
  await page.goto(`${BASE}/`, { timeout: NAV_TIMEOUT });
  // Chips are hello-only; attached, because a hidden strip is still in the DOM.
  await page.waitForSelector(".accounts .acct", { state: "attached", timeout: 30_000 });
  return page;
}

const barHeight = (page) => page.evaluate(() => Math.round(document.querySelector(".topbar").getBoundingClientRect().height));
const boardHeight = (page) => page.evaluate(() => Math.round(document.querySelector(".workbench").getBoundingClientRect().height));
const expanded = (page) => page.getAttribute(TOGGLE, "aria-expanded");

/** Present AND laid out — a display:none strip keeps its nodes, so a count would pass it. */
const laidOut = (page, selector) =>
  page.evaluate((sel) => {
    const el = document.querySelector(sel);
    const box = el ? el.getBoundingClientRect() : null;
    return !!box && box.width > 0 && box.height > 0;
  }, selector);

/** Every chip fully inside the viewport and the strip not scrolling — the topbar rule's contract. */
const chipsOnScreen = (page) =>
  page.evaluate(() => {
    const strip = document.querySelector(".accounts");
    const chips = [...document.querySelectorAll(".accounts .acct")];
    const inside = chips.every((c) => {
      const r = c.getBoundingClientRect();
      return r.width > 0 && r.left >= 0 && r.right <= innerWidth + 0.5;
    });
    return inside && strip.scrollWidth <= strip.clientWidth + 1;
  });

async function clickToggle(page, wantExpanded) {
  await page.click(TOGGLE);
  await page.waitForFunction(
    ([sel, want]) => document.querySelector(sel)?.getAttribute("aria-expanded") === want,
    [TOGGLE, String(wantExpanded)],
    { timeout: 10_000 },
  );
  await page.waitForTimeout(60);
}

async function main() {
  requireBuild();
  const check = createChecks();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "usage-strip-lab-"));
  const keep = process.argv.includes("--keep");
  const shots = shotDir(dataDir);
  console.log(`usage-strip-lab — ${BASE} (data ${dataDir})`);

  try {
    await boot({ dataDir, port: PORT });
    const browser = await loadChromium().launch();
    try {
      // ONE context: the choice lives in localStorage, so a fresh context would pass persistence for free.
      const context = await browser.newContext({ viewport: WRAPPED });
      const page = await openConsole(context);
      const errors = [];
      page.on("pageerror", (error) => errors.push(String(error)));
      // The voice bridge 502s whenever the external voice-gateway isn't running; not this surface's error.
      const voiceBridge = (message) => message.text().startsWith("Failed to load resource") && message.location().url.includes("/api/voice/");
      page.on("console", (message) => message.type() === "error" && !voiceBridge(message) && errors.push(message.text()));

      /* ---- 1. the desktop default: strip and its switch both on screen ---------------------------- */
      check("the gauge button is on the desktop bar", await laidOut(page, TOGGLE));
      check("the strip starts shown", (await laidOut(page, ".accounts")) && (await expanded(page)) === "true");
      const fullBar = await barHeight(page);
      const fullBoard = await boardHeight(page);
      check(`the strip wraps to a second row at ${WRAPPED.width}px (bar ${fullBar}px)`, fullBar > 90, `${fullBar}px`);
      await page.locator(".topbar").screenshot({ path: path.join(shots, "topbar-shown.png") });

      /* ---- 2. hide it ------------------------------------------------------------------------------ */
      await clickToggle(page, false);
      check("a click folds the strip away (not merely dimmed)", !(await laidOut(page, ".accounts")));
      check("…without opening the phone pop-over or its scrim", (await page.locator(".accounts.phone-open, .accounts-scrim").count()) === 0);
      check("the gauge button stays put to bring it back", await laidOut(page, TOGGLE));
      const hiddenBar = await barHeight(page);
      const hiddenBoard = await boardHeight(page);
      check(`the bar drops its second row (${fullBar}px → ${hiddenBar}px)`, hiddenBar < fullBar && hiddenBar <= 64, `${hiddenBar}px`);
      check(
        `the board gets that space back, to the pixel (+${hiddenBoard - fullBoard}px)`,
        hiddenBoard - fullBoard === fullBar - hiddenBar,
        `board +${hiddenBoard - fullBoard}, bar -${fullBar - hiddenBar}`,
      );
      await page.locator(".topbar").screenshot({ path: path.join(shots, "topbar-hidden.png") });

      /* ---- 3. it survives a reload ----------------------------------------------------------------- */
      check("the choice is persisted for this browser", (await page.evaluate(() => localStorage.getItem("orch-usage-hidden"))) === "1");
      await page.reload({ timeout: NAV_TIMEOUT });
      await page.waitForSelector(".accounts .acct", { state: "attached", timeout: 30_000 });
      check("the strip is still folded after a reload", !(await laidOut(page, ".accounts")) && (await expanded(page)) === "false");
      check(`…at the same bar height (${await barHeight(page)}px)`, (await barHeight(page)) === hiddenBar);

      /* ---- 4. a folded desktop strip must not break the phone pop-over ---------------------------- */
      await page.setViewportSize(PHONE);
      await page.waitForTimeout(150);
      check("on a phone the strip starts closed", !(await laidOut(page, ".accounts")) && (await expanded(page)) === "false");
      await clickToggle(page, true);
      check("…and the gauge still opens the pop-over despite the desktop setting", await laidOut(page, ".accounts.phone-open .acct"));
      await page.screenshot({ path: path.join(shots, "phone-popover.png") });
      await page.click(".accounts-scrim", { position: { x: 10, y: PHONE.height - 20 } });
      await page.waitForSelector(".accounts-scrim", { state: "detached", timeout: 10_000 });
      check("…and the scrim closes it again", !(await laidOut(page, ".accounts")));
      check("the phone pop-over never rewrote the desktop choice", (await page.evaluate(() => localStorage.getItem("orch-usage-hidden"))) === "1");

      /* ---- 5. back on the single-row desktop bar: show it again ----------------------------------- */
      await page.setViewportSize(WIDE);
      await page.waitForTimeout(150);
      check(`at ${WIDE.width}px the strip is still folded`, !(await laidOut(page, ".accounts")));
      const wideHidden = await barHeight(page);
      await clickToggle(page, true);
      check("a second click brings every chip back", await laidOut(page, ".accounts .acct"));
      check("…fully on screen, not clipped or scrolling", await chipsOnScreen(page));
      check(`…as one row (bar ${await barHeight(page)}px)`, (await barHeight(page)) < 90 && (await barHeight(page)) >= wideHidden);
      check("showing is persisted too", (await page.evaluate(() => localStorage.getItem("orch-usage-hidden"))) === "0");
      await page.locator(".topbar").screenshot({ path: path.join(shots, "topbar-wide.png") });

      /* ---- 6. back at the wrapped width the bar is restored exactly -------------------------------- */
      await page.setViewportSize(WRAPPED);
      await page.waitForTimeout(150);
      check(`the wrapped bar is back to ${fullBar}px`, (await barHeight(page)) === fullBar, `${await barHeight(page)}px`);

      /* ---- 7. focus mode already drops the strip, so its switch goes with it ---------------------- */
      await page.click('[aria-label="Toggle top bar detail"]');
      await page.waitForFunction(() => document.querySelector(".topbar").classList.contains("focus"), null, { timeout: 10_000 });
      check("focus mode takes the gauge button with the strip", (await page.locator(TOGGLE).count()) === 0);
      await page.click('[aria-label="Toggle top bar detail"]');
      await page.waitForFunction(() => !document.querySelector(".topbar").classList.contains("focus"), null, { timeout: 10_000 });

      check("nothing threw in the console", errors.length === 0, errors.slice(0, 3).join(" | "));
      await page.close();
      console.log(`  screenshots: ${shots}`);
    } finally {
      await browser.close();
    }
    return check.summary();
  } finally {
    killInstance(PORT);
    if (!keep) fs.rmSync(dataDir, { recursive: true, force: true });
    else console.log(`kept ${dataDir}`);
  }
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(err);
    killInstance(PORT);
    process.exit(1);
  },
);
