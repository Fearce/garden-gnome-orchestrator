// Drive the workbench's column layout against a throwaway instance, with the rail/detail widths a
// BIGGER MONITOR would have left behind. That is the state that produced the long-standing "the
// sidepanel is misaligned / half of it is off screen" report.
//
//   npm run layout-lab --prefix server
//   npm run layout-lab --prefix server -- --scenario fresh
//   npm run layout-lab --prefix server -- --shot C:\tmp\before   (save one PNG per width)
//   npm run layout-lab --prefix server -- --list --keep
//
// Why this lab exists, when `probe:chips` already measures geometry: chips measures the TOP BAR, at
// default widths, on a page that was never resized. The bug here lives one layer out, in
// `.workbench`'s grid template, and needs two things no other check supplies. First, a persisted
// `orch-rail-w` / `orch-detail-w` that does not fit the window (they are dragged values replayed
// verbatim from localStorage, so they travel between monitors and machines with the browser profile).
// Second, the window then being made SMALLER than them. Both are seeded here before the first paint.
//
// The invariant it holds is deliberately structural, not cosmetic. `.workbench` is `overflow: hidden`,
// so a template whose tracks sum wider than the container does not scroll: it silently shears the last
// column off the right edge, which is why the symptom read as "misaligned" rather than "too big". So
// every visible pane must sit INSIDE the workbench's own box at every width, and the workbench must
// have nothing to scroll. Anything else (which pane yields first, by how much) is a design choice the
// tracks are free to make.
//
// Safe against prod for the same reasons every lab is: temp DATA_DIR, bogus account tokens, its own
// port, killed by port owner. See lab-harness.cjs's header for the traps that buys you.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Database = require("better-sqlite3");
const { SERVER_ROOT, loadChromium, authPassword, requireBuild, boot, killInstance, createChecks } = require("./lab-harness.cjs");

const PORT = 4351;
const BASE = `http://127.0.0.1:${PORT}`;
const TASK_ID = "layout-lab-task-0000";

/** The board's own floor, from `minmax(320px, 1fr)` in `.workbench`. The detail is held to the same
 *  number, because below it the panel is a sliver with every label cut mid-word, which IS the reported
 *  bug: "not overflowing" is not the same as "usable", and a template could satisfy the first alone. */
const PANE_MIN = 320;

/** Sub-pixel slack. Grid track sizes are fractional and `getBoundingClientRect` reports them that way,
 *  so an exactly-fitting three-track row routinely lands a rounding step outside its container. */
const SLACK = 1;

const SCENARIOS = {
  // The bug's trigger, at the sizes it was reported with: a rail and a detail dragged wide on a large
  // monitor. 760 + 1400 is past the sum of ANY laptop's viewport, so every width below overflows.
  oversized: { rail: 760, detail: 1400, railHidden: false, why: "widths dragged on a bigger monitor" },
  // The shipped defaults. They fit everywhere by construction, so this scenario is the cry-wolf check:
  // it must stay green, or the fix has cost the ordinary case the width it was dragged to.
  fresh: { rail: 384, detail: 480, railHidden: false, why: "the shipped defaults, nothing dragged" },
  // Hiding the rail swaps in a SEPARATE two-track template, which the same persisted detail reaches.
  // It is the variant most easily missed, precisely because it is a different rule.
  "rail-hidden": { rail: 760, detail: 1400, railHidden: true, why: "rail hidden, detail dragged wide" },
};

/** 800 is the compact single-pane band, 1000/1100 the floating-sheet band, and 1184 the first width
 *  at which the three-column desktop template applies (384 + 320 + 480 = 1184 is its own minimum).
 *  Every band gets a width because each is a different rule, and the bug only ever bit in the last. */
const WIDTHS = [800, 1000, 1100, 1184, 1280, 1440, 1920, 2560];

/** One task, parked in `review` so nothing can spawn an agent, with enough feed to fill the panel. An
 *  empty detail is narrow content, and would sit inside a sheared column without looking wrong. */
function seed(dataDir) {
  const db = new Database(path.join(dataDir, "orchestrator.sqlite"));
  const now = Date.now();
  db.prepare(
    "INSERT INTO threads (id, title, state, workspace, brief, raw_prompt, created_at, updated_at) VALUES (?, ?, 'review', ?, ?, ?, ?, ?)",
  ).run(TASK_ID, "Fix the sidepanel misalignment that clips content off screen", SERVER_ROOT, "a seeded task", "a seeded task", now, now);
  const msg = db.prepare(
    "INSERT INTO messages (id, thread_id, run_id, role, kind, content, attachments, created_at) VALUES (?, ?, NULL, ?, ?, ?, '[]', ?)",
  );
  msg.run("layout-lab-m1", TASK_ID, "user", "text", "Reproduce the panel clipping at a narrow window.", now);
  msg.run(
    "layout-lab-m2",
    TASK_ID,
    "implementor",
    "text",
    "The workbench grid replays two persisted column widths that have no relationship to the window they land in.",
    now + 1,
  );
  db.close();
}

/** Every pane's box relative to the workbench's, plus what the grid actually resolved to. Read from
 *  `getComputedStyle`, never from the rule we wrote: styles.css is not the only sheet in the bundle. */
function readLayout(page) {
  return page.evaluate(() => {
    const wb = document.querySelector(".workbench");
    if (!wb) return null;
    const box = (sel) => {
      const el = document.querySelector(sel);
      if (!el) return null;
      const b = el.getBoundingClientRect();
      return { left: b.left, right: b.right, width: b.width, visible: b.width > 0 && b.height > 0 };
    };
    const w = wb.getBoundingClientRect();
    return {
      workbench: { left: w.left, right: w.right, width: w.width, scrollWidth: wb.scrollWidth, clientWidth: wb.clientWidth },
      panes: { rail: box(".rail"), board: box(".board"), detail: box(".detail") },
      template: getComputedStyle(wb).gridTemplateColumns,
      viewport: window.innerWidth,
    };
  });
}

/** The assertions, shared by the cold-load pass and the live-resize pass so the two cannot drift. */
function assertLayout(check, tag, L) {
  if (!L) return check(`${tag} · workbench mounted`, false, "no .workbench in the DOM");
  const px = (n) => `${Math.round(n)}px`;
  const { workbench: wb, panes } = L;

  // The load-bearing one. `overflow: hidden` means an over-wide template cannot scroll, so this is the
  // difference between "the panel is off screen" and "the panel is where it should be".
  check(
    `${tag} · workbench has nothing sheared off (scroll ${px(wb.scrollWidth)} <= client ${px(wb.clientWidth)})`,
    wb.scrollWidth <= wb.clientWidth + SLACK,
    `${px(wb.scrollWidth - wb.clientWidth)} of content is outside the container. template: ${L.template}`,
  );

  for (const [name, p] of Object.entries(panes)) {
    if (!p || !p.visible) continue; // a pane the current band hides (compact shows one at a time)
    check(
      `${tag} · ${name} inside the workbench (${px(p.left)}..${px(p.right)} of ${px(wb.left)}..${px(wb.right)})`,
      p.left >= wb.left - SLACK && p.right <= wb.right + SLACK,
      `${name} sticks out by ${px(Math.max(wb.left - p.left, p.right - wb.right))}. template: ${L.template}`,
    );
    // The board's floor is the grid's own; the detail is held to it because a 120px detail is the bug.
    if (name !== "rail") {
      check(
        `${tag} · ${name} still readable (${px(p.width)} >= ${PANE_MIN}px)`,
        p.width >= PANE_MIN - SLACK,
        `${name} squeezed to ${px(p.width)}. template: ${L.template}`,
      );
    }
  }
}

/** Drag one edge to the far side of the window and report where the handle stopped against where the
 *  pane stopped. The two used to disagree: the drag clamps reserved a CONSTANT for a column that is
 *  itself draggable, so the handle kept travelling into space the grid had already refused to give,
 *  and (on the detail's edge) could bank a width that overflowed the viewport it was dragged in. */
async function dragToEdge(page, handle, towards) {
  const box = await page.locator(handle).boundingBox();
  const y = box.y + box.height / 2;
  await page.mouse.move(box.x + box.width / 2, y);
  await page.mouse.down();
  // Several steps, not one jump: the handler runs per pointermove, and a single move would only ever
  // exercise the clamp once, at the extreme.
  await page.mouse.move(towards, y, { steps: 12 });
  await page.mouse.up();
  await page.waitForTimeout(200);
  return page.evaluate(([sel, key]) => {
    const el = document.querySelector(sel);
    return { rendered: el ? el.getBoundingClientRect().width : 0, stored: Number(localStorage.getItem(key)) };
  }, handle.startsWith(".rail") ? [".rail", "orch-rail-w"] : [".detail", "orch-detail-w"]);
}

/** Log in, replay the scenario's persisted widths BEFORE the first paint, and open the seeded task. */
async function openConsole(browser, scenario, width) {
  const page = await browser.newPage({ viewport: { width, height: 900 } });
  await page.request.post(`${BASE}/api/login`, { data: { password: authPassword() } });
  // addInitScript, not an evaluate after goto: `directorWidth`/`detailWidth` are read once, in the
  // store's initial state, so a value written after that module evaluates is simply never seen.
  await page.addInitScript(
    ([rail, detail, hidden]) => {
      localStorage.setItem("orch-rail-w", String(rail));
      localStorage.setItem("orch-detail-w", String(detail));
      localStorage.setItem("orch-rail-hidden", hidden ? "1" : "0");
    },
    [scenario.rail, scenario.detail, scenario.railHidden],
  );
  // Not `networkidle`: the selected task pulls attachments and the app polls /api/voice/status, so
  // idle is data-dependent and has blown a 30s budget on a busy box (nightly-quality-sweep.md step 6).
  await page.goto(`${BASE}/`, { timeout: 45_000 });
  await page.waitForSelector(".workbench", { timeout: 20_000 });
  await page.click(".card", { timeout: 20_000 });
  await page.waitForSelector(".detail", { timeout: 20_000 });
  await page.waitForTimeout(400); // one layout settle after the panel mounts
  return page;
}

function parseArgs(argv) {
  const args = { scenario: "oversized", shot: null, keep: false, list: false, widths: WIDTHS };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--scenario") args.scenario = argv[++i];
    else if (argv[i] === "--shot") args.shot = argv[++i];
    else if (argv[i] === "--width") args.widths = [Number(argv[++i])];
    else if (argv[i] === "--keep") args.keep = true;
    else if (argv[i] === "--list") args.list = true;
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.list) {
    for (const [name, s] of Object.entries(SCENARIOS)) console.log(`  ${name.padEnd(12)} rail ${s.rail} · detail ${s.detail} : ${s.why}`);
    return 0;
  }
  const scenario = SCENARIOS[args.scenario];
  if (!scenario) {
    console.error(`unknown scenario "${args.scenario}". One of: ${Object.keys(SCENARIOS).join(", ")}`);
    return 2;
  }
  requireBuild();
  if (args.shot) fs.mkdirSync(args.shot, { recursive: true });

  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "layout-lab-"));
  console.log(`layout-lab: "${args.scenario}" (${scenario.why}: rail ${scenario.rail}px, detail ${scenario.detail}px) on ${BASE}`);
  const check = createChecks();
  try {
    await boot({ dataDir, port: PORT });
    killInstance(PORT); // the first boot only creates the schema; seed, then boot against the seeded DB
    seed(dataDir);
    await boot({ dataDir, port: PORT });

    const browser = await loadChromium().launch();
    try {
      // Pass 1: a COLD load at each width, the persisted value arriving in a window that never grew.
      for (const width of args.widths) {
        const page = await openConsole(browser, scenario, width);
        const L = await readLayout(page);
        console.log(`\n  ${width}px cold: ${L?.template ?? "?"}`);
        assertLayout(check, `${width}px cold`, L);
        if (args.shot) await page.screenshot({ path: path.join(args.shot, `${args.scenario}-${width}-cold.png`) });
        await page.close();
      }

      // Pass 2: ONE window shrunk down the ladder. This is the trigger the report describes, where the
      // widths were legal when they were dragged and the window got smaller afterwards. Nothing
      // re-clamps them on a resize, so only the template itself can absorb it.
      const descending = [...args.widths].sort((a, b) => b - a);
      const page = await openConsole(browser, scenario, descending[0]);
      for (const width of descending) {
        await page.setViewportSize({ width, height: 900 });
        await page.waitForTimeout(250);
        const L = await readLayout(page);
        console.log(`\n  ${width}px shrunk: ${L?.template ?? "?"}`);
        assertLayout(check, `${width}px shrunk`, L);
        if (args.shot) await page.screenshot({ path: path.join(args.shot, `${args.scenario}-${width}-shrunk.png`) });
      }
      await page.close();

      // Pass 3: both handles dragged hard against the far side of a window too small to grant it. The
      // saved width has to stop where the pane stops, or the handle detaches from the edge it drags.
      const DRAG_WIDTH = 1440;
      const drags = await openConsole(browser, scenario, DRAG_WIDTH);
      for (const [label, handle, towards] of [
        ["rail", ".rail .resize-handle", DRAG_WIDTH - 4],
        ["detail", ".detail > .resize-handle", 4],
      ]) {
        // A hidden rail has no edge to drag. Assert that pairing rather than skipping quietly: a
        // missing handle beside a VISIBLE pane is the real defect, and a `boundingBox()` on nothing
        // throws a TypeError that says none of this. Test the BOX, not the count: `rail-hidden` is
        // `display: none` on the pane, so the handle is still in the DOM with nothing to grab.
        if ((await drags.locator(handle).boundingBox()) === null) {
          const paneVisible = await drags.evaluate((sel) => {
            const el = document.querySelector(sel);
            return !!el && el.getBoundingClientRect().width > 0;
          }, `.${label}`);
          check(`${DRAG_WIDTH}px drag · no ${label} handle, because there is no ${label} pane to drag`, !paneVisible, `the ${label} is on screen with no resize handle`);
          continue;
        }
        const d = await dragToEdge(drags, handle, towards);
        console.log(`\n  ${DRAG_WIDTH}px drag ${label}: stored ${Math.round(d.stored)}px, rendered ${Math.round(d.rendered)}px`);
        check(
          `${DRAG_WIDTH}px drag · the ${label} handle stops where the pane stops (${Math.round(d.stored)}px stored vs ${Math.round(d.rendered)}px rendered)`,
          Math.abs(d.stored - d.rendered) <= SLACK,
          `${Math.round(Math.abs(d.stored - d.rendered))}px of the drag went into space the grid refused`,
        );
        assertLayout(check, `${DRAG_WIDTH}px after ${label} drag`, await readLayout(drags));
      }
      if (args.shot) await drags.screenshot({ path: path.join(args.shot, `${args.scenario}-${DRAG_WIDTH}-dragged.png`) });
      await drags.close();
    } finally {
      await browser.close();
    }
  } finally {
    killInstance(PORT);
    if (args.keep) console.log(`  kept ${dataDir}`);
    else fs.rmSync(dataDir, { recursive: true, force: true });
  }
  if (args.shot) console.log(`\n  screenshots: ${args.shot}`);
  return check.summary();
}

main().then(
  (code) => process.exit(code),
  (e) => {
    console.error(e);
    killInstance(PORT);
    process.exit(1);
  },
);
