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
  { name: "masthead", selector: ".wordmark .sub", props: ["fontFamily", "fontSize", "letterSpacing"] },
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

/** Whether a computed font-family resolves to a serif. The trailing `sans-serif` keyword of every
 *  ordinary sans stack is stripped first, or this would fire on all of them. */
const isSerif = (family) =>
  /(^|[\s,"'])serif\b|georgia|times|instrument serif|source serif/i.test(family.replace(/sans-serif/gi, ""));

/** The three typeface attributes, as the pre-paint script and lib/font.ts write them. */
const activeFonts = (page) =>
  page.evaluate(() => ({
    ui: document.documentElement.dataset.font ?? null,
    mono: document.documentElement.dataset.fontMono ?? null,
    display: document.documentElement.dataset.fontDisplay ?? null,
  }));

/** The families actually in use, which is the only thing a font choice is allowed to change here.
 *  `.conn` is a top-bar readout set in --font-mono, so the tokens are read from live elements rather
 *  than from the token block: an option that changes the variable but reaches nothing looks identical
 *  in :root. The masthead and a task card's header are the heading channel's own two surfaces, and
 *  the reason it exists: the first is hard-set in mono as chrome and the second is re-faced by a
 *  theme, so neither of the other pickers could ever reach them. */
const usedFaces = (page) =>
  page.evaluate(() => {
    const family = (selector) => getComputedStyle(document.querySelector(selector)).fontFamily;
    return {
      body: family("body"),
      mono: family(".conn"),
      masthead: family(".wordmark .sub"),
      title: family(".card .title"),
    };
  });

/** The three pickers, in the order Settings renders them, paired with the attribute each one writes. */
const PICKERS = { interface: [0, "font"], heading: [1, "fontDisplay"], monospace: [2, "fontMono"] };

/** Pick a face in one of the three pickers and wait for <html> to agree. */
async function chooseFont(page, group, id) {
  const [index, attr] = PICKERS[group];
  await page.locator(".font-picker").nth(index).locator(`[data-font-option="${id}"]`).click();
  await page.waitForFunction(
    ({ attr, id }) => (document.documentElement.dataset[attr] ?? "default") === id,
    { attr, id },
    { timeout: 10_000 },
  );
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

      const classicFaces = await usedFaces(page);
      for (const [surface, family] of [
        ["masthead", classicFaces.masthead],
        ["task card header", classicFaces.title],
      ]) {
        check(`a fresh console's ${surface} is not a serif`, !isSerif(family), family);
      }

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
      // The theme owns the heading SCALE, not the face. It used to face this whole tier in
      // Instrument Serif, which handed a serif to every console that had chosen no heading
      // typeface and could not see a picker for one ("Theme default is still a serif font for the
      // titles", 2026-09-12). So what a theme is now allowed to change here is the size.
      check(
        "board headings take the theme's own scale",
        nocturne["board heading"].fontSize !== classicBefore["board heading"].fontSize,
        `${classicBefore["board heading"].fontSize} -> ${nocturne["board heading"].fontSize}`,
      );
      check(
        "task titles take it too",
        nocturne["task card title"].fontSize !== classicBefore["task card title"].fontSize,
        `${classicBefore["task card title"].fontSize} -> ${nocturne["task card title"].fontSize}`,
      );
      // And the claim the owner actually made. Checked on the COMPUTED family of the two surfaces
      // he named, with no heading face chosen, because a static scan of the sheets cannot see what
      // the cascade finally resolved to.
      const themedDefault = await usedFaces(page);
      for (const [surface, family] of [
        ["masthead", themedDefault.masthead],
        ["task card header", themedDefault.title],
      ]) {
        check(
          `a theme imposes no serif on the ${surface} when no heading face is chosen`,
          !isSerif(family),
          family,
        );
      }
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
      check("the card title takes the theme's compact phone size", phoneTitle === "15.5px", phoneTitle);

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

      // ---- typefaces -------------------------------------------------------------------------
      // Same claim as the theme's, one level down: the default sets NO attribute, so choosing and
      // un-choosing a face has to land back on the exact families a console that never opened this
      // page renders in. And the two choices are independent, which is only provable by watching a
      // --font-mono element while the interface face changes.
      const defaultFaces = await usedFaces(reloaded);
      await openAppearance(reloaded);
      check("the Appearance page renders all three typeface pickers", (await reloaded.locator(".font-picker").count()) === 3);

      await chooseFont(reloaded, "interface", "source-serif");
      const serif = await usedFaces(reloaded);
      check("choosing an interface face repaints the chrome", serif.body !== defaultFaces.body && /Source Serif/.test(serif.body), serif.body);
      check(
        "and leaves the monospace areas exactly as they were",
        serif.mono === defaultFaces.mono,
        `${defaultFaces.mono} -> ${serif.mono}`,
      );

      await chooseFont(reloaded, "monospace", "fira-code");
      const both = await usedFaces(reloaded);
      check("choosing a monospace face repaints the transcript face", /Fira Code/.test(both.mono), both.mono);
      check("without disturbing the interface face", both.body === serif.body, `${serif.body} -> ${both.body}`);

      // ---- the heading face ------------------------------------------------------------------
      // The channel the owner asked for, and the two surfaces that named the bug: the masthead is
      // mono chrome, so the interface picker never reached it, and a task card's header is re-faced
      // by Nocturne, so under that theme the interface picker did not reach it either.
      check(
        "the masthead is mono CHROME, so until now only the monospace picker could move it",
        defaultFaces.masthead === defaultFaces.mono && both.masthead === both.mono,
        `${defaultFaces.masthead} / ${both.masthead} vs ${both.mono}`,
      );
      await chooseFont(reloaded, "heading", "bricolage");
      const headed = await usedFaces(reloaded);
      check("choosing a heading face repaints the masthead", /Bricolage/.test(headed.masthead), headed.masthead);
      check("and a task card's header with it", /Bricolage/.test(headed.title), headed.title);
      check(
        "while the interface and monospace faces stay exactly where they were",
        headed.body === both.body && headed.mono === both.mono,
        `${JSON.stringify(both)} -> ${JSON.stringify(headed)}`,
      );
      await closeSettings(reloaded);
      await reloaded.screenshot({ path: path.join(shots, "console-heading-bricolage.png") });
      await openAppearance(reloaded);

      // The second face, and the one that matters most: Nocturne draws this whole tier in its own
      // serif, and an explicit pick has to out-specify that or the owner's choice does nothing.
      await choose(reloaded, "nocturne");
      const nocturneHeaded = await usedFaces(reloaded);
      check(
        "a chosen heading face survives switching to a theme that faces the same tier",
        /Bricolage/.test(nocturneHeaded.title) && /Bricolage/.test(nocturneHeaded.masthead),
        `${nocturneHeaded.masthead} / ${nocturneHeaded.title}`,
      );
      await chooseFont(reloaded, "heading", "space-grotesk");
      const grotesque = await usedFaces(reloaded);
      check(
        "and switching faces under that theme repaints both surfaces again",
        /Space Grotesk/.test(grotesque.masthead) && /Space Grotesk/.test(grotesque.title),
        `${grotesque.masthead} / ${grotesque.title}`,
      );
      await reloaded.locator(".settings-pop").screenshot({ path: path.join(shots, "appearance-heading-picker.png") });
      await closeSettings(reloaded);
      await reloaded.screenshot({ path: path.join(shots, "console-heading-space-grotesk-nocturne.png") });
      await openAppearance(reloaded);

      // Back to Classic FIRST, then to the heading default, so the rest of the pass measures the
      // console it was measuring before. Clearing the face under Nocturne would hand these two
      // surfaces to the THEME's serif, which is a different console to compare against.
      await choose(reloaded, "classic");
      await chooseFont(reloaded, "heading", "default");
      const unheaded = await usedFaces(reloaded);
      check(
        "choosing the heading default hands both surfaces straight back to the console's own faces",
        unheaded.masthead === both.masthead && unheaded.title === both.title,
        `${JSON.stringify(both)} -> ${JSON.stringify(unheaded)}`,
      );

      // A computed font-family only echoes the stack; `document.fonts` is the one thing that proves
      // the FACE arrived instead of falling through to the next entry, which is what an unbundled
      // font looks like on an offline LAN console.
      await reloaded.evaluate(() => document.fonts.ready);
      const chosenFaces = await reloaded.evaluate(() => [...document.fonts].filter((f) => f.status === "loaded").map((f) => f.family));
      for (const family of ["Source Serif 4 Variable", "Fira Code Variable"]) {
        check(`the chosen "${family}" face actually loaded (no silent fallback)`, chosenFaces.includes(family), chosenFaces.join(", "));
      }
      // Left set, so the reload below proves the heading attribute is pre-painted like the other two.
      await chooseFont(reloaded, "heading", "instrument-sans");
      await reloaded.evaluate(() => document.fonts.ready);
      const headingFaces = await reloaded.evaluate(() => [...document.fonts].filter((f) => f.status === "loaded").map((f) => f.family));
      check(
        'the chosen "Instrument Sans Variable" face actually loaded (no silent fallback)',
        headingFaces.includes("Instrument Sans Variable"),
        headingFaces.join(", "),
      );
      await reloaded.locator(".settings-pop").screenshot({ path: path.join(shots, "appearance-typefaces.png") });
      await closeSettings(reloaded);
      await reloaded.screenshot({ path: path.join(shots, "console-source-serif.png") });
      await reloaded.close();

      // The pre-paint script again, and for a harder reason than the theme's: a face applied after
      // the bundle loads reflows the entire console, on every single load.
      const refonted = await context.newPage();
      await refonted.goto(`${BASE}/`, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT });
      check(
        "all three faces are painted before the bundle mounts (no reflow on load)",
        JSON.stringify(await activeFonts(refonted)) ===
          JSON.stringify({ ui: "source-serif", mono: "fira-code", display: "instrument-sans" }),
        JSON.stringify(await activeFonts(refonted)),
      );
      await refonted.waitForSelector(".accounts .acct", { timeout: 25_000 });
      await refonted.waitForSelector(".card", { timeout: 15_000 });
      check("and they survive the reload", /Source Serif/.test((await usedFaces(refonted)).body), (await usedFaces(refonted)).body);

      await openAppearance(refonted);
      await chooseFont(refonted, "heading", "instrument-serif");
      await refonted.locator(".settings-pop").screenshot({ path: path.join(shots, "appearance-heading-serif.png") });
      await closeSettings(refonted);
      const serifHeadings = await usedFaces(refonted);
      check(
        "a display serif reaches the masthead and the card headers on Classic too",
        /Instrument Serif/.test(serifHeadings.masthead) && /Instrument Serif/.test(serifHeadings.title),
        `${serifHeadings.masthead} / ${serifHeadings.title}`,
      );
      // Instrument Serif has ONE weight, so Classic's 600 would be drawn as a synthetic bold, and it
      // sets small for its em. The face carries its own weight and size for the title tier; without
      // them a card header is a smeared 15px, which is the whole reason per-face tuning exists here.
      const serifTitle = await refonted.evaluate(() => {
        const cs = getComputedStyle(document.querySelector(".card .title"));
        return { weight: cs.fontWeight, size: cs.fontSize };
      });
      check(
        "and brings its own weight and size, so it is never drawn as a synthetic bold",
        serifTitle.weight === "400" && serifTitle.size === "18.5px",
        JSON.stringify(serifTitle),
      );
      await refonted.screenshot({ path: path.join(shots, "console-heading-instrument-serif.png") });
      await openAppearance(refonted);

      await chooseFont(refonted, "interface", "default");
      await chooseFont(refonted, "monospace", "default");
      await chooseFont(refonted, "heading", "default");
      check(
        "choosing the default back removes all three attributes entirely",
        JSON.stringify(await activeFonts(refonted)) === JSON.stringify({ ui: null, mono: null, display: null }),
        JSON.stringify(await activeFonts(refonted)),
      );
      const restoredFaces = await usedFaces(refonted);
      check(
        "and the console renders in exactly the families it started in",
        JSON.stringify(restoredFaces) === JSON.stringify(defaultFaces),
        `${JSON.stringify(defaultFaces)} -> ${JSON.stringify(restoredFaces)}`,
      );

      // The specimen row carries a nowrap sample line, so a phone is where it would overflow.
      await refonted.setViewportSize({ width: 430, height: 900 });
      await refonted.waitForSelector(".font-picker", { state: "visible", timeout: 10_000 });
      const rowOverflow = await refonted.evaluate(() => {
        const row = document.querySelector(".font-option");
        return row.scrollWidth - row.clientWidth;
      });
      check("a typeface row fits its column on a phone", rowOverflow <= 0, `overflow ${rowOverflow}px`);
      await refonted.locator(".settings-pop").screenshot({ path: path.join(shots, "appearance-typefaces-phone.png") });
      await refonted.close();

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
