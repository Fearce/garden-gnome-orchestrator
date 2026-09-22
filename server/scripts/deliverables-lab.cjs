// Lab for the task detail panel's Deliverables strip (`npm run deliverables-lab`). A regression here
// was verified twice by hand: the implementor and the QA agent each hand-rolled their own throwaway
// seeded instance, because prod's own detail panel is a live stream whose sticky-to-bottom autoscroll
// fights hover/click timing, and prod state is off-limits to click on anyway. This repo has ~20
// `*-lab.cjs` scripts for exactly that reason and Deliverables had none.
//
// What a typecheck/build/unit-test can't show: whether the chip strip actually renders a real
// finding's label + filename, whether hovering it reveals the popover (CSS `:hover`/`:focus-within`,
// not a click, see `.dl-pop` in styles.css) with the real Download/Copy path/View actions, whether
// **View** opens `DeliverableModal` and renders the REAL file bytes (markdown text, a decoded image),
// whether **Download** resolves the real `GET /api/deliverable/:id` route byte-for-byte, and whether
// **Copy path** writes the exact absolute path production would have written.
//
// Seeds two real deliverables (a markdown report and a 1x1 PNG) as actual files on disk inside a real
// Git workspace, plus their `findings` rows (kind='deliverable'), then drives the console. The report
// is changed after its fixture commit so the same run opens Changes on a real unified diff. Both
// surfaces run first under Nocturne and then Classic, with full-viewport bounds checks: a retained
// transform on `.detail` otherwise traps their fixed overlays inside the task column.
//
//   npm run deliverables-lab --prefix server
//   npm run deliverables-lab --prefix server -- --shots data/deliverables-lab-shots
//   npm run deliverables-lab --prefix server -- --keep
//
// Safe against prod for the usual reasons: temp DATA_DIR, bogus account tokens, its own port, killed
// by port owner. See lab-harness.cjs's header for the full cookbook this leans on.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const Database = require("better-sqlite3");
const { loadChromium, authPassword, requireBuild, boot, killInstance, createChecks, shotDir } = require("./lab-harness.cjs");

const PORT = 5317;
const BASE = `http://127.0.0.1:${PORT}`;
const TASK_ID = "deliverables-lab-task-000000000001";

// A real, valid 1x1 PNG (signature + IHDR(1x1) + IDAT + IEND), not a fake payload. The preview path
// must actually DECODE it, so a plausible-looking-but-invalid PNG would pass a byte-length check while
// failing the one thing that matters: does `<img>` render it.
const PNG_B64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

const MD_LABEL = "Lab Report";
const MD_NAME = "report.md";
const MD_TEXT = "# Deliverables Lab Report\n\nReal file content the **View** action must show verbatim.\n\n- alpha\n- beta\n";

const PNG_LABEL = "Lab Screenshot";
const PNG_NAME = "shot.png";

/** Write the two real files into a real workspace directory, seed the thread + findings that point at
 *  them, and return each deliverable's absolute on-disk path: what the route must serve byte-for-byte
 *  and what "Copy path" must reproduce exactly. */
function seed(dataDir) {
  const workspace = path.join(dataDir, "workspace");
  fs.mkdirSync(workspace, { recursive: true });
  const mdPath = path.join(workspace, MD_NAME);
  const pngPath = path.join(workspace, PNG_NAME);
  fs.writeFileSync(mdPath, MD_TEXT, "utf8");
  fs.writeFileSync(pngPath, Buffer.from(PNG_B64, "base64"));
  execFileSync("git", ["init", "-q"], { cwd: workspace });
  execFileSync("git", ["config", "user.email", "deliverables-lab@example.invalid"], { cwd: workspace });
  execFileSync("git", ["config", "user.name", "Deliverables Lab"], { cwd: workspace });
  execFileSync("git", ["add", MD_NAME, PNG_NAME], { cwd: workspace });
  execFileSync("git", ["commit", "-qm", "seed deliverables"], { cwd: workspace });
  fs.appendFileSync(mdPath, "\nWorking-tree line for the Changes viewer.\n", "utf8");

  const db = new Database(path.join(dataDir, "orchestrator.sqlite"));
  const now = Date.now();
  db.prepare(
    "INSERT INTO threads (id, title, state, workspace, brief, raw_prompt, created_at, updated_at) VALUES (?, ?, 'review', ?, ?, ?, ?, ?)",
  ).run(TASK_ID, "Ship the deliverables lab fixtures", workspace, "a seeded task", "a seeded task", now - 60_000, now);

  const finding = db.prepare(
    "INSERT INTO findings (id, thread_id, from_run_id, from_role, kind, summary, detail, path, label, severity, routed, created_at) VALUES (?, ?, NULL, 'implementor', 'deliverable', ?, ?, ?, ?, 'info', 0, ?)",
  );
  finding.run("dl-lab-f-md", TASK_ID, MD_LABEL, "A markdown deliverable seeded for the lab.", mdPath, MD_LABEL, now - 30_000);
  finding.run("dl-lab-f-png", TASK_ID, PNG_LABEL, "A PNG deliverable seeded for the lab.", pngPath, PNG_LABEL, now - 20_000);
  db.close();

  return { mdPath, pngPath };
}

/** A chip is only reachable by its aria-label (the icon carries no text), so scope every locator to
 *  the `.dl-chip` that wraps the button with that label rather than guessing an nth-child order. */
function chip(page, label) {
  return page.locator(`.dl-chip:has(.dl-chip-btn[aria-label="${label}"])`);
}

async function main() {
  requireBuild();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "deliverables-lab-"));
  console.log(`deliverables-lab: 1 markdown + 1 PNG deliverable on ${BASE}`);
  const check = createChecks();
  killInstance(PORT);
  let child = null;
  try {
    // First boot only creates the schema; seed against the stopped instance's own file, then boot the
    // real serving process against the now-seeded DB (same two-boot shape as panel-scroll-lab.cjs).
    child = await boot({ dataDir, port: PORT });
    child.kill();
    killInstance(PORT);
    const { mdPath, pngPath } = seed(dataDir);
    child = await boot({ dataDir, port: PORT });

    const chromium = loadChromium();
    const browser = await chromium.launch();
    const ctx = await browser.newContext({ viewport: { width: 1500, height: 950 }, acceptDownloads: true });
    // The copy affordance needs a clipboard the sandbox actually grants (see lab-harness.cjs's
    // cookbook): permissions alone don't help without a writeText stub in headless chromium.
    await ctx.grantPermissions(["clipboard-read", "clipboard-write"]);
    await ctx.addInitScript(() => {
      const current = JSON.parse(localStorage.getItem("director_settings") || "{}");
      if (!("theme" in current)) localStorage.setItem("director_settings", JSON.stringify({ ...current, theme: "nocturne" }));
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: { writeText: async (text) => { window.__copied = text; } },
      });
    });
    const page = await ctx.newPage();
    const errors = [];
    page.on("console", (m) => {
      if (m.type() === "error") errors.push(m.text());
    });
    page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));

    await page.request.post(`${BASE}/api/login`, { data: { password: authPassword() } });
    await page.goto(`${BASE}/`, { timeout: 45_000 });
    await page.waitForSelector(".accounts .acct", { timeout: 30_000 }); // hello landed
    await page.waitForSelector(".workbench", { timeout: 45_000 });
    await page.click(".card", { timeout: 45_000 });
    await page.waitForSelector(".detail", { timeout: 20_000 });

    // ---- the strip itself ----
    await page.waitForSelector(".deliverable-strip .dl-chip", { timeout: 15_000 });
    const count = (await page.textContent(".deliverables-label .n")) ?? "";
    check("the deliverables chip shows the right count", count.trim() === "2", count);
    check("both chips render", (await page.locator(".deliverable-strip .dl-chip").count()) === 2);

    // Drive each deliverable's FULL round (popover, View, Download, GET, Copy path) before moving to
    // the next one. Clicking a Download anchor focuses it, and CSS shows `.dl-pop` on `:hover` OR
    // `:focus-within`, so once one chip's anchor holds focus, hovering a SECOND chip leaves both
    // popovers open at once, and the earlier (DOM-first) chip's controls end up hidden under the
    // later one's, intercepting clicks aimed at them. A real mouse-only user runs through one file's
    // actions before starting the next; matching that order sidesteps the trap outright.
    const items = [
      { label: MD_LABEL, name: MD_NAME, realPath: mdPath, contentType: /markdown/ },
      { label: PNG_LABEL, name: PNG_NAME, realPath: pngPath, contentType: /image\/png/ },
    ];
    for (const item of items) {
      const c = chip(page, item.label);
      await c.hover();
      await page
        .waitForSelector(
          `.dl-chip:has(.dl-chip-btn[aria-label="${item.label}"]) .dl-pop.open, .dl-chip:has(.dl-chip-btn[aria-label="${item.label}"]):hover .dl-pop`,
          { timeout: 5000 },
        )
        .catch(() => {});
      check(`${item.name}: popover names the real label`, ((await c.locator(".dl-pop-label").textContent()) ?? "").trim() === item.label);
      check(`${item.name}: ...and the real filename`, ((await c.locator(".dl-pop-name").textContent()) ?? "").trim() === item.name);

      // ---- View ----
      await page.click(`.dl-chip-btn[aria-label="${item.label}"]`);
      await page.waitForSelector(".modal.deliverable", { timeout: 10_000 });
      const title = (await page.textContent(".dl-modal-title h3")) ?? "";
      check(`${item.name}: preview modal titles itself with the real label`, title.trim() === item.label, title);
      if (item.label === MD_LABEL) {
        await page.waitForSelector(".md-preview", { timeout: 10_000 });
        const mdBody = (await page.textContent(".md-preview")) ?? "";
        check(`${item.name}: markdown preview shows the real file's heading`, mdBody.includes("Deliverables Lab Report"), mdBody);
        check(`${item.name}: ...and its list content`, mdBody.includes("alpha") && mdBody.includes("beta"), mdBody);
        const boldCount = await page.locator(".md-preview strong").count();
        check(`${item.name}: ...rendered as markdown, not raw text (bold survived)`, boldCount > 0);
        const scrim = await page.locator(".modal.deliverable").locator("xpath=..").boundingBox();
        check(
          `${item.name}: Nocturne preview covers the viewport instead of the detail column`,
          !!scrim && scrim.x === 0 && scrim.y === 0 && scrim.width === 1500 && scrim.height === 950,
          JSON.stringify(scrim),
        );
        await page.screenshot({ path: path.join(shotDir(dataDir), "nocturne-deliverable.png") });
      } else {
        await page.waitForSelector("img.dl-image", { timeout: 10_000 });
        // `attached` proves the element exists, not that the browser finished decoding it: wait for
        // the real `load` outcome (`complete` flips true on error too, so also require a real width).
        await page.waitForFunction(() => {
          const el = document.querySelector("img.dl-image");
          return !!el && el.complete && el.naturalWidth > 0;
        }, { timeout: 10_000 });
        const img = await page.evaluate(() => {
          const el = document.querySelector("img.dl-image");
          return el ? { complete: el.complete, w: el.naturalWidth, h: el.naturalHeight } : null;
        });
        check(`${item.name}: image preview actually decoded the real bytes (not a broken img)`, !!img && img.complete && img.w > 0, JSON.stringify(img));
        check(`${item.name}: ...at the real fixture's dimensions (1x1)`, !!img && img.w === 1 && img.h === 1, JSON.stringify(img));
      }
      await page.click(".dl-modal-actions button[aria-label='Close']");
      let closed = true;
      try {
        await page.waitForSelector(".modal.deliverable", { state: "detached", timeout: 2_000 });
      } catch {
        closed = false;
      }
      check(`${item.name}: Close dismisses the preview`, closed);
      if (!closed) {
        // A broken modal blocks every later control. Reload lets the same run capture the companion
        // Changes failure and the Classic control case instead of aborting on the first symptom.
        await page.reload();
        await page.waitForSelector(".accounts .acct", { timeout: 30_000 });
        await page.click(".card", { timeout: 45_000 });
        await page.waitForSelector(".detail", { timeout: 20_000 });
      }

      // ---- Download: the real route, byte-for-byte ----
      await c.hover();
      const [download] = await Promise.all([
        page.waitForEvent("download", { timeout: 10_000 }),
        c.locator('a.btn:has-text("Download")').click(),
      ]);
      check(`${item.name}: Download offers the real filename`, download.suggestedFilename() === item.name, download.suggestedFilename());
      const dlPath = await download.path();
      const gotDownload = dlPath ? fs.readFileSync(dlPath) : Buffer.alloc(0);
      const wantBytes = fs.readFileSync(item.realPath);
      check(`${item.name}: downloaded bytes match the real file byte-for-byte`, gotDownload.equals(wantBytes), `${gotDownload.length} vs ${wantBytes.length} bytes`);

      // ---- the real GET route, independent of the browser's download plumbing ----
      const href = await c.locator('a.btn:has-text("Download")').getAttribute("href");
      const res = await page.request.get(new URL(href, BASE).toString());
      check(`${item.name}: GET /api/deliverable/:id answers 200`, res.status() === 200, String(res.status()));
      check(`${item.name}: with the right content-type`, item.contentType.test(res.headers()["content-type"] ?? ""), res.headers()["content-type"]);
      const gotGet = Buffer.from(await res.body());
      check(`${item.name}: direct GET bytes match the real file`, gotGet.equals(wantBytes));

      // ---- Copy path: the exact absolute path, not a resolved/altered one ----
      // `.dl-pop-actions` also holds a "View" button, so scope this by the copy button's own
      // (previewable-independent) title rather than a bare `button` selector matching the wrong one.
      await c.hover();
      await c.locator('button:text-is("Copy path")').click();
      let copyConfirmed = true;
      try {
        await page.waitForFunction(
          (label) => {
            const btn = [...document.querySelectorAll(".dl-chip")]
              .find((el) => el.querySelector(`.dl-chip-btn[aria-label="${label}"]`))
              ?.querySelector('.dl-pop-actions button[title="Copy the full file path to the clipboard"]');
            return btn && btn.textContent === "Copied";
          },
          item.label,
          { timeout: 2000 },
        );
      } catch {
        copyConfirmed = false;
      }
      const copied = await page.evaluate(() => window.__copied);
      check(`${item.name}: Copy path wrote the exact absolute path`, copyConfirmed && copied === item.realPath, `${copied} !== ${item.realPath}`);
    }

    // The owner described the companion failure as "checking changes": exercise the task's real
    // Diff action against this checkout's real working-tree changes under the same Nocturne session.
    await page.getByRole("button", { name: "Diff", exact: true }).click();
    await page.waitForSelector(".modal.changes", { timeout: 10_000 });
    await page.waitForFunction(() => {
      const body = document.querySelector(".changes-body");
      return body && !body.textContent?.includes("loading…");
    }, { timeout: 10_000 });
    check("Nocturne Changes opens with real diff content", ((await page.textContent(".changes-body")) ?? "").includes("diff --git"));
    const nocturneScrim = await page.locator(".modal.changes").locator("xpath=..").boundingBox();
    check(
      "Nocturne Changes covers the viewport instead of the detail column",
      !!nocturneScrim && nocturneScrim.x === 0 && nocturneScrim.y === 0 && nocturneScrim.width === 1500 && nocturneScrim.height === 950,
      JSON.stringify(nocturneScrim),
    );
    await page.screenshot({ path: path.join(shotDir(dataDir), "nocturne-changes.png") });
    await page.locator(".modal.changes .m-head button").click();
    await page.waitForSelector(".modal.changes", { state: "detached", timeout: 5_000 });

    // Isolate theme-specific failures from the underlying viewers by repeating both surfaces in the
    // default Classic theme in the same authenticated browser.
    await page.evaluate(() => {
      const current = JSON.parse(localStorage.getItem("director_settings") || "{}");
      localStorage.setItem("director_settings", JSON.stringify({ ...current, theme: "classic" }));
    });
    await page.reload();
    await page.waitForSelector(".accounts .acct", { timeout: 30_000 });
    await page.click(".card", { timeout: 45_000 });
    await page.waitForSelector(".detail", { timeout: 20_000 });
    await page.click(`.dl-chip-btn[aria-label="${MD_LABEL}"]`);
    await page.waitForSelector(".md-preview", { timeout: 10_000 });
    check("Classic deliverable preview still renders", ((await page.textContent(".md-preview")) ?? "").includes("Deliverables Lab Report"));
    const classicDeliverableScrim = await page.locator(".modal.deliverable").locator("xpath=..").boundingBox();
    check(
      "Classic deliverable preview covers the viewport",
      !!classicDeliverableScrim && classicDeliverableScrim.x === 0 && classicDeliverableScrim.y === 0 && classicDeliverableScrim.width === 1500 && classicDeliverableScrim.height === 950,
      JSON.stringify(classicDeliverableScrim),
    );
    await page.screenshot({ path: path.join(shotDir(dataDir), "classic-deliverable.png") });
    await page.click(".dl-modal-actions button[aria-label='Close']");
    await page.waitForSelector(".modal.deliverable", { state: "detached", timeout: 5_000 });
    await page.getByRole("button", { name: "Diff", exact: true }).click();
    await page.waitForSelector(".modal.changes", { timeout: 10_000 });
    await page.waitForFunction(() => {
      const body = document.querySelector(".changes-body");
      return body && !body.textContent?.includes("loading…");
    }, { timeout: 10_000 });
    check("Classic Changes still renders", ((await page.textContent(".changes-body")) ?? "").includes("diff --git"));
    const classicScrim = await page.locator(".modal.changes").locator("xpath=..").boundingBox();
    check(
      "Classic Changes covers the viewport",
      !!classicScrim && classicScrim.x === 0 && classicScrim.y === 0 && classicScrim.width === 1500 && classicScrim.height === 950,
      JSON.stringify(classicScrim),
    );
    await page.screenshot({ path: path.join(shotDir(dataDir), "classic-changes.png") });
    await page.locator(".modal.changes .m-head button").click();
    await page.waitForSelector(".modal.changes", { state: "detached", timeout: 5_000 });

    check("no console errors", errors.length === 0, errors.join(" | "));

    const shots = shotDir(dataDir);
    await page.screenshot({ path: path.join(shots, "deliverables.png") });
    await chip(page, PNG_LABEL).hover();
    await page.screenshot({ path: path.join(shots, "deliverables-popover.png") });
    console.log(`\nscreenshots: ${shots} (Nocturne + Classic, deliverable + Changes, strip + popover)`);

    await ctx.close();
    await browser.close();
  } finally {
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
