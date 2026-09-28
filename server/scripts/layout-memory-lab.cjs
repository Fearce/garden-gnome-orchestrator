// Drive the per-combination pane widths against a throwaway instance: every combination of the two
// hide toggles (director rail, focus-mode header) remembers the widths last dragged under it, and
// flipping a toggle swaps straight back to them. Walks the owner's own four views, cycles through them
// again, then reloads to prove the memory is persisted rather than held in the tab.
//
//   npm run layout-memory-lab --prefix server
//   npm run layout-memory-lab --prefix server -- --shot C:\tmp\layout-memory
//
// Safe against prod for the same reasons every lab is: temp DATA_DIR, its own port, killed by port
// owner. See lab-harness.cjs's header for the traps that buys you.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Database = require("better-sqlite3");
const { SERVER_ROOT, loadChromium, authPassword, requireBuild, boot, killInstance, createChecks } = require("./lab-harness.cjs");

const PORT = 4363;
const BASE = `http://127.0.0.1:${PORT}`;
const TASK_ID = "layout-memory-lab-task-0000";
const VIEWPORT = { width: 1920, height: 1000 };
const SLACK = 2;

/** One task parked in `review` so nothing spawns an agent — the detail panel just needs to open. */
function seed(dataDir) {
  const db = new Database(path.join(dataDir, "orchestrator.sqlite"));
  const now = Date.now();
  db.prepare(
    "INSERT INTO threads (id, title, state, workspace, brief, raw_prompt, created_at, updated_at) VALUES (?, ?, 'review', ?, ?, ?, ?, ?)",
  ).run(TASK_ID, "Remember the pane widths per hide combination", SERVER_ROOT, "a seeded task", "a seeded task", now, now);
  db.close();
}

async function openTask(page) {
  await page.waitForSelector(".workbench", { timeout: 20_000 });
  await page.click(".card", { timeout: 20_000 });
  await page.waitForSelector(".detail", { timeout: 20_000 });
  await page.waitForTimeout(300);
}

async function dragHandle(page, handle, toX) {
  const box = await page.locator(handle).boundingBox();
  const y = box.y + box.height / 2;
  await page.mouse.move(box.x + box.width / 2, y);
  await page.mouse.down();
  await page.mouse.move(toX, y, { steps: 10 });
  await page.mouse.up();
  await page.waitForTimeout(200);
}

async function toggle(page, button) {
  await page.click(button);
  await page.waitForTimeout(250);
}

/** Rendered widths, read from the panes themselves — a hidden rail reads null. */
function widths(page) {
  return page.evaluate(() => {
    const w = (sel) => {
      const el = document.querySelector(sel);
      const width = el ? el.getBoundingClientRect().width : 0;
      return width > 0 ? Math.round(width) : null;
    };
    return {
      detail: w(".detail"),
      rail: w(".rail"),
      railHidden: localStorage.getItem("orch-rail-hidden") === "1",
      focus: localStorage.getItem("orch-focus-mode") === "1",
    };
  });
}

function near(a, b) {
  return a != null && b != null && Math.abs(a - b) <= SLACK;
}

function parseArgs(argv) {
  const args = { shot: null, keep: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--shot") args.shot = argv[++i];
    else if (argv[i] === "--keep") args.keep = true;
  }
  return args;
}

/** The owner's walk: shape a view, flip one toggle, shape the next — four views in all. */
async function buildViews(page, check) {
  const views = {};
  await dragHandle(page, ".rail .resize-handle", 460);
  await dragHandle(page, ".detail > .resize-handle", VIEWPORT.width - 520);
  views.all = await widths(page);

  await toggle(page, ".rail-toggle");
  const firstHide = await widths(page);
  check("a combination never seen before keeps the current detail width", near(firstHide.detail, views.all.detail), JSON.stringify({ firstHide, all: views.all }));
  await dragHandle(page, ".detail > .resize-handle", VIEWPORT.width - 900);
  views.noDirector = await widths(page);

  await toggle(page, ".focus-toggle");
  await dragHandle(page, ".detail > .resize-handle", VIEWPORT.width - 1200);
  views.noDirectorNoHeader = await widths(page);

  await toggle(page, ".rail-toggle");
  await dragHandle(page, ".rail .resize-handle", 330);
  await dragHandle(page, ".detail > .resize-handle", VIEWPORT.width - 700);
  views.noHeader = await widths(page);

  console.log("  views shaped:", JSON.stringify(views));
  const details = Object.values(views).map((v) => v.detail);
  check("the four views have four distinct detail widths", new Set(details).size === 4, JSON.stringify(details));
  return views;
}

function expectView(check, label, got, want) {
  const railOk = want.rail == null ? got.rail == null : near(got.rail, want.rail);
  check(
    `${label}: detail ${got.detail}px (want ${want.detail}px), rail ${got.rail ?? "hidden"} (want ${want.rail ?? "hidden"})`,
    near(got.detail, want.detail) && railOk,
    JSON.stringify({ got, want }),
  );
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  requireBuild();
  if (args.shot) fs.mkdirSync(args.shot, { recursive: true });
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "layout-memory-lab-"));
  console.log(`layout-memory-lab on ${BASE}`);
  const check = createChecks();
  try {
    await boot({ dataDir, port: PORT });
    killInstance(PORT);
    seed(dataDir);
    await boot({ dataDir, port: PORT });

    const browser = await loadChromium().launch();
    try {
      const context = await browser.newContext({ viewport: VIEWPORT });
      const page = await context.newPage();
      await page.request.post(`${BASE}/api/login`, { data: { password: authPassword() } });
      await page.goto(`${BASE}/`, { timeout: 45_000 });
      await openTask(page);

      const views = await buildViews(page, check);

      // Cycle through every combination again: each flip must land on that combination's own widths.
      await toggle(page, ".focus-toggle");
      expectView(check, "header shown again → view 1", await widths(page), views.all);
      await toggle(page, ".rail-toggle");
      expectView(check, "director hidden → view 2", await widths(page), views.noDirector);
      await toggle(page, ".focus-toggle");
      expectView(check, "header hidden → view 3", await widths(page), views.noDirectorNoHeader);
      if (args.shot) await page.screenshot({ path: path.join(args.shot, "view3.png") });
      await toggle(page, ".rail-toggle");
      expectView(check, "director shown → view 4", await widths(page), views.noHeader);

      // Persisted, not tab state: a reload boots into view 4 and still knows view 1.
      await page.reload({ timeout: 45_000 });
      await openTask(page);
      expectView(check, "after reload → view 4", await widths(page), views.noHeader);
      await toggle(page, ".focus-toggle");
      expectView(check, "after reload, header shown → view 1", await widths(page), views.all);
      if (args.shot) await page.screenshot({ path: path.join(args.shot, "view1.png") });
      await context.close();
    } finally {
      await browser.close();
    }
  } finally {
    killInstance(PORT);
    if (args.keep) console.log(`  kept ${dataDir}`);
    else fs.rmSync(dataDir, { recursive: true, force: true });
  }
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
