// Drive the console at PHONE widths — a real headless browser in a touch context, across the
// 320–430px band, against a throwaway instance, without touching prod.
//
//   npm run phone-lab --prefix server
//   npm run phone-lab --prefix server -- --keep            leave the instance up to poke at
//   npm run phone-lab --prefix server -- --widths 320,390
//
// It answers ONE question, for every board view the app declares: can a finger actually get there
// on a phone? Not "is it in the DOM", not "is it inside the viewport" — can it be hit, and does
// tapping it land on that view.
//
// Why it exists (2026-08-28): the Supervisor board view shipped unreachable on a phone, and every
// check in this repo was green over it.
//   • `probe:chips` measures GEOMETRY, and the Supervisor tab's geometry is fine — at 320px its
//     right edge is 319px, fully inside the viewport. Nothing is clipped, nothing overflows the
//     screen, nothing is display:none.
//   • `tablet-lab` DOES hit-test, but its narrowest viewport is 800px, where `.board-tabs` still
//     fits on one row and the bug does not exist. The whole phone band was untested by anything.
//   • The actual failure: `.board-head` is a flex row, the tab strip overflows it below ~500px, and
//     `.board-head-right` (the "N total" caption + SortMenu) paints on top of the spill and wins the
//     hit test. `elementFromPoint` at the tab's centre returns `.sort-prefix` / `.sort-trigger` /
//     `.board-head-right` / `.faint.mono` depending on width.
// So the lesson this file encodes is: **"inside the viewport" is not "tappable".** A geometry-only
// assertion passes on all five widths below. Only a hit test sees it.
//
// It is also a COVERAGE gate, not just a regression test: the view list is read from the `BoardView`
// union in web/src/types.ts, so adding a fifth board view fails here until it has a declared tab and
// a reachable phone entry point.
//
// Why it can't disturb anything: temp DATA_DIR (prod's sqlite is never opened, and an empty thread
// table means the on-boot auto-resume has nothing to revive), bogus account tokens (the boot ping can
// neither burn quota nor start a real 5h window), alt port, killed by port owner.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Database = require("better-sqlite3");
const { SERVER_ROOT, loadChromium, authPassword, requireBuild, boot, killInstance, createChecks } = require("./lab-harness.cjs");

// Ports in use by sibling labs: 4327, 4331, 4337, 4347, 4351, 4381, 4383, 4385 — plus each one's
// `port + 2` HTTPS listener. 4391/4393 is clear of both sets. Getting this wrong does NOT fail
// loudly: `boot()` polls `/api/me`, so it resolves against the OTHER lab's instance while this one
// dies of EADDRINUSE, and the first symptom is a bare "no such table" from seeding an empty DB.
const PORT = 4391;
const BASE = `http://127.0.0.1:${PORT}`;
const TASK_ID = "phone-lab-task-0000";
const WEB_SRC = path.resolve(SERVER_ROOT, "..", "web", "src");

// The realistic phone band. 320 is the narrowest phone still sold (SE-class) and the width the CSS
// floor is written against; 360 is the commonest Android; 375/390 are the current iPhone pair; 430
// is the Pro Max. The bug this lab exists for reproduces at every one of them, so a single width
// would have caught it — the spread is here to catch the NEXT one, which may straddle a breakpoint.
const DEFAULT_WIDTHS = [320, 360, 375, 390, 430];

// A fingertip is ~9mm. 44px is the WCAG 2.5.8 / Android floor, and --tap in styles.css. The bottom
// nav is the one surface with no excuse to sit under it: it is a short row on a full-width bar.
const TAP_MIN = 44;

const check = createChecks();

// ---- what the app declares ---------------------------------------------------------------------

/** The board views the app knows about, read from the type union rather than hardcoded — so a new
 *  view arrives here automatically and has to earn a phone entry point. */
function declaredViews() {
  const src = fs.readFileSync(path.join(WEB_SRC, "types.ts"), "utf8");
  const m = src.match(/export type BoardView\s*=\s*([^;]+);/);
  if (!m) throw new Error("could not find the BoardView union in web/src/types.ts — update this parser");
  const views = [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]);
  if (!views.length) throw new Error("BoardView union parsed empty — update this parser");
  return views;
}

/** The desktop tab strip's own table: view -> label. The label is also how a bottom-nav button is
 *  matched, so a nav button whose text drifts from its tab shows up as an unreachable view. */
function declaredTabs() {
  const src = fs.readFileSync(path.join(WEB_SRC, "components", "Board.tsx"), "utf8");
  const block = src.match(/const BOARD_TABS[^=]*=\s*\[([\s\S]*?)\n\];/);
  if (!block) throw new Error("could not find BOARD_TABS in web/src/components/Board.tsx — update this parser");
  const tabs = {};
  for (const m of block[1].matchAll(/\{\s*view:\s*"([^"]+)",\s*label:\s*"([^"]+)"/g)) tabs[m[1]] = m[2];
  if (!Object.keys(tabs).length) throw new Error("BOARD_TABS parsed empty — update this parser");
  return tabs;
}

/** The element that proves a view actually rendered — not the tab's own active styling, which a
 *  broken switch would still show. A new view needs a row here; the coverage check enforces it. */
const PANEL_ROOT = {
  tasks: ".lanes, .board .empty",
  cowork: ".cowork-shell",
  notes: ".notes-view",
  schedules: ".sched-view",
  supervisor: ".supervisor-view",
};

const ACCOUNT_ENV = { ACCOUNT_1_ID: "acct1", ACCOUNT_1_LABEL: "personal", ACCOUNT_2_ID: "acct2", ACCOUNT_2_LABEL: "vota" };

/** `boot()` resolves on `/api/me`, which another lab's instance on the same port answers just as
 *  happily — so a green boot does not prove THIS instance is up, only that something is. Wait for
 *  our own DATA_DIR to actually carry the schema before seeding into it, and say which of the two
 *  went wrong rather than surfacing a bare "no such table: kv" from the first prepare(). */
async function openWhenMigrated(dataDir) {
  const file = path.join(dataDir, "orchestrator.sqlite");
  for (let i = 0; i < 40; i++) {
    try {
      const db = new Database(file);
      const ok = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='kv'").get();
      if (ok) return db;
      db.close();
    } catch {
      /* file not created yet */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(
    `${file} never gained a schema. Almost always a PORT COLLISION: something else already owns ` +
      `:${PORT}, so boot() saw ITS /api/me while this lab's own server died of EADDRINUSE. ` +
      `Check with: Get-NetTCPConnection -LocalPort ${PORT}`,
  );
}

/** One task parked in `review` (so nothing spawns an agent) plus healthy account snapshots.
 *  The task matters: `.board-head-right` — the caption + SortMenu cluster that intercepts the last
 *  tab — renders on the Tasks view, and a REALISTIC title is what makes the row wrap the way prod's
 *  does. Account usage is only read at boot, hence the caller's second boot. */
async function seed(dataDir) {
  const db = await openWhenMigrated(dataDir);
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
  ).run(TASK_ID, "Enable menu revision for 1% of locations behind a flag", SERVER_ROOT, "a seeded task", "a seeded task", now, now);
  db.close();
}

// ---- the measurement ---------------------------------------------------------------------------

/** Every candidate entry point for `view`, with whether a finger would actually land on it. Runs in
 *  the page. Returns an nth-child selector so the caller taps the REAL control — a synthetic click
 *  would sail straight through the overlap this lab exists for. */
function collectEntryPoints({ view, label }) {
  const probe = (el, container, index) => {
    const r = el.getBoundingClientRect();
    const sized = r.width > 0 && r.height > 0;
    const hit = sized ? document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2) : null;
    const owned = !!hit && (hit === el || el.contains(hit));
    return {
      container,
      selector: `${container} > :nth-child(${index + 1})`,
      w: Math.round(r.width),
      h: Math.round(r.height),
      right: Math.round(r.right),
      onScreen: sized && r.right <= innerWidth && r.left >= 0 && r.bottom <= innerHeight && r.top >= 0,
      tappable: owned,
      // What actually took the tap, so a failure names the culprit instead of just saying "no".
      blockedBy: hit && !owned ? (hit.className.toString().trim() || hit.tagName.toLowerCase()).slice(0, 48) : null,
    };
  };

  const out = [];
  const nav = document.querySelector(".mobile-nav");
  if (nav) {
    [...nav.children].forEach((el, i) => {
      if ((el.textContent || "").trim() === label) out.push({ route: "bottom nav", ...probe(el, ".mobile-nav", i) });
    });
  }
  const strip = document.querySelector(".board-tabs");
  if (strip) {
    [...strip.children].forEach((el, i) => {
      const isTab = el.classList.contains("bt-" + view);
      // The ACTIVE view renders as a heading, not a button — being already here counts as reachable.
      const isActiveHeading = el.tagName === "H2" && (el.textContent || "").trim() === label;
      if (isTab || isActiveHeading) {
        out.push({ route: isActiveHeading ? "board tab (already active)" : "board tab", ...probe(el, ".board-tabs", i) });
      }
    });
  }
  return out;
}

/** The bottom nav's own controls, for the tap-target floor. */
const collectNavButtons = () =>
  [...document.querySelectorAll(".mobile-nav .mnav-btn")].map((el) => {
    const r = el.getBoundingClientRect();
    return { text: (el.textContent || "").trim(), w: Math.round(r.width), h: Math.round(r.height) };
  });

/** Back to the default board view, without relying on the very navigation under test. */
async function resetToBoard(page) {
  await page.goto(`${BASE}/`, { timeout: 45_000 });
  await page.waitForSelector(".topbar", { timeout: 20_000 });
  // Server-authoritative surfaces render neutral defaults until the WS hello lands; `.accounts .acct`
  // is hello-only, so it is the signal that the page is really ready to measure.
  await page.waitForSelector(".accounts .acct", { timeout: 20_000 });
  await page.waitForSelector(".board-tabs", { timeout: 20_000 });
  await page.waitForTimeout(250);
}

async function drivePass(page, width, views, tabs) {
  const height = 844;
  console.log(`\n════ ${width}×${height}, touch, dpr 3`);
  await page.setViewportSize({ width, height });
  await resetToBoard(page);

  const media = await page.evaluate(() => ({
    coarse: matchMedia("(pointer: coarse)").matches,
    compact: matchMedia("(max-width: 899.98px)").matches,
  }));
  // Fence everything below behind these: without them the pass measures the desktop treatment and
  // every later assertion passes for the wrong reason.
  check(`${width}: really a coarse pointer in the compact band`, media.coarse && media.compact, JSON.stringify(media));
  check(`${width}: the bottom nav is rendered`, !!(await page.$(".mobile-nav")));

  for (const btn of await page.evaluate(collectNavButtons)) {
    check(`${width}: nav "${btn.text}" meets the ${TAP_MIN}px tap floor`, btn.h >= TAP_MIN && btn.w >= TAP_MIN, `${btn.w}×${btn.h}`);
  }

  for (const view of views) {
    const label = tabs[view];
    // Every view is measured from the DEFAULT board — the state carrying the sort cluster that
    // caused the interception, and the one a phone user actually starts from.
    await resetToBoard(page);
    const candidates = await page.evaluate(collectEntryPoints, { view, label });
    const usable = candidates.find((c) => c.tappable);

    const detail = candidates.length
      ? candidates
          .map(
            (c) =>
              `${c.route}: ${c.tappable ? "tappable" : `BLOCKED by ${c.blockedBy ?? "nothing (zero-size)"}`}` +
              ` [${c.w}×${c.h} right=${c.right}${c.onScreen ? "" : " OFF-SCREEN"}]`,
          )
          .join(" | ")
      : "no entry point in the DOM at all";
    check(`${width}: "${label}" is reachable`, !!usable, detail);
    if (!usable) continue;

    if (usable.route === "board tab (already active)") {
      check(`${width}: "${label}" is the view on screen`, !!(await page.$(PANEL_ROOT[view])));
      continue;
    }

    await page.tap(usable.selector);
    await page.waitForTimeout(300);
    const landed = await page.evaluate(
      ({ root }) => ({
        heading: (document.querySelector(".board-tabs h2")?.textContent || "").trim(),
        panel: !!document.querySelector(root),
      }),
      { root: PANEL_ROOT[view] },
    );
    check(
      `${width}: tapping "${label}" (${usable.route}) lands on that view`,
      landed.heading === label && landed.panel,
      `heading="${landed.heading}" panel=${landed.panel}`,
    );
  }
}

/** A lab drives the BUILT bundle; fail loudly rather than measuring the previous one. */
function requireFreshWebBuild() {
  const built = fs.statSync(path.resolve(SERVER_ROOT, "..", "web", "dist", "index.html")).mtimeMs;
  let newest = 0;
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else newest = Math.max(newest, fs.statSync(p).mtimeMs);
    }
  };
  walk(WEB_SRC);
  if (newest > built) {
    console.error("web/dist is older than web/src — run `npm run build --prefix web` first, or this lab measures the previous bundle.");
    process.exit(2);
  }
}

/** The just-killed instance can hold its sqlite file open for a moment; on Windows that is an EBUSY,
 *  not a no-op, which would otherwise throw away a whole green run at the cleanup step. */
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

function parseWidths() {
  const i = process.argv.indexOf("--widths");
  if (i < 0) return DEFAULT_WIDTHS;
  const list = (process.argv[i + 1] || "")
    .split(",")
    .map((s) => parseInt(s.trim(), 10))
    .filter((n) => n > 0);
  return list.length ? list : DEFAULT_WIDTHS;
}

(async () => {
  const keep = process.argv.includes("--keep");
  requireBuild();
  requireFreshWebBuild();
  killInstance(PORT);

  const views = declaredViews();
  const tabs = declaredTabs();

  // Coverage: the union is the source of truth, so a new board view fails here until it is wired.
  console.log(`\n════ COVERAGE — the BoardView union declares: ${views.join(", ")}`);
  for (const v of views) {
    check(`"${v}" has a BOARD_TABS row`, !!tabs[v], "add it to BOARD_TABS in web/src/components/Board.tsx");
    check(`"${v}" has a panel root for this lab to verify`, !!PANEL_ROOT[v], "add it to PANEL_ROOT in this file");
  }
  const reachable = views.filter((v) => tabs[v] && PANEL_ROOT[v]);

  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "phone-lab-"));
  let browser;
  try {
    // First boot creates the schema; account snapshots are only read at boot, so seed and re-boot.
    await boot({ dataDir, port: PORT, env: ACCOUNT_ENV });
    seed(dataDir);
    killInstance(PORT);
    await boot({ dataDir, port: PORT, env: ACCOUNT_ENV });

    browser = await loadChromium().launch();
    // hasTouch/isMobile are CONTEXT options — a viewport alone leaves Chromium reporting a fine
    // pointer, and every coarse-pointer rule would go unmeasured.
    const ctx = await browser.newContext({
      viewport: { width: DEFAULT_WIDTHS[0], height: 844 },
      hasTouch: true,
      isMobile: true,
      deviceScaleFactor: 3,
    });
    const page = await ctx.newPage();
    await page.request.post(`${BASE}/api/login`, { data: { password: authPassword() } });
    try {
      for (const w of parseWidths()) await drivePass(page, w, reachable, tabs);
    } finally {
      await ctx.close();
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
