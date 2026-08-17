// Drive the console the way a tablet does — a real headless browser in a TOUCH context, at both
// orientations of Kevin's Lenovo TB328FU (1920×1200 at dpr 1.5 ⇒ 1280×800 landscape, 800×1280
// portrait) — against a throwaway instance, without touching prod.
//
//   npm run tablet-lab --prefix server
//   npm run tablet-lab --prefix server -- --keep   (leave the instance up to poke at)
//
// Use it for any change to the touch/tablet blocks at the end of web/src/styles.css, to the
// hover-revealed controls, or to anything that has to stay reachable with a finger.
//
// Why a lab and not `probe:chips`: the browser probes run with a FINE pointer, so they cannot see a
// single rule in the coarse-pointer or hover:none blocks — those blocks are, structurally, invisible
// to every other check in this repo. `hasTouch` + `isMobile` are CONTEXT options (not viewport ones),
// and setting them is what makes Chromium report `pointer: coarse` / `hover: none`; the first
// assertion in each pass proves that actually happened, because every later assertion is vacuous
// otherwise.
//
// Why it can't disturb anything: temp DATA_DIR (prod's sqlite is never opened, and an empty thread
// table means the on-boot auto-resume has nothing to revive), bogus account tokens (the boot ping can
// neither burn quota nor start a real 5h window), alt port, killed by port owner.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Database = require("better-sqlite3");
const { SERVER_ROOT, loadChromium, authPassword, requireBuild, boot, killInstance, createChecks } = require("./lab-harness.cjs");

const PORT = 4347;
const BASE = `http://127.0.0.1:${PORT}`;
const TASK_ID = "tablet-lab-task-0000";

// A fingertip is ~9mm. 44px is the WCAG 2.5.8 / Android floor, and --tap in styles.css.
const TAP_MIN = 44;

// Controls the coarse block deliberately leaves below 44px, each because the row it lives in cannot
// hold a 44px chip without wrapping into a second row that costs more than the extra 10px buys.
// A NEW entry here is a design decision — justify it, don't just silence the sweep.
const TAP_EXCEPTIONS = [
  { sel: ".agent-toggle", min: 34, why: "pipeline gates: 5 chips in the rail header, 44 wraps the row" },
  { sel: ".fchip", min: 34, why: "feed filter: a horizontally-scrolled strip of 8" },
  { sel: ".rail-search-toggle", min: 34, why: "sits in the same rail-header row as the gates" },
  { sel: ".board-tab", min: 34, why: "a text heading that doubles as the view switcher" },
  { sel: ".card-chatroom", min: 34, why: "inline in a card's meta row" },
  { sel: ".closed-toggle", min: 34, why: "a quiet disclosure line under the board's lanes" },
  // These two only render with 2+ remembered repos, which this lab's fresh DB never has — they were
  // found by `~/.claude/scripts/tablet-audit.cjs` against prod, not here. Keep the entries anyway so
  // the two tools agree the day a seeded run does produce them.
  { sel: ".repo-chip-pick", min: 34, why: "one chip per remembered repo; 44 would double the composer" },
  { sel: ".repo-chip-x", min: 34, why: "the forget-this-repo ✕ welded to its chip" },
  { sel: ".changes-chip", min: 34, why: "inline on a card whose whole face is already the tap target" },
  { sel: ".mode-toggle", min: 34, why: "113px wide; a 44px row would push the composer down again" },
  { sel: ".card-dismiss", min: 32, why: "corner glyph on a card that is itself the tap target" },
  { sel: ".dl-more", min: 34, why: "welded to the 44px file icon it belongs to; full height, half width" },
  { sel: ".gc-link", min: 34, why: "a text link in the Git console's section headers" },
  { sel: ".gc-split-caret", min: 34, why: "the caret half of a split button whose main half is full size" },
  { sel: "input[type=checkbox]", min: 24, why: "WCAG 2.5.8 AA; one per file row, whose body is the 44px target" },
  { sel: ".rail-search-clear", min: 32, why: "inside the search field, not beside it" },
  { sel: ".thumb-x", min: 26, why: "corner badge on a 52px attachment thumbnail" },
  { sel: ".office-walker", min: 38, why: "the gnome sprite's own box — resizing it breaks the walk" },
];

/** The account identities the top bar renders. Without them the strip doesn't mount at all, and the
 *  top bar this lab measures would be missing the row that makes it wrap in the first place. */
const ACCOUNT_ENV = {
  ACCOUNT_1_ID: "acct1",
  ACCOUNT_1_LABEL: "personal",
  ACCOUNT_2_ID: "acct2",
  ACCOUNT_2_LABEL: "vota",
};

/** Park one task in `review` (so nothing spawns an agent) with two deliverables: one previewable and
 *  one that is not — the second is the case whose icon used to be inert on every device. Plus two
 *  healthy account snapshots, which `bootPing` only reads at startup (hence the second boot). */
function seed(dataDir) {
  const db = new Database(path.join(dataDir, "orchestrator.sqlite"));
  const now = Date.now();
  const usage = db.prepare("INSERT INTO kv(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value");
  for (const [id, fiveHour] of [["acct1", 34], ["acct2", 61]]) {
    usage.run(
      `account_usage_${id}`,
      JSON.stringify({
        holdUntil: null, extWakeAt: null, fiveHour, sevenDay: 52,
        fiveHourReset: now + 2 * 3_600_000, sevenDayReset: now + 4 * 86_400_000, usageAt: now - 60_000,
      }),
    );
  }
  db.prepare(
    "INSERT INTO threads (id, title, state, workspace, brief, raw_prompt, created_at, updated_at) VALUES (?, ?, 'review', ?, ?, ?, ?, ?)",
  ).run(TASK_ID, "Tablet lab task", SERVER_ROOT, "a seeded task", "a seeded task", now, now);
  const finding = db.prepare(
    "INSERT INTO findings (id, thread_id, from_role, kind, summary, detail, path, label, severity, routed, created_at) VALUES (?, ?, 'implementor', 'deliverable', ?, ?, ?, ?, 'info', 0, ?)",
  );
  // Distinct created_at: listFindings orders by it and SQLite's sort is not stable on ties, so equal
  // timestamps would make `.dl-chip:nth-child(2)` land on either file at random.
  finding.run("tablet-lab-dl-md", TASK_ID, "Sweep report", "The nightly report", path.join(SERVER_ROOT, "data", "report.md"), "Sweep report", now);
  finding.run("tablet-lab-dl-bin", TASK_ID, "Trace capture", "An opaque capture", path.join(SERVER_ROOT, "data", "trace.bin"), "Trace capture", now + 1);
  db.close();
}

// ---- the measurements -------------------------------------------------------------------------

/** Every visible control under `root`, with its box — minus prose links, which are inline by nature
 *  and would make the tap sweep meaningless. `classes` is the FULL list: matching the exception table
 *  against a truncated one would fail an element whose exempt class happens to sort late. */
const collectControls = (rootSel) =>
  [...(document.querySelector(rootSel) ?? document).querySelectorAll("button, a[href], input, select, [role='button']")]
    .filter((el) => !el.closest(".transcript, .feed, .md-p, .md-li, .markdown"))
    .map((el) => {
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      return {
        classes: el.className.toString().split(/\s+/).filter(Boolean),
        tag: el.tagName === "INPUT" ? `input[type=${el.type}]` : el.tagName.toLowerCase(),
        cls: (el.className.toString() || el.tagName.toLowerCase()).split(" ").slice(0, 3).join("."),
        txt: (el.textContent || el.getAttribute("aria-label") || "").trim().slice(0, 18),
        w: Math.round(r.width),
        h: Math.round(r.height),
        visible: r.width > 0 && r.height > 0 && cs.visibility !== "hidden" && cs.display !== "none",
      };
    })
    .filter((c) => c.visible);

/** Anything wider than the window it lives in — the failure mode .app's overflow:hidden turns into
 *  content you cannot scroll to rather than a scrollbar. */
const collectOverflow = () => {
  const vw = document.documentElement.clientWidth;
  const out = [];
  for (const sel of ["html", ".app", ".workbench", ".board", ".detail"]) {
    const el = document.querySelector(sel);
    if (el && el.scrollWidth > el.clientWidth + 1) out.push(`${sel} scrolls ${el.scrollWidth} in ${el.clientWidth}`);
  }
  const bar = document.querySelector(".topbar");
  for (const el of bar ? [...bar.children] : []) {
    const r = el.getBoundingClientRect();
    if (r.width > 0 && r.right > vw + 1) out.push(`.${el.className.toString().split(" ")[0]} off-screen (right=${Math.round(r.right)} vw=${vw})`);
  }
  // The detail is overflow:hidden and its rows clip their own children, so a control that spills out
  // of the sheet never grows any scrollWidth — it just silently disappears. Measure it directly.
  const detail = document.querySelector(".detail");
  if (detail) {
    const dr = detail.getBoundingClientRect();
    for (const el of detail.querySelectorAll("*")) {
      const cs = getComputedStyle(el);
      if (cs.position === "fixed" || cs.display === "none") continue;
      const r = el.getBoundingClientRect();
      if (r.width > 0 && r.right > dr.right + 1) {
        out.push(`.${(el.className.toString() || el.tagName).split(" ")[0]} spills out of the detail (${Math.round(r.right)} > ${Math.round(dr.right)})`);
      }
    }
  }
  return out;
};

const rectOf = (page, sel) => page.$eval(sel, (el) => {
  const r = el.getBoundingClientRect();
  return { top: r.top, left: r.left, right: r.right, bottom: r.bottom, w: r.width, h: r.height };
});

const inViewport = (r, vw, vh) => r.left >= -1 && r.top >= -1 && r.right <= vw + 1 && r.bottom <= vh + 1;

// ---- the drive --------------------------------------------------------------------------------

const check = createChecks();

/** Measure every control under `rootSel` against TAP_MIN, honouring the documented exceptions. */
async function sweep(page, label, rootSel) {
  const controls = await page.evaluate(collectControls, rootSel);
  const small = controls.filter((c) => {
    const exc = TAP_EXCEPTIONS.find((e) => e.sel === c.tag || c.classes.some((k) => e.sel === `.${k}`));
    return Math.min(c.w, c.h) < (exc ? exc.min : TAP_MIN);
  });
  check(
    `${label}: ${controls.length} controls all meet their target size`,
    small.length === 0,
    small.map((c) => `${c.cls}${c.txt ? `["${c.txt}"]` : ""} ${c.w}×${c.h}`).join(", "),
  );
}

async function drivePass(page, { name, width, height }) {
  console.log(`\n════ ${name.toUpperCase()} — ${width}×${height}, touch, dpr 1.5`);
  const errors = [];
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  page.on("pageerror", (e) => errors.push(String(e)));

  await page.request.post(`${BASE}/api/login`, { data: { password: authPassword() } });
  await page.goto(`${BASE}/`, { timeout: 45_000 });
  // Drag-to-reorder is a localStorage view setting, off by default — so the coarse activation
  // constraint and .card.draggable's touch-action would never be exercised. Turn it on and reload.
  await page.evaluate(() => localStorage.setItem("director_settings", JSON.stringify({ taskDragAndDrop: true })));
  await page.reload({ timeout: 45_000 });
  await page.waitForSelector(".topbar", { timeout: 20_000 });
  // The strip mounts off the WS hello, after the bar itself — wait for it, or the topbar geometry
  // measured below is one row short of the one the tablet actually gets.
  await page.waitForSelector(".accounts .acct", { timeout: 20_000 });
  await page.waitForSelector(".card", { timeout: 20_000 });

  // Everything below is fenced behind these two queries. If the emulation isn't reporting them, the
  // whole pass is measuring the desktop treatment and passing for the wrong reason.
  const media = await page.evaluate(() => ({
    coarse: matchMedia("(pointer: coarse)").matches,
    noHover: matchMedia("(hover: none)").matches,
    compact: matchMedia("(max-width: 899.98px)").matches,
  }));
  check(`${name}: the context really is a coarse, hoverless pointer`, media.coarse && media.noHover, JSON.stringify(media));
  check(
    `${name}: it lands in the ${width < 900 ? "compact" : "landscape"} band`,
    media.compact === width < 900,
    `compact=${media.compact}`,
  );
  // The band each layout rule belongs to, read off the element rather than off the stylesheet: an
  // equally specific declaration later in the file silently beats one inside a media query.
  const order = await page.$eval(".accounts", (el) => getComputedStyle(el).order);
  check(`${name}: the accounts strip took the right band's order`, order === (width < 900 ? "5" : "20"), `order=${order}`);

  console.log("\n  LAYOUT — nothing wider than the screen");
  check(`${name}: no horizontal overflow, top bar intact`, (await page.evaluate(collectOverflow)).length === 0, (await page.evaluate(collectOverflow)).join(" | "));

  console.log("\n  DETAIL — open a task, reach its controls, close it");
  await page.tap(".card");
  await page.waitForSelector(".detail-head", { timeout: 10_000 });
  const detail = await rectOf(page, ".detail");
  check(`${name}: the detail pane is on screen`, inViewport(detail, width, height), JSON.stringify(detail));
  if (width >= 900) {
    check(`${name}: …as a right-anchored sheet clear of the top bar`, detail.right >= width - 1 && detail.top > 0, JSON.stringify(detail));
    const boardPad = await page.$eval(".board", (el) => getComputedStyle(el).paddingRight);
    check(`${name}: …with the board padded out from under it`, parseFloat(boardPad) > 400, boardPad);
  }
  const close = await rectOf(page, '.detail-head .close-x:not(.head-toggle)');
  check(`${name}: its ✕ is on screen and tappable`, inViewport(close, width, height) && Math.min(close.w, close.h) >= TAP_MIN, JSON.stringify(close));
  const composer = await rectOf(page, ".inject-bar textarea");
  check(`${name}: the inject composer is fully visible`, inViewport(composer, width, height), JSON.stringify(composer));
  // A detector that cannot detect is worse than none — the rows inside .detail clip their own
  // children, so prove the collector sees a deliberate spill before trusting it to report zero.
  const proof = await page.evaluate((collect) => {
    const probe = Object.assign(document.createElement("div"), { className: "spill-probe" });
    probe.style.cssText = "position:absolute;left:0;top:0;width:200vw;height:4px";
    document.querySelector(".detail").appendChild(probe);
    const seen = new Function(`return (${collect})()`)();
    probe.remove();
    return seen;
  }, collectOverflow.toString());
  check(`${name}: the spill detector fires on a planted overflow`, proof.some((s) => s.includes("spill-probe")), proof.join(" | "));
  const spill = await page.evaluate(collectOverflow);
  check(`${name}: nothing spills out of the open detail`, spill.length === 0, spill.join(" | "));
  const dismissOpacity = await page.$eval(".card .card-dismiss", (el) => getComputedStyle(el).opacity).catch(() => "absent");
  check(`${name}: a card's ✕ is visible with no hover to reveal it`, dismissOpacity === "1", `opacity=${dismissOpacity}`);

  console.log("\n  DELIVERABLES — the hover-only actions have a tap route");
  await page.waitForSelector(".dl-chip", { timeout: 10_000 });
  check(`${name}: the ⋯ trigger is rendered`, await page.isVisible(".dl-chip:first-child .dl-more"));
  await page.tap(".dl-chip:first-child .dl-more");
  await page.waitForSelector(".dl-pop.open", { timeout: 5_000 });
  const download = await rectOf(page, ".dl-pop.open a.btn");
  check(`${name}: Download is on screen`, inViewport(download, width, height), JSON.stringify(download));
  check(`${name}: …and Copy path with it`, await page.isVisible('.dl-pop.open button:has-text("Copy path")'));
  await page.tap(".deliverables-label"); // outside the chip, and inert (the title is click-to-rename)
  await page.waitForSelector(".dl-pop.open", { state: "detached", timeout: 5_000 }).catch(() => {});
  check(`${name}: tapping away closes it`, (await page.$(".dl-pop.open")) === null);
  // The second chip is a .bin — no preview to open, so its icon used to do nothing at all.
  await page.tap(".dl-chip:nth-child(2) .dl-chip-btn");
  await page.waitForSelector(".dl-chip:nth-child(2) .dl-pop.open", { timeout: 5_000 }).catch(() => {});
  check(`${name}: a file with no preview opens its actions instead of nothing`, await page.isVisible(".dl-chip:nth-child(2) .dl-pop.open"));

  // Swept with the popover still OPEN so View / Download / Copy path are measured too — they are
  // .btn.sm, the class that needed a min-WIDTH, and they only exist while the popover is up.
  console.log("\n  TAP TARGETS — every visible control");
  await sweep(page, `${name}: the console`, ".app");

  const shot = path.join(SERVER_ROOT, "data", `tablet-${name}.png`);
  await page.tap(".deliverables-label");
  await page.screenshot({ path: shot, fullPage: false });

  console.log("\n  DISMISS — the ✕ actually closes the pane");
  await page.tap('.detail-head .close-x:not(.head-toggle)');
  await page.waitForSelector(".detail", { state: "detached", timeout: 5_000 }).catch(() => {});
  check(`${name}: tapping ✕ closes the detail`, (await page.$(".detail")) === null);

  console.log("\n  BOARD DRAG — a coarse pointer reorders by press-and-hold, not by 6px");
  await page.waitForSelector(".card.draggable", { timeout: 10_000 });
  const dragCss = await page.$eval(".card.draggable", (el) => ({
    touch: getComputedStyle(el).touchAction,
    grip: getComputedStyle(el.querySelector(".card-grip")).opacity,
  }));
  check(`${name}: a draggable card opts out of double-tap zoom`, dragCss.touch === "manipulation", JSON.stringify(dragCss));
  check(`${name}: …and shows its grip with no hover`, dragCss.grip === "1", JSON.stringify(dragCss));
  // The regression this guards: under {distance: 6} a tap that drifts a few px starts a reorder
  // instead of opening the task. Under the delay constraint a quick tap must still just select.
  await page.tap(".card.draggable");
  await page.waitForSelector(".detail-head", { timeout: 10_000 }).catch(() => {});
  check(`${name}: a quick tap still opens the task rather than starting a reorder`, (await page.$(".detail")) !== null);
  // Portrait's detail is a full-screen overlay ABOVE the top bar, so it has to go before the Git
  // button is reachable at all.
  await page.tap('.detail-head .close-x:not(.head-toggle)');
  await page.waitForSelector(".detail", { state: "detached", timeout: 5_000 });

  console.log("\n  GIT CONSOLE — its own control vocabulary, its own density block");
  await page.tap('[aria-label="Open Git"]');
  await page.waitForSelector(".gc-window", { timeout: 30_000 });
  await page.waitForSelector(".gc-btn", { timeout: 30_000 });
  await sweep(page, `${name}: the Git console`, ".gc-window");
  await page.tap(".gc-close");
  await page.waitForSelector(".gc-window", { state: "detached", timeout: 10_000 }).catch(() => {});

  console.log("\n  POISON PILL — widths persisted from a large monitor");
  // localStorage is per-origin and the tablet uses the HTTPS port, so in practice these are almost
  // always the 384/480 defaults — which is exactly why a green run on the defaults proves nothing
  // about the clamp. Force the values a desktop session would have left behind.
  await page.evaluate(() => {
    localStorage.setItem("orch-detail-w", "760");
    localStorage.setItem("orch-rail-w", "700");
  });
  await page.reload({ timeout: 45_000 });
  await page.waitForSelector(".card", { timeout: 20_000 });
  await page.tap(".card");
  await page.waitForSelector(".detail-head", { timeout: 10_000 });
  check(`${name}: still no overflow with a 760px detail + 700px rail`, (await page.evaluate(collectOverflow)).length === 0, (await page.evaluate(collectOverflow)).join(" | "));
  // Assert the INVARIANT --sheet-w claims (one full 300px lane survives), not "the sheet is on screen":
  // the sheet is right:0-anchored, so it is inside the viewport at any width, clamp or no clamp.
  // Measured off the board's real content box, which is what the padding-right actually leaves.
  const boardBox = await page.$eval(".board", (el) => {
    const cs = getComputedStyle(el);
    return Math.round(el.getBoundingClientRect().width - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight));
  });
  check(
    `${name}: the clamp still leaves the board a readable column`,
    boardBox >= 300,
    `board content box = ${boardBox}px (detail ${Math.round((await rectOf(page, ".detail")).w)}px)`,
  );

  check(`${name}: no console errors during the pass`, errors.length === 0, errors.slice(0, 3).join(" | "));
  console.log(`\n  screenshot: ${shot}`);
}

// ---- run ---------------------------------------------------------------------------------------

/** requireBuild() only asserts web/dist EXISTS. For a lab whose entire verdict is CSS that is the
 *  sharpest way to be green about nothing: an unbuilt edit leaves the lab measuring the previous
 *  bundle and reporting it as a pass. Refuse to run against a bundle older than its sources. */
function requireFreshWebBuild() {
  const src = path.resolve(SERVER_ROOT, "..", "web", "src");
  const built = fs.statSync(path.resolve(SERVER_ROOT, "..", "web", "dist", "index.html")).mtimeMs;
  let newest = 0;
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else newest = Math.max(newest, fs.statSync(p).mtimeMs);
    }
  };
  walk(src);
  if (newest > built) {
    console.error("web/dist is older than web/src — run `npm run build --prefix web` first, or this lab measures the previous bundle.");
    process.exit(2);
  }
}

/** The just-killed instance can hold its sqlite file open for a moment, and on Windows that is an
 *  EBUSY, not a no-op — which would otherwise throw away a whole green run at the cleanup step. */
async function rmWithRetry(dir) {
  for (let i = 0; ; i++) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      return;
    } catch (e) {
      if (i === 19) return void console.log(`\n  (temp dir left behind — ${e.code}: ${dir})`);
      await new Promise((r) => setTimeout(r, 250));
    }
  }
}

(async () => {
  const keep = process.argv.includes("--keep");
  requireBuild();
  requireFreshWebBuild();
  killInstance(PORT);

  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "tablet-lab-"));
  let browser;
  try {
    // First boot creates the schema; the account snapshots are only read at boot, so seed and re-boot.
    await boot({ dataDir, port: PORT, env: ACCOUNT_ENV });
    seed(dataDir);
    killInstance(PORT);
    await boot({ dataDir, port: PORT, env: ACCOUNT_ENV });
    browser = await loadChromium().launch();
    for (const o of [
      { name: "landscape", width: 1280, height: 800 },
      { name: "portrait", width: 800, height: 1280 },
    ]) {
      // hasTouch/isMobile are CONTEXT options — newPage({viewport}) alone leaves Chromium reporting a
      // fine pointer, and every coarse/hover rule below would go unmeasured.
      const ctx = await browser.newContext({
        viewport: { width: o.width, height: o.height },
        hasTouch: true,
        isMobile: true,
        deviceScaleFactor: 1.5,
      });
      try {
        await drivePass(await ctx.newPage(), o);
      } finally {
        await ctx.close();
      }
    }
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
