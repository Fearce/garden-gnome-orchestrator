// Drive Settings → Appearance in a real browser, headlessly, against a THROWAWAY instance.
//
//   npm run appearance-lab --prefix server
//   npm run appearance-lab --prefix server -- --keep --shots <dir>   # --shots is relative to server/
//
// `test:themes` proves the theme's CSS is scoped and its picker renders. It cannot prove the claim the
// feature actually makes to the owner: that switching away and back leaves Classic EXACTLY as it was.
// That is a question about computed style in a live document, so this snapshots the real console under
// Classic, switches to Nocturne, reloads (the theme is a per-browser preference, so persistence is the
// feature), switches back, and asserts the snapshot is identical property for property.
//
// It also checks the pre-paint script: the theme has to be on <html> before the bundle runs, or every
// reload flashes Classic. That is invisible to a check that only looks at the settled page, so the
// probe reads the attribute at `domcontentloaded`, before React has mounted.
//
// Never prod: its own port, its own empty DATA_DIR, bogus account tokens (see lab-harness.cjs).

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Database = require("better-sqlite3");
const { loadChromium, authPassword, requireBuild, boot, killInstance, createChecks, shotDir } = require("./lab-harness.cjs");

const PORT = 4371;
const BASE = `http://127.0.0.1:${PORT}`;
const NAV_TIMEOUT = 45_000; // this box runs near 100% CPU; a cold goto has measured 28s

/** Enough of a board to photograph: a theme's biggest surfaces are the task card and the transcript,
 *  and an empty console shows neither. Three states so the card's state rail has something to colour. */
const SEED = [
  { title: "Reconcile the weekly usage window after a cap failover", state: "implementing" },
  { title: "Deliverable preview refuses a cross-drive path", state: "review" },
  { title: "Trim the hello snapshot's brief to a preview width", state: "done" },
];

function seed(dataDir) {
  const db = new Database(path.join(dataDir, "orchestrator.sqlite"));
  const at = Date.now();
  // A workspace is absolute in prod; resolve this checkout so the seed says something true on any machine.
  const workspace = path.resolve(__dirname, "..", "..");
  const thread = db.prepare(
    `INSERT INTO threads(id, title, state, workspace, brief, raw_prompt, created_at, updated_at)
     VALUES(@id, @title, @state, @workspace, @title, @title, @at, @at)`,
  );
  const message = db.prepare(
    `INSERT INTO messages(id, thread_id, role, kind, content, created_at) VALUES(@id, @threadId, @role, @kind, @content, @at)`,
  );
  SEED.forEach((s, i) => {
    const id = `lab-thread-${i}`;
    thread.run({ id, title: s.title, state: s.state, workspace, at: at - (SEED.length - i) * 60_000 });
    message.run({ id: `${id}-m0`, threadId: id, role: "implementor", kind: "text", content: `Working ${s.title.toLowerCase()}.`, at: at - 30_000 });
    message.run({ id: `${id}-m1`, threadId: id, role: "implementor", kind: "tool", content: "Read server/src/db/db.ts", at: at - 20_000 });
  });
  db.close();
}

/** The surfaces a theme touches hardest, and the properties Classic must get back unchanged. */
const SNAPSHOT = [
  { name: "topbar", selector: ".topbar", props: ["backgroundImage", "minHeight", "boxShadow"] },
  { name: "board heading", selector: ".board-head h2", props: ["fontFamily", "fontSize", "textTransform", "color"] },
  { name: "director rail", selector: ".rail", props: ["backgroundColor", "backgroundImage", "borderRightColor"] },
  { name: "workbench", selector: ".workbench", props: ["backgroundImage"] },
  { name: "primary button", selector: ".btn.primary", props: ["backgroundColor", "color", "borderRadius"] },
  { name: "composer", selector: ".composer textarea", props: ["backgroundColor", "borderColor", "borderRadius"] },
  { name: "page", selector: "body", props: ["backgroundColor", "color", "fontFamily"] },
  { name: "task card", selector: ".card", props: ["backgroundColor", "borderRadius", "boxShadow", "padding"] },
  { name: "task card title", selector: ".card .title", props: ["fontFamily", "fontSize", "fontWeight"] },
  { name: "board tab", selector: ".board-tab", props: ["fontFamily", "fontSize", "textTransform"] },
];

/** getComputedStyle for each watched surface — the state a theme is allowed to change, and Classic
 *  is not. A selector that matches nothing is recorded as such rather than skipped, so a renamed
 *  class can't quietly turn this into a comparison of two empty objects. */
function readStyles(page) {
  return page.evaluate((spec) => {
    const out = {};
    for (const { name, selector, props } of spec) {
      const el = document.querySelector(selector);
      if (!el) {
        out[name] = "MISSING";
        continue;
      }
      const cs = getComputedStyle(el);
      out[name] = Object.fromEntries(props.map((p) => [p, cs[p]]));
    }
    return out;
  }, SNAPSHOT);
}

const activeTheme = (page) => page.evaluate(() => document.documentElement.dataset.theme ?? null);

/** Wait until nothing on `selector` is mid-transition.
 *
 *  `getComputedStyle` reports the ANIMATED value, so reading a card the instant it stops being the
 *  selected one returns the selection tint it is still fading out of — which is indistinguishable
 *  from Classic having been changed, and is what made the drift check fail on a correct build. Only
 *  CSS transitions are awaited: Classic's live dot runs an infinite keyframe animation, so waiting on
 *  `getAnimations()` wholesale would never return. */
function settled(page, selector) {
  return page.waitForFunction(
    (sel) => {
      const el = document.querySelector(sel);
      if (!el) return false;
      return el.getAnimations({ subtree: true }).every((a) => a.constructor.name !== "CSSTransition");
    },
    selector,
    { timeout: 10_000 },
  );
}

async function openConsole(context) {
  const page = await context.newPage();
  await page.request.post(`${BASE}/api/login`, { data: { password: authPassword() } });
  await page.goto(`${BASE}/`, { timeout: NAV_TIMEOUT });
  // Wait for the socket's `hello`, not just the shell: the account chips are the only hello-only
  // element, and a half-rendered console would give the style snapshot neutral defaults to compare.
  await page.waitForSelector(".accounts .acct", { timeout: 25_000 });
  await page.waitForSelector(".card", { timeout: 15_000 });
  return page;
}

async function openAppearance(page) {
  await page.click('[aria-label="Open settings"]');
  await page.waitForSelector('[role="dialog"][aria-label="Settings"]', { timeout: 20_000 });
  // Settings is categorized and opens on General; every other page is in the DOM but `hidden`.
  await page.click('[data-settings-category="appearance"]');
  await page.waitForSelector(".theme-picker", { state: "visible", timeout: 10_000 });
}

/** Below 900px the category rail is replaced by a `<select>`, so the desktop click never resolves. */
async function openAppearanceNarrow(page) {
  await page.click('[aria-label="Open settings"]');
  await page.waitForSelector('[role="dialog"][aria-label="Settings"]', { timeout: 20_000 });
  await page.selectOption('.settings-mobile-nav select[aria-label="Settings category"]', "appearance");
  await page.waitForSelector(".theme-picker", { state: "visible", timeout: 10_000 });
}

async function closeSettings(page) {
  await page.click('[aria-label="Close settings"]');
  await page.waitForSelector('[role="dialog"][aria-label="Settings"]', { state: "detached", timeout: 10_000 });
}

/** Pick a theme and let the cross-fade (320ms, lib/theme.ts) finish before anything is measured. */
async function choose(page, id) {
  await page.click(`.theme-option[data-theme-option="${id}"]`);
  await page.waitForFunction(
    (want) => (document.documentElement.dataset.theme ?? "classic") === want,
    id,
    { timeout: 10_000 },
  );
  await page.waitForTimeout(420);
}

function diffStyles(before, after) {
  const changed = [];
  for (const [surface, props] of Object.entries(before)) {
    if (props === "MISSING" || after[surface] === "MISSING") {
      changed.push(`${surface}: selector matched nothing`);
      continue;
    }
    for (const [prop, value] of Object.entries(props)) {
      if (after[surface][prop] !== value) changed.push(`${surface}.${prop}: "${value}" → "${after[surface][prop]}"`);
    }
  }
  return changed;
}

async function main() {
  requireBuild();
  const check = createChecks();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "appearance-lab-"));
  const keep = process.argv.includes("--keep");
  const shots = shotDir(dataDir);
  console.log(`appearance-lab — ${BASE} (data ${dataDir})`);

  try {
    // First boot creates the schema; seed into it, then boot again so the hello frame carries the board.
    await boot({ dataDir, port: PORT });
    killInstance(PORT);
    seed(dataDir);
    await boot({ dataDir, port: PORT });

    const browser = await loadChromium().launch();
    try {
      // ONE context for the whole run. `browser.newPage()` makes its own throwaway context, and the
      // theme is a per-browser preference in localStorage — so the reload check below would open a
      // blank profile and read Classic back, which looks exactly like a setting that never persisted.
      const context = await browser.newContext({ viewport: { width: 1500, height: 950 } });
      // The console must be self-sufficient: its typefaces are bundled (@fontsource), so nothing
      // owes a request to a CDN. Every request the pages make is collected and asserted same-origin
      // at the end — an offline LAN console silently falling back to Georgia is invisible otherwise.
      const foreign = [];
      context.on("request", (r) => {
        const url = r.url();
        if (/^https?:/i.test(url)) {
          const { host } = new URL(url);
          if (host !== `127.0.0.1:${PORT}`) foreign.push(url);
        }
      });
      const page = await openConsole(context);

      check("a fresh console is Classic, with no attribute on <html>", (await activeTheme(page)) === null, String(await activeTheme(page)));
      const classicBefore = await readStyles(page);
      check(
        "every watched surface is present to compare",
        !Object.values(classicBefore).includes("MISSING"),
        JSON.stringify(classicBefore),
      );

      await openAppearance(page);
      check("the Appearance page renders the picker", (await page.locator(".theme-picker").count()) === 1);
      check("it offers exactly the two themes", (await page.locator(".theme-option").count()) === 2);

      // With the picker open, Classic is active but the Nocturne tile still renders its serif
      // wordmark, so every family the console names has live text to load for. `document.fonts`
      // status is the only proof the FACE arrived — a computed font-family just echoes the stack,
      // which reads as success while an unloaded face quietly falls through to Georgia.
      await page.evaluate(() => document.fonts.ready);
      const loadedFaces = await page.evaluate(() => [...document.fonts].filter((f) => f.status === "loaded").map((f) => f.family));
      for (const family of ["Inter Tight", "JetBrains Mono", "Instrument Serif"]) {
        check(`the bundled "${family}" face actually loaded (no silent fallback)`, loadedFaces.includes(family), loadedFaces.join(", "));
      }
      check(
        "Classic is marked as the active one",
        (await page.getAttribute('.theme-option[data-theme-option="classic"]', "aria-checked")) === "true",
      );
      await page.locator(".settings-pop").screenshot({ path: path.join(shots, "appearance-classic.png") });

      // A radio group is walked with the arrows, and the tiles are buttons — nothing gives that for
      // free, so it is driven here rather than inferred from the markup.
      await page.focus('.theme-option[data-theme-option="classic"]');
      await page.keyboard.press("ArrowRight");
      check("an arrow key moves the selection", (await activeTheme(page)) === "nocturne", String(await activeTheme(page)));
      await page.keyboard.press("ArrowLeft");
      check(
        "and wraps back, keeping focus inside the group",
        (await activeTheme(page)) === null &&
          (await page.evaluate(() => document.activeElement?.getAttribute("data-theme-option"))) === "classic",
        String(await activeTheme(page)),
      );

      await choose(page, "nocturne");
      check("choosing Nocturne marks <html>", (await activeTheme(page)) === "nocturne", String(await activeTheme(page)));
      await page.locator(".settings-pop").screenshot({ path: path.join(shots, "appearance-nocturne.png") });
      await closeSettings(page);

      const nocturne = await readStyles(page);
      const moved = diffStyles(classicBefore, nocturne);
      // The point of a THEME: it has to actually change the console, on more than one surface.
      check(`Nocturne repaints the console (${moved.length} computed properties changed)`, moved.length >= 8, moved.join("; "));
      check(
        "the page background is genuinely a different colour",
        nocturne.page.backgroundColor !== classicBefore.page.backgroundColor,
        `${classicBefore.page.backgroundColor} vs ${nocturne.page.backgroundColor}`,
      );
      check(
        "board headings switch to the serif",
        nocturne["board heading"].fontFamily !== classicBefore["board heading"].fontFamily &&
          /Instrument Serif/.test(nocturne["board heading"].fontFamily),
        nocturne["board heading"].fontFamily,
      );
      check(
        "task titles switch to the serif too",
        /Instrument Serif/.test(nocturne["task card title"].fontFamily),
        nocturne["task card title"].fontFamily,
      );
      // The switcher is a heading beside plain buttons; restyling only the heading splits the row.
      check(
        "the board's view switcher stays one control",
        nocturne["board tab"].fontFamily === nocturne["board heading"].fontFamily &&
          nocturne["board tab"].fontSize === nocturne["board heading"].fontSize,
        `${nocturne["board tab"].fontFamily} ${nocturne["board tab"].fontSize} vs ${nocturne["board heading"].fontFamily} ${nocturne["board heading"].fontSize}`,
      );
      check(
        "cards gain the theme's softer corner",
        nocturne["task card"].borderRadius !== classicBefore["task card"].borderRadius,
        `${classicBefore["task card"].borderRadius} → ${nocturne["task card"].borderRadius}`,
      );
      await page.screenshot({ path: path.join(shots, "console-nocturne.png") });
      await page.click(".card");
      await page.waitForSelector(".detail .fi", { timeout: 15_000 });
      await page.screenshot({ path: path.join(shots, "console-nocturne-task.png") });
      await page.close();

      // A reload proves BOTH that the choice persisted and that the pre-paint script ran: the attribute
      // has to already be on <html> at domcontentloaded, before the bundle has executed.
      const reloaded = await context.newPage();
      await reloaded.goto(`${BASE}/`, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT });
      check("the theme is painted before the bundle mounts (no Classic flash)", (await activeTheme(reloaded)) === "nocturne", String(await activeTheme(reloaded)));
      await reloaded.waitForSelector(".accounts .acct", { timeout: 25_000 });
      check("it survives a reload", (await activeTheme(reloaded)) === "nocturne", String(await activeTheme(reloaded)));

      // ---- phone width -----------------------------------------------------------------------
      // Every theme rule out-specifies Classic's media blocks (an attribute selector beats a bare
      // class), so a theme that restyles a heading has to restate Classic's compact size or the
      // tablet deck gets desktop type in a phone column. That is invisible at 1500px.
      await reloaded.setViewportSize({ width: 430, height: 900 });
      await reloaded.waitForSelector(".card", { timeout: 15_000 });
      const phoneTitle = await reloaded.evaluate(() => getComputedStyle(document.querySelector(".card .title")).fontSize);
      check("the serif card title takes the theme's compact phone size", phoneTitle === "16.5px", phoneTitle);

      await openAppearanceNarrow(reloaded);
      const columns = await reloaded.evaluate(() => getComputedStyle(document.querySelector(".theme-picker")).gridTemplateColumns);
      check("the picker drops to one column on a phone", columns.trim().split(/\s+/).length === 1, columns);
      await reloaded.locator(".settings-pop").screenshot({ path: path.join(shots, "appearance-phone.png") });
      await closeSettings(reloaded);
      await reloaded.setViewportSize({ width: 1500, height: 950 });
      await reloaded.waitForSelector(".card", { timeout: 15_000 });

      // The claim the whole feature rests on.
      await openAppearance(reloaded);
      check(
        "Nocturne is marked as the active one after the reload",
        (await reloaded.getAttribute('.theme-option[data-theme-option="nocturne"]', "aria-checked")) === "true",
      );
      await choose(reloaded, "classic");
      check("switching back removes the attribute entirely", (await activeTheme(reloaded)) === null, String(await activeTheme(reloaded)));
      await closeSettings(reloaded);

      await reloaded.click(".card");
      await reloaded.waitForSelector(".detail .fi", { timeout: 15_000 });
      await reloaded.screenshot({ path: path.join(shots, "console-classic-task.png") });
      // The panel's own ✕ — a second click on the selected card re-selects it, it does not deselect.
      await reloaded.click('.detail .close-x[aria-label="Close"]');
      await reloaded.waitForSelector(".detail", { state: "detached", timeout: 10_000 });
      // Back to where the pointer sat for the first snapshot: the panel closing slides the board out
      // under the cursor, and a card left under it is :hover, which is a real difference in Classic.
      await reloaded.mouse.move(0, 0);
      await settled(reloaded, ".board");

      const classicAfter = await readStyles(reloaded);
      const drift = diffStyles(classicBefore, classicAfter);
      check(`Classic comes back EXACTLY as it was (${SNAPSHOT.length} surfaces, property for property)`, drift.length === 0, drift.join("; "));
      await reloaded.screenshot({ path: path.join(shots, "console-classic-restored.png") });
      await reloaded.close();

      check(
        `every request stayed on this origin (typefaces bundled, no font CDN)`,
        foreign.length === 0,
        foreign.slice(0, 5).join(", "),
      );

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
