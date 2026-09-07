// Drive the top bar's focus toggle in a real browser, headlessly, against a THROWAWAY instance.
//
//   npm run focus-lab --prefix server
//   npm run focus-lab --prefix server -- --keep --shots data/focus-lab-shots
//
// The feature is one boolean, but every claim it makes is geometric: that the noisy half of the header
// is GONE (not merely dimmed), that the board actually gets that space back — most of it below 1800px,
// where the account strip is a whole second row — that the socket indicator stays right-aligned once
// the office strip that was doing the spacing is unmounted, that the state survives a reload, and that
// turning it off restores the bar to the pixel. None of that is visible to a typecheck or a bundle grep.
//
// Nocturne is driven too: its taller bar ties with `.topbar.focus` on specificity and loads later, so
// the theme has to answer focus mode itself or the slim bar silently stays 58px there.
//
// Never prod: its own port, its own empty DATA_DIR, bogus account tokens (see lab-harness.cjs).

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Database = require("better-sqlite3");
const { loadChromium, authPassword, requireBuild, boot, killInstance, createChecks, shotDir } = require("./lab-harness.cjs");

const PORT = 4373;
const BASE = `http://127.0.0.1:${PORT}`;
const NAV_TIMEOUT = 45_000; // this box runs near 100% CPU; a cold goto has measured 28s

// 1440 is inside the band where the accounts strip wraps to its own row (900–1799px), which is where
// focus mode gives back the most; 1920 is the single-row bar the owner's monitor actually shows.
const WRAPPED = { width: 1440, height: 900 };
const WIDE = { width: 1920, height: 1000 };

/** Everything focus mode drops. Each only REPORTS state — nothing here is a control a working session
 *  reaches for mid-task, which is exactly the line the feature draws. */
const NOISE = {
  "the account burn strip": ".accounts",
  "the office gnomes": ".office",
  "the task counters": ".stat",
  "the plan-approval gate": ".gate",
  "the notification bell": ".bell",
  "the Git button": ".git-btn",
  "the settings gear": ".settings-btn",
  "the build/sha tag": ".build-tag",
  "the wordmark subtitle": ".wordmark .sub",
};

/** Everything it keeps: the two panel toggles, the socket, and the brand mark. */
const KEPT = {
  "the focus toggle itself": ".focus-toggle",
  "the director-rail toggle": ".rail-toggle",
  "the connection indicator": ".conn",
  "the brand mark": ".brand-logo",
};

const SEED = [
  { title: "Reconcile the weekly usage window after a cap failover", state: "implementing" },
  { title: "Deliverable preview refuses a cross-drive path", state: "review" },
  { title: "Trim the hello snapshot's brief to a preview width", state: "done" },
];

function seed(dataDir) {
  const db = new Database(path.join(dataDir, "orchestrator.sqlite"));
  const at = Date.now();
  const workspace = path.resolve(__dirname, "..", "..");
  const thread = db.prepare(
    `INSERT INTO threads(id, title, state, workspace, brief, raw_prompt, created_at, updated_at)
     VALUES(@id, @title, @state, @workspace, @title, @title, @at, @at)`,
  );
  SEED.forEach((s, i) => {
    thread.run({ id: `lab-thread-${i}`, title: s.title, state: s.state, workspace, at: at - (SEED.length - i) * 60_000 });
  });
  db.close();
}

async function openConsole(context) {
  const page = await context.newPage();
  await page.request.post(`${BASE}/api/login`, { data: { password: authPassword() } });
  await page.goto(`${BASE}/`, { timeout: NAV_TIMEOUT });
  // The account chips are hello-only, so they are the signal that the socket frame landed — the topbar
  // shell mounts long before it, and half of what this lab measures arrives in that frame.
  await page.waitForSelector(".accounts .acct", { timeout: 25_000 });
  return page;
}

const focusOn = (page) => page.evaluate(() => document.querySelector(".topbar").classList.contains("focus"));
const barHeight = (page) => page.evaluate(() => Math.round(document.querySelector(".topbar").getBoundingClientRect().height));
const boardHeight = (page) => page.evaluate(() => Math.round(document.querySelector(".workbench").getBoundingClientRect().height));

/** Click the toggle and wait for the class to flip — the bar re-lays out synchronously after that. */
async function toggle(page, want) {
  await page.click('[aria-label="Toggle top bar detail"]');
  await page.waitForFunction(
    (on) => document.querySelector(".topbar").classList.contains("focus") === on,
    want,
    { timeout: 10_000 },
  );
  await page.waitForTimeout(60);
}

/** Present AND laid out: a `display:none` rule leaves the node in the DOM, so a count is not enough —
 *  the noise check has to fail on a chip that is merely invisible, not only on a removed one. */
function boxes(page, selectors) {
  return page.evaluate((map) => {
    const out = {};
    for (const [name, selector] of Object.entries(map)) {
      const el = document.querySelector(selector);
      const box = el ? el.getBoundingClientRect() : null;
      out[name] = !!box && box.width > 0 && box.height > 0;
    }
    return out;
  }, selectors);
}

const shown = (state) => Object.entries(state).filter(([, v]) => v).map(([k]) => k);
const missing = (state) => Object.entries(state).filter(([, v]) => !v).map(([k]) => k);

async function openAppearance(page) {
  await page.click('[aria-label="Open settings"]');
  await page.waitForSelector('[role="dialog"][aria-label="Settings"]', { timeout: 20_000 });
  // Settings is categorized and opens on General; every other page is in the DOM but `hidden`.
  await page.click('[data-settings-category="appearance"]');
  await page.waitForSelector(".theme-picker", { state: "visible", timeout: 10_000 });
}

async function chooseTheme(page, id) {
  await page.click(`.theme-option[data-theme-option="${id}"]`);
  await page.waitForFunction((want) => (document.documentElement.dataset.theme ?? "classic") === want, id, { timeout: 10_000 });
  await page.waitForTimeout(420); // the cross-fade, so nothing is measured mid-transition
  await page.click('[aria-label="Close settings"]');
  await page.waitForSelector('[role="dialog"][aria-label="Settings"]', { state: "detached", timeout: 10_000 });
}

async function main() {
  requireBuild();
  const check = createChecks();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "focus-lab-"));
  const keep = process.argv.includes("--keep");
  const shots = shotDir(dataDir);
  console.log(`focus-lab — ${BASE} (data ${dataDir})`);

  try {
    // First boot creates the schema; seed into it, then boot again so the hello frame carries the board.
    await boot({ dataDir, port: PORT });
    killInstance(PORT);
    seed(dataDir);
    await boot({ dataDir, port: PORT });

    const browser = await loadChromium().launch();
    try {
      // ONE context: focus mode is a per-browser preference in localStorage, so a fresh context would
      // read the default back and the persistence check below would pass for the wrong reason.
      const context = await browser.newContext({ viewport: WRAPPED });
      const errors = [];
      const page = await openConsole(context);
      // On the page, not the context: these survive the reload below, and a listener attached per-page
      // after each navigation would miss whatever threw during the one navigation being tested.
      page.on("pageerror", (error) => errors.push(String(error)));
      page.on("console", (message) => message.type() === "error" && errors.push(message.text()));

      /* ---- 1. the full bar, at the width where the strip wraps ------------------------------------ */
      check("a fresh console opens with the full bar", (await focusOn(page)) === false);
      const fullNoise = await boxes(page, NOISE);
      check("every noisy element is on screen to begin with", missing(fullNoise).length === 0, missing(fullNoise).join(", "));
      const fullBar = await barHeight(page);
      const fullBoard = await boardHeight(page);
      check(`the strip wraps to a second row at ${WRAPPED.width}px (bar ${fullBar}px)`, fullBar > 90, `${fullBar}px`);
      check(
        "the toggle announces itself as not pressed",
        (await page.getAttribute('[aria-label="Toggle top bar detail"]', "aria-pressed")) === "false",
      );
      await page.locator(".topbar").screenshot({ path: path.join(shots, "topbar-full.png") });

      /* ---- 2. focus mode ------------------------------------------------------------------------- */
      await toggle(page, true);
      const quietNoise = await boxes(page, NOISE);
      check("focus mode leaves none of the noise on screen", shown(quietNoise).length === 0, shown(quietNoise).join(", "));
      const quietKept = await boxes(page, KEPT);
      check("…and keeps every control a working session still clicks", missing(quietKept).length === 0, missing(quietKept).join(", "));
      const quietBar = await barHeight(page);
      check(`the bar collapses to one slim row (${fullBar}px → ${quietBar}px)`, quietBar <= 48 && quietBar < fullBar, `${quietBar}px`);
      const quietBoard = await boardHeight(page);
      check(
        `the board gets that space back, to the pixel (+${quietBoard - fullBoard}px)`,
        quietBoard - fullBoard === fullBar - quietBar,
        `board +${quietBoard - fullBoard}, bar -${fullBar - quietBar}`,
      );
      // The office strip is `flex: 1` — the spacer that right-aligns the socket. Unmounting it without
      // replacing it would leave the live dot marooned mid-bar.
      const connGap = await page.evaluate(
        () => Math.round(innerWidth - document.querySelector(".conn").getBoundingClientRect().right),
      );
      check(`the connection indicator stays right-aligned (${connGap}px from the edge)`, connGap < 30, `${connGap}px`);
      check(
        "the toggle announces itself as pressed",
        (await page.getAttribute('[aria-label="Toggle top bar detail"]', "aria-pressed")) === "true",
      );
      await page.locator(".topbar").screenshot({ path: path.join(shots, "topbar-focus.png") });
      await page.screenshot({ path: path.join(shots, "console-focus.png") });

      /* ---- 3. it survives a reload (a focused session outlives one refresh) ----------------------- */
      check("the choice is persisted for this browser", (await page.evaluate(() => localStorage.getItem("orch-focus-mode"))) === "1");
      await page.reload({ timeout: NAV_TIMEOUT });
      await page.waitForSelector(".topbar", { timeout: 25_000 });
      check("the bar comes back slim after a reload", (await focusOn(page)) === true);
      check("…with the noise still gone", shown(await boxes(page, NOISE)).length === 0);
      const reloadedBar = await barHeight(page);
      check(`…at the same height (${reloadedBar}px)`, reloadedBar === quietBar, `${reloadedBar}px`);

      /* ---- 4. turning it off restores the bar exactly --------------------------------------------- */
      await toggle(page, false);
      const restored = await boxes(page, NOISE);
      check("switching back brings every element home", missing(restored).length === 0, missing(restored).join(", "));
      const restoredBar = await barHeight(page);
      check(`…at exactly the height it started at (${fullBar}px)`, restoredBar === fullBar, `${restoredBar}px`);

      /* ---- 5. the single-row width the owner's monitor shows -------------------------------------- */
      await page.setViewportSize(WIDE);
      await page.waitForSelector(".accounts .acct", { timeout: 10_000 });
      await page.waitForTimeout(150);
      const wideFull = await barHeight(page);
      check(`the strip is inline again at ${WIDE.width}px (bar ${wideFull}px)`, wideFull < 90, `${wideFull}px`);
      await toggle(page, true);
      const wideQuiet = await barHeight(page);
      check(`focus mode still slims the single-row bar (${wideFull}px → ${wideQuiet}px)`, wideQuiet < wideFull, `${wideQuiet}px`);
      check("…and still clears the whole strip", shown(await boxes(page, NOISE)).length === 0);
      await toggle(page, false);

      /* ---- 6. Nocturne, whose taller bar wins the tie unless the theme answers focus itself ------- */
      await openAppearance(page);
      await chooseTheme(page, "nocturne");
      const nocturneFull = await barHeight(page);
      await toggle(page, true);
      const nocturneQuiet = await barHeight(page);
      check(
        `Nocturne slims too, not just Classic (${nocturneFull}px → ${nocturneQuiet}px)`,
        nocturneQuiet <= 52 && nocturneQuiet < nocturneFull,
        `${nocturneQuiet}px`,
      );
      await page.locator(".topbar").screenshot({ path: path.join(shots, "topbar-focus-nocturne.png") });
      await toggle(page, false);
      await openAppearance(page);
      await chooseTheme(page, "classic");

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
  (e) => {
    console.error(e);
    killInstance(PORT);
    process.exit(1);
  },
);
