#!/usr/bin/env node
/**
 * screensaver-lab: drive the AFK gnome scene in a real browser and MEASURE it.
 *
 *   npm run screensaver-lab --prefix server [-- --shots data/screensaver-shots] [--video <dir>] [--keep]
 *
 * Why measuring and not looking. The prototype this scene grew out of shipped three real animation
 * bugs, and every one of them was invisible in a still: a CSS `transform-origin` composing with an
 * attribute `rotate(a cx cy)` into a rotation about TWICE the pivot, and a lean whose sign was
 * backwards (a CSS `rotate(+t)` swings a point hanging BELOW the origin to the LEFT, not the right).
 * Both draw a plausible picture. So this lab reads the live DOM across the timeline and checks the
 * geometry that the picture cannot show: it recomputes, from the browser's own computed styles, where
 * the tool head actually lands, and compares it with where the build says the work is.
 *
 * It boots its OWN orchestrator on an isolated PORT + DATA_DIR with bogus account tokens, seeds one
 * task per lifecycle state, and never touches production or the owner's data. See lab-harness.cjs for
 * the traps that plumbing encodes.
 */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { boot, killInstance, loadChromium, authPassword, requireBuild, createChecks, shotDir } = require("./lab-harness.cjs");

const PORT = 5317;
const IDLE_MINUTES = 1; // the floor the settings row allows, so the lab waits the shortest real idle
const KEEP = process.argv.includes("--keep");

/** `--video <dir>` records the main browser context to a .webm: the board, the wait, the scene
 *  arriving on its own, and the keypress that clears it. Off unless asked for, because a recording
 *  costs every run wall-clock for a clip nobody watches. */
const VIDEO_DIR = (() => {
  const at = process.argv.indexOf("--video");
  if (at < 0 || !process.argv[at + 1]) return null;
  const dir = path.resolve(process.argv[at + 1]);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
})();

/** The rig's own geometry, mirrored from web/src/components/screensaver/{rig,scene}.ts. A copy is the
 *  point: if the lab derived these from the same module the scene renders with, a wrong constant
 *  would cancel out on both sides and the geometry check would pass on a broken build. */
const RIG = { vbW: 72, ropeX: 22, width: 96, impactX: 58.7, impactY: 46.5, plotW: 150, plotH: 108, gutter: 9 };
const SCALE = RIG.width / RIG.vbW;
const IMPACT_DX = RIG.impactX * SCALE - RIG.ropeX * SCALE;
const IMPACT_DY = RIG.impactY * SCALE;

/** The work path from scene.ts: where on the frame the tool should land, per progress. */
const WORK_PATH = [
  { p: 0.0, x: 12, y: 102 },
  { p: 0.06, x: 12, y: 93 },
  { p: 0.16, x: 12, y: 54 },
  { p: 0.34, x: 15, y: 54 },
  { p: 0.5, x: 10, y: 46 },
  { p: 0.62, x: 32, y: 36 },
  { p: 0.78, x: 55, y: 25 },
  { p: 1.0, x: 74, y: 13 },
];

/** One task per lifecycle state, so every pose in the scene is on screen at once. */
const NOW = Date.now();
const SEED = [
  {
    id: "lab-working",
    title: "Rope physics for the office gnomes",
    state: "implementing",
    createdAt: NOW - 1_800_000,
    runs: [
      { role: "planner", state: "done", startedAt: NOW - 1_800_000, endedAt: NOW - 1_500_000 },
      { role: "implementor", state: "running", startedAt: NOW - 1_400_000, endedAt: null },
    ],
  },
  { id: "lab-queued", title: "Audit the deliverable path guard", state: "queued", createdAt: NOW - 1_700_000, runs: [] },
  {
    id: "lab-qa",
    title: "Wire the notes text bridge",
    state: "qa",
    createdAt: NOW - 1_600_000,
    runs: [
      { role: "implementor", state: "done", startedAt: NOW - 1_600_000, endedAt: NOW - 700_000 },
      { role: "qa", state: "running", startedAt: NOW - 600_000, endedAt: null },
    ],
  },
  {
    id: "lab-done",
    title: "Fix the fullscreen lag on the board",
    state: "done",
    createdAt: NOW - 1_500_000,
    runs: [{ role: "qa", state: "done", startedAt: NOW - 900_000, endedAt: NOW - 600_000 }],
  },
  {
    id: "lab-failed",
    title: "Read HANDOFF.md and report back",
    state: "failed",
    createdAt: NOW - 1_400_000,
    runs: [{ role: "implementor", state: "error", startedAt: NOW - 800_000, endedAt: NOW - 500_000 }],
  },
];

/** Seed the throwaway DB AFTER boot, and before the browser opens.
 *
 *  Not a detail: a server that boots onto these rows does not leave them alone. It reconciles tasks
 *  that were mid-flight when the process died (`implementing`/`qa` with no live run become an
 *  interrupted park) and it dispatches anything still `queued` at a real agent. The lab then measures
 *  five parked lanes instead of one per lifecycle state, which is exactly what the first run of this
 *  file did. Writing after boot leaves every state as authored; the console picks them up through its
 *  own socket `hello` on first load, so the data path under test is still the real one. */
function seed(dataDir) {
  const Database = require("better-sqlite3");
  const { SCHEMA } = require("../dist/db/schema.js");
  const db = new Database(path.join(dataDir, "orchestrator.sqlite"));
  db.exec(SCHEMA);
  const thread = db.prepare(
    "INSERT INTO threads (id,title,state,workspace,brief,raw_prompt,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)",
  );
  const agentRun = db.prepare(
    "INSERT INTO agent_runs (id,thread_id,role,model,state,started_at,ended_at) VALUES (?,?,?,?,?,?,?)",
  );
  for (const t of SEED) {
    thread.run(t.id, t.title, t.state, "C:\\Users\\Mikkel\\projects\\garden-gnome-orchestrator", `${t.title} brief line.`, t.title, t.createdAt, NOW - 30_000);
    t.runs.forEach((r, i) => agentRun.run(`${t.id}-run-${i}`, t.id, r.role, "claude-opus-5", r.state, r.startedAt, r.endedAt));
  }
  db.close();
}

/** Read every lane's live geometry straight out of the browser: the numbers the scene is actually
 *  drawing with, decomposed from computed transforms rather than from anything the app tells us.
 *
 *  Held as source text and invoked through `probe()` below. Handing Playwright the arrow function's
 *  SOURCE as an expression would evaluate to the function object, which serialises as `undefined` and
 *  turns every measurement into a silent null. */
const PROBE_BODY = `() => {
  const root = document.querySelector(".gs-root");
  if (!root) return null;
  const sceneBox = root.getBoundingClientRect();
  const beam = root.querySelector(".gs-beam").getBoundingClientRect();
  /** The rotation a computed 2D matrix encodes, in degrees. */
  const angleOf = (el) => {
    const m = getComputedStyle(el).transform;
    if (!m || m === "none") return 0;
    const n = m.match(/matrix\\(([^)]+)\\)/);
    if (!n) return 0;
    const [a, b] = n[1].split(",").map(Number);
    return (Math.atan2(b, a) * 180) / Math.PI;
  };
  const cards = Array.from(root.querySelectorAll(".gs-card"));
  const workers = Array.from(root.querySelectorAll(".gs-worker"));
  return {
    at: performance.now(),
    anchorY: beam.bottom - sceneBox.top,
    lanes: cards.map((card, i) => {
      const worker = workers[i];
      const plot = card.querySelector(".gs-plot").getBoundingClientRect();
      const pieces = Array.from(card.querySelectorAll(".gs-b-piece"));
      return {
        task: card.dataset.task,
        badge: card.querySelector(".gs-badge").textContent,
        elapsed: card.querySelector(".gs-elapsed").textContent,
        classes: worker.className,
        ropeH: parseFloat(getComputedStyle(worker.querySelector(".gs-rope")).height) || 0,
        leanDeg: angleOf(worker.querySelector(".gs-lean")),
        armDeg: angleOf(worker.querySelector(".gs-arm")),
        rigShiftY: (() => {
          const m = getComputedStyle(worker.querySelector(".gs-rig")).transform;
          const n = m && m.match(/matrix\\(([^)]+)\\)/);
          return n ? Number(n[1].split(",")[5]) : 0;
        })(),
        anchorX: parseFloat(worker.style.left) || 0,
        on: pieces.filter((p) => p.classList.contains("gs-on")).length,
        snapped: pieces.filter((p) => p.classList.contains("gs-snapped")).length,
        flagOn: !!card.querySelector(".gs-b-piece.gs-on .gs-b-flag"),
        dropping: worker.querySelector(".gs-dropped").classList.contains("gs-falling"),
        plot: { l: plot.left - sceneBox.left, t: plot.top - sceneBox.top, w: plot.width, h: plot.height },
      };
    }),
  };
}`;

/** One measurement of the live scene, or a hard failure: a null frame means the scene is not on
 *  screen, which every caller below is entitled to assume it is. */
async function probe(page) {
  const frame = await page.evaluate(`(${PROBE_BODY})()`);
  if (!frame || !frame.lanes.length) throw new Error("the scene rendered no lanes to measure");
  return frame;
}

/** Where the tool head lands, from the lane's own measured rope + lean. This is the forward model the
 *  scene's solver is the inverse of; agreeing with the work point is what proves the solve. */
function impactOf(lane, anchorY) {
  const t = (lane.leanDeg * Math.PI) / 180;
  const ly = lane.ropeH + IMPACT_DY;
  return {
    x: lane.anchorX + (IMPACT_DX * Math.cos(t) - ly * Math.sin(t)),
    y: anchorY + (IMPACT_DX * Math.sin(t) + ly * Math.cos(t)),
  };
}

/** Where the frame says the work is, for the progress the rendered timbers imply. */
function workPointFor(progress) {
  if (progress <= WORK_PATH[0].p) return WORK_PATH[0];
  for (let i = 1; i < WORK_PATH.length; i++) {
    if (progress <= WORK_PATH[i].p) {
      const a = WORK_PATH[i - 1];
      const b = WORK_PATH[i];
      const u = (progress - a.p) / (b.p - a.p);
      return { x: a.x + (b.x - a.x) * u, y: a.y + (b.y - a.y) * u };
    }
  }
  return WORK_PATH[WORK_PATH.length - 1];
}

async function main() {
  requireBuild();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "gs-lab-"));
  const shots = shotDir(dataDir);

  killInstance(PORT);
  const child = await boot({ dataDir, port: PORT, env: { HOST: "127.0.0.1" } });
  seed(dataDir);
  const check = createChecks();
  const chromium = loadChromium();
  const browser = await chromium.launch();
  let code = 1;

  try {
    const context = await browser.newContext({
      viewport: { width: 1600, height: 1000 },
      deviceScaleFactor: 2,
      ...(VIDEO_DIR ? { recordVideo: { dir: VIDEO_DIR, size: { width: 1600, height: 1000 } } } : {}),
    });
    await context.request.post(`http://127.0.0.1:${PORT}/api/login`, { data: { password: authPassword() } });
    // Set the view-settings record BEFORE the bundle runs, so the console boots straight into a
    // one-minute idle delay rather than the default five.
    await context.addInitScript(
      ([key, minutes]) => {
        localStorage.setItem(key, JSON.stringify({ showCompleted: true, verbosity: "full", taskDragAndDrop: false, taskSort: "created_desc", theme: "classic", screensaver: true, screensaverIdleMinutes: minutes }));
      },
      ["director_settings", IDLE_MINUTES],
    );
    const page = await context.newPage();
    await page.goto(`http://127.0.0.1:${PORT}/`, { timeout: 45_000 });
    // Wait for the socket's hello, not the shell: everything server-authoritative renders neutral
    // defaults until that frame lands (lab-harness.cjs).
    await page.waitForSelector(".gs-card, .card", { timeout: 45_000 });
    const boardCards = await page.locator(".card").count();
    check("the board renders the seeded tasks before anything goes idle", boardCards >= SEED.length, `${boardCards} cards`);
    await page.screenshot({ path: path.join(shots, "00-board-before.png") });

    /* ---- 1. it arrives on its own, after the configured idle ---- */

    const waitStart = Date.now();
    await page.waitForSelector(".gs-root", { timeout: (IDLE_MINUTES + 1) * 60_000 });
    const waited = (Date.now() - waitStart) / 1000;
    check("the scene appears by itself after the idle delay", waited >= IDLE_MINUTES * 60 - 5, `waited ${waited.toFixed(0)}s for a ${IDLE_MINUTES}min setting`);

    /* ---- 2. the rappel: rope grows from nothing, overshoots, settles ---- */

    const rappel = [];
    for (let i = 0; i < 26; i++) {
      rappel.push(await probe(page));
      await page.waitForTimeout(60);
    }
    const workingRope = rappel.map((f) => f.lanes.find((l) => l.task === "lab-working")?.ropeH ?? 0);
    const settledRope = workingRope[workingRope.length - 1];
    check("a working gnome starts on the beam and pays out rope", workingRope[0] < settledRope, `${workingRope[0].toFixed(1)}px -> ${settledRope.toFixed(1)}px`);
    check(
      "the rappel brakes late and the rope stretches past the stop",
      Math.max(...workingRope) > settledRope + 1,
      `peak ${Math.max(...workingRope).toFixed(1)}px vs settled ${settledRope.toFixed(1)}px`,
    );

    /* ---- 3. the geometry: the tool actually lands on the build ---- */

    await page.waitForTimeout(1500); // let every transition settle
    const posed = await probe(page);
    const lane = (id) => posed.lanes.find((l) => l.task === id);
    const work = lane("lab-working");
    const impact = impactOf(work, posed.anchorY);
    // The rendered timbers name the progress band the lane is in, so the work point is read off the
    // scene's own output rather than recomputed from the store.
    const AT = [0, 0.06, 0.16, 0.26, 0.34, 0.42, 0.5, 0.6, 0.68, 0.76, 0.84, 0.9, 0.985];
    const progressLo = AT[work.on - 1];
    const progressHi = work.on < AT.length ? AT[work.on] : 1;
    const targetLo = workPointFor(progressLo);
    const targetHi = workPointFor(progressHi);
    const toScene = (p) => ({ x: work.plot.l + (p.x / RIG.plotW) * work.plot.w, y: work.plot.t + (p.y / RIG.plotH) * work.plot.h });
    const a = toScene(targetLo);
    const b = toScene(targetHi);
    const within =
      impact.x >= Math.min(a.x, b.x) - 6 && impact.x <= Math.max(a.x, b.x) + 6 && impact.y >= Math.min(a.y, b.y) - 6 && impact.y <= Math.max(a.y, b.y) + 6;
    check(
      "the tool head lands on the frame the gnome is building",
      within,
      `impact (${impact.x.toFixed(0)},${impact.y.toFixed(0)}) vs the ${work.on}-timber band (${a.x.toFixed(0)},${a.y.toFixed(0)})..(${b.x.toFixed(0)},${b.y.toFixed(0)})`,
    );
    check("the impact sits inside the card, not off the side of the board", impact.x > work.plot.l - 20 && impact.x < work.plot.l + work.plot.w + 20, `x ${impact.x.toFixed(0)}`);

    /* ---- 4. the swing: the arm really moves, and passes through the strike ---- */

    const arm = [];
    for (let i = 0; i < 40; i++) {
      arm.push((await probe(page)).lanes.find((l) => l.task === "lab-working").armDeg);
      await page.waitForTimeout(40);
    }
    const armMin = Math.min(...arm);
    const armMax = Math.max(...arm);
    check("the working arm swings through a real arc", armMax - armMin > 40, `${armMin.toFixed(1)}deg .. ${armMax.toFixed(1)}deg`);
    check("the swing winds up over the shoulder", armMin < -60, `lowest ${armMin.toFixed(1)}deg`);
    // The tool is DRAWN at the point the rig is aimed at, so the strike frame must be rotate(0): a
    // swing whose lowest point is some other angle lands beside its own sparks.
    check("the swing passes through the strike, so the head meets the work", armMax > -6, `highest ${armMax.toFixed(1)}deg`);

    /* ---- 5. every other lifecycle pose ---- */

    const queued = lane("lab-queued");
    check("a queued gnome hangs no rope at all", queued.ropeH === 0, `${queued.ropeH}px`);
    check("a queued gnome is lifted onto the beam", queued.rigShiftY < -40, `${queued.rigShiftY.toFixed(0)}px`);
    check("a queued task has laid no timber", queued.on === 0, `${queued.on} pieces`);
    check("a queued gnome's clock has not started", queued.elapsed === "--:--", queued.elapsed);
    check("a queued card says queued", /queued/i.test(queued.badge), queued.badge);

    const qa = lane("lab-qa");
    check("a QA lane is further up its frame than a fresh implementor", qa.on > work.on, `${qa.on} vs ${work.on} timbers`);
    check("a QA lane is on the wrench", /gs-t-wrench/.test(qa.classes), qa.classes);
    check("the implementor lane is on the hammer", /gs-t-hammer/.test(work.classes), work.classes);

    const done = lane("lab-done");
    check("a finished gnome is back on the beam", done.ropeH === 0 && /gs-perched/.test(done.classes), `${done.ropeH}px ${done.classes}`);
    check("a finished gnome tips his hat rather than working", /gs-done/.test(done.classes) && !/gs-working/.test(done.classes), done.classes);
    check("a finished frame flies its pennant", done.flagOn && done.on === AT.length, `${done.on} timbers, flag ${done.flagOn}`);

    const failed = lane("lab-failed");
    check("a failed gnome slipped down the rope", /gs-failed/.test(failed.classes), failed.classes);
    check("a failed gnome dropped his tool", failed.dropping);
    check("the piece he was on let go", failed.snapped === 1, `${failed.snapped} snapped`);

    for (const [id, name] of [
      ["lab-queued", "01-queued"],
      ["lab-working", "02-working"],
      ["lab-qa", "03-qa"],
      ["lab-done", "04-done"],
      ["lab-failed", "05-failed"],
    ]) {
      // Magnified crops: a 1x look at a 96px gnome proves nothing about whether the tool meets the work.
      await page.locator(`.gs-card[data-task="${id}"]`).screenshot({ path: path.join(shots, `${name}-card.png`) });
    }
    await page.screenshot({ path: path.join(shots, "06-scene.png") });

    /* ---- 6. it stops costing anything when the tab is hidden ---- */

    const beforeHidden = await probe(page);
    await page.evaluate(() => {
      Object.defineProperty(document, "hidden", { configurable: true, get: () => true });
      Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await page.waitForTimeout(900);
    const duringHidden = await probe(page);
    await page.waitForTimeout(900);
    const stillHidden = await probe(page);
    const armFrozen = duringHidden.lanes.find((l) => l.task === "lab-working").ropeH === stillHidden.lanes.find((l) => l.task === "lab-working").ropeH;
    check("the render loop stops while the tab is hidden", armFrozen, `${duringHidden.lanes[0].ropeH} then ${stillHidden.lanes[0].ropeH}`);
    check("the scene was alive before it was hidden", beforeHidden.at < duringHidden.at);
    await page.evaluate(() => {
      Object.defineProperty(document, "hidden", { configurable: true, get: () => false });
      Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });
      document.dispatchEvent(new Event("visibilitychange"));
    });

    /* ---- 7. any input dismisses it, and the board is untouched ---- */

    const boardBefore = await page.evaluate(() => ({
      cards: document.querySelectorAll(".card").length,
      titles: Array.from(document.querySelectorAll(".card")).map((c) => c.textContent.slice(0, 40)),
    }));
    await page.keyboard.press("a");
    await page.waitForSelector(".gs-root", { state: "detached", timeout: 4000 });
    check("a keypress dismisses the scene at once", true);
    const boardAfter = await page.evaluate(() => ({
      cards: document.querySelectorAll(".card").length,
      titles: Array.from(document.querySelectorAll(".card")).map((c) => c.textContent.slice(0, 40)),
    }));
    check(
      "the board underneath is exactly as it was",
      boardAfter.cards === boardBefore.cards && JSON.stringify(boardAfter.titles) === JSON.stringify(boardBefore.titles),
      `${boardBefore.cards} -> ${boardAfter.cards}`,
    );
    await page.screenshot({ path: path.join(shots, "07-board-after.png") });
    const stillGone = await page.locator(".gs-root").count();
    check("it stays dismissed while the owner is working", stillGone === 0);

    // Closing the context is the only moment Playwright flushes a recording to disk, so the clip is
    // finalised here rather than in `finally`: everything below runs in contexts of its own.
    if (VIDEO_DIR) {
      const video = page.video();
      await context.close();
      if (video) console.log(`\nvideo: ${await video.path()}`);
    }

    /* ---- 8. reduced motion: posed, not moving ---- */

    const calm = await browser.newContext({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 2, reducedMotion: "reduce" });
    await calm.request.post(`http://127.0.0.1:${PORT}/api/login`, { data: { password: authPassword() } });
    await calm.addInitScript(
      ([key, minutes]) => {
        localStorage.setItem(key, JSON.stringify({ showCompleted: true, verbosity: "full", taskDragAndDrop: false, taskSort: "created_desc", theme: "classic", screensaver: true, screensaverIdleMinutes: minutes }));
      },
      ["director_settings", IDLE_MINUTES],
    );
    const calmPage = await calm.newPage();
    await calmPage.goto(`http://127.0.0.1:${PORT}/`, { timeout: 45_000 });
    await calmPage.waitForSelector(".gs-root", { timeout: (IDLE_MINUTES + 1) * 60_000 });
    await calmPage.waitForTimeout(1200);
    const calmA = await probe(calmPage);
    await calmPage.waitForTimeout(1200);
    const calmB = await probe(calmPage);
    const calmWork = (f) => f.lanes.find((l) => l.task === "lab-working");
    check("reduced motion still poses the gnome on his work", calmWork(calmA).ropeH > 10 && calmWork(calmA).on > 0, `rope ${calmWork(calmA).ropeH.toFixed(1)}px, ${calmWork(calmA).on} timbers`);
    check("reduced motion holds the arm still", calmWork(calmA).armDeg === calmWork(calmB).armDeg, `${calmWork(calmA).armDeg} then ${calmWork(calmB).armDeg}`);
    check("reduced motion holds the rope still", calmWork(calmA).ropeH === calmWork(calmB).ropeH, `${calmWork(calmA).ropeH} then ${calmWork(calmB).ropeH}`);
    await calmPage.screenshot({ path: path.join(shots, "08-reduced-motion.png") });

    /* ---- 9. switching it off means off ---- */

    const off = await browser.newContext({ viewport: { width: 1200, height: 800 } });
    await off.request.post(`http://127.0.0.1:${PORT}/api/login`, { data: { password: authPassword() } });
    await off.addInitScript(
      (key) => {
        localStorage.setItem(key, JSON.stringify({ showCompleted: true, verbosity: "full", taskDragAndDrop: false, taskSort: "created_desc", theme: "classic", screensaver: false, screensaverIdleMinutes: 1 }));
      },
      "director_settings",
    );
    const offPage = await off.newPage();
    await offPage.goto(`http://127.0.0.1:${PORT}/`, { timeout: 45_000 });
    await offPage.waitForSelector(".card", { timeout: 45_000 });
    await offPage.waitForTimeout((IDLE_MINUTES * 60 + 20) * 1000);
    check("switched off, the scene never appears", (await offPage.locator(".gs-root").count()) === 0);

    console.log(`\nshots: ${shots}`);
    code = check.summary();
  } finally {
    await browser.close();
    if (!KEEP) {
      child.kill();
      killInstance(PORT);
      // The temp DATA_DIR goes, and with it the screenshots when no `--shots <dir>` was given. That is
      // the documented default (lab-harness.cjs): a run nobody is watching leaves nothing behind.
      fs.rmSync(dataDir, { recursive: true, force: true });
    } else {
      console.log(`kept: http://127.0.0.1:${PORT} (DATA_DIR ${dataDir})`);
    }
  }
  process.exit(code);
}

main().catch((e) => {
  console.error(e);
  killInstance(PORT);
  process.exit(1);
});
