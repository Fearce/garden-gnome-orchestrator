// Lab for the steps-and-milestones tree under each goal (`npm run goal-tree-lab`). What `test:goals` cannot
// see: whether the tree is readable in a real browser at desktop and iPhone widths (one line per item,
// nothing sideways), whether a milestone opens onto its note and its task, whether a milestone recorded
// while the console is open appears without a reload, and whether the milestones and the status lines
// backfilled from older steps survive a restart.
// Seeds its own throwaway DB before boot (bogus account tokens; every seeded goal is paused or ended and
// every task settled, so nothing is ever dispatched). Not in GATES: it needs a browser + an instance.
//
// To test uncommitted work without touching the live dist, build isolated copies first:
//   from server/: npx tsc -p tsconfig.json --outDir .goals-lab-dist
//   from web/:    npx vite build --outDir ../server/.lab-web-dist-goals --emptyOutDir
// then run with GGO_LAB_ENTRY=.goals-lab-dist/index.js GGO_LAB_WEB_DIST=.lab-web-dist-goals.
// Add `-- --shots <dir>` to keep the screenshots.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { SERVER_ROOT, loadChromium, authPassword, requireBuild, boot, killInstance, createChecks, shotDir } = require("./lab-harness.cjs");

const PORT = 4418;
const check = createChecks();
const ACTIVE = "Offline support";
const OLD = "Legacy import";

/** The Db of the build under test, so the seed goes through the same schema and migrations it boots. */
async function openDb(dataDir) {
  const entry = path.resolve(SERVER_ROOT, process.env.GGO_LAB_ENTRY || "dist/index.js");
  const { Db } = await import(pathToFileURL(path.join(path.dirname(entry), "db", "db.js")).href);
  return new Db(path.join(dataDir, "orchestrator.sqlite"));
}

function settledTask(db, workspace, title, report) {
  const t = db.createThread({ title, workspace, rawPrompt: "", brief: "" });
  if (report) db.addMessage({ threadId: t.id, role: "implementor", kind: "text", content: report });
  db.updateThread(t.id, { state: "done" });
  return t.id;
}

async function seed(dataDir, workspace) {
  const db = await openDb(dataDir);
  const pace = { effort: null, provider: null, model: null, maxConcurrent: 1, burnConservation: true, burnRatePct: 100 };

  // A goal mid-way: step 1 settled, step 2 open, milestones across both and one from a step outside the window.
  const g = db.createGoal({ ...pace, title: ACTIVE, objective: "The app works fully offline, with sync on reconnect and an iPhone build the owner approves.", workspace });
  db.updateGoal(g.id, { status: "paused", statusReason: "Paused by the owner." });
  const s1 = db.createGoalStep({ goalId: g.id, title: "Cache layer", provider: "claude", model: "claude-opus-5-5", effort: "medium", rationale: "Architectural.", brief: "b" });
  const t1 = settledTask(db, workspace, `${ACTIVE} · step 1: Cache layer`, "Cache done.\nGOAL STATUS: CONTINUE: sync queue and replay remain");
  db.updateGoalStep(s1.id, { threadId: t1, outcome: "done", settledAt: Date.now() - 3_600_000, turnStartedAt: 1 });
  const s2 = db.createGoalStep({ goalId: g.id, title: "Sync queue and replay on reconnect, with conflict handling", provider: "codex", model: "gpt-5.6", effort: "medium", rationale: "Mechanical follow-up.", brief: "b" });
  const t2 = settledTask(db, workspace, `${ACTIVE} · step 2: Sync queue`, null);
  db.updateThread(t2, { state: "review" });
  db.updateGoalStep(s2.id, { threadId: t2, turns: 3, turnStartedAt: Date.now() - 600_000 });
  db.updateGoal(g.id, { currentThreadId: t2 });
  const at = Date.now() - 1_800_000;
  const row = (key, title, status, threadId, over = {}) => ({ key, title, status, note: null, blocker: null, verified: false, verification: null, threadId, updatedAt: at, startedAt: null, completedAt: null, ...over });
  db.saveGoalWorkItems(g.id, [
    row("legacy-probe", "Legacy cache probe", "done", "thread-from-an-earlier-window", { completedAt: at }),
    row("cache-schema", "Cache schema", "done", t1, { verified: true, verification: "cache.test: 42 passed", completedAt: at, startedAt: at - 60_000 }),
    row("eviction", "Cache eviction", "done", t1, { completedAt: at }),
    row("queue-writes", "Queue writes while offline in IndexedDB with a retry budget per write", "working", t2, { note: "Queue in place; wiring the service worker next.", startedAt: at }),
    row("replay", "Replay on reconnect", "planned", t2),
    row("iphone", "iPhone build approval", "awaiting_approval", t2, { blocker: "Mikkel installs the TestFlight build and approves it." }),
    row("polling", "Poll for connectivity", "dropped", t2),
  ]);

  // A goal from before milestones existed: only its steps and their reports, status lines unread.
  const old = db.createGoal({ ...pace, title: OLD, objective: "Import the legacy data.", workspace });
  const o1 = db.createGoalStep({ goalId: old.id, title: "Importer", provider: null, model: null, effort: "low", rationale: "", brief: "b" });
  const ot1 = settledTask(db, workspace, `${OLD} · step 1: Importer`, "Imported.\nGOAL STATUS: CONTINUE: verify row counts");
  db.updateGoalStep(o1.id, { threadId: ot1, outcome: "done", settledAt: Date.now() - 7_200_000, turnStartedAt: 1, agentClaimedComplete: false });
  const o2 = db.createGoalStep({ goalId: old.id, title: "Verify", provider: null, model: null, effort: "low", rationale: "", brief: "b" });
  const ot2 = settledTask(db, workspace, `${OLD} · step 2: Verify`, "Counts match.\nGOAL STATUS: COMPLETE");
  db.updateGoalStep(o2.id, { threadId: ot2, outcome: "done", settledAt: Date.now() - 3_600_000, turnStartedAt: 1, agentClaimedComplete: true });
  db.raw.prepare("UPDATE goal_steps SET last_status = NULL WHERE goal_id = ?").run(old.id);
  db.updateGoal(old.id, { status: "achieved", statusReason: "Everything verified.", endedAt: Date.now() - 3_000_000 });
  db.raw.close();
  return { goalId: g.id, t2 };
}

/** A milestone a running step reports, written as the runner writes it, then any goal broadcast. */
async function addMilestone(dataDir, goalId, threadId) {
  const db = await openDb(dataDir);
  db.saveGoalWorkItems(goalId, [
    { key: "conflicts", title: "Conflict resolution UI", status: "planned", note: null, blocker: null, verified: false, verification: null, threadId, updatedAt: Date.now(), startedAt: null, completedAt: null },
  ]);
  db.raw.close();
}

const card = (page, title) => page.locator(".goal-card", { has: page.locator(`.sched-title:text-is("${title}")`) });

/** A narrow board (a phone, or an open task panel) swaps its tabs for a select. */
async function openGoals(page) {
  if (await page.locator(".board-area-select select").isVisible()) await page.selectOption(".board-area-select select", "goals");
  else await page.click('.board-tab:has-text("Goals")');
  await page.waitForSelector(".goal-view .goal-card", { timeout: 15000 });
}

async function load(page) {
  await page.request.post(`http://127.0.0.1:${PORT}/api/login`, { data: { password: authPassword() } });
  await page.goto(`http://127.0.0.1:${PORT}/`, { timeout: 45000 });
  await page.waitForSelector(".accounts .acct, .usage-gauge", { state: "attached", timeout: 30000 });
}

/** Every one-line row in a card: does its text stay on one line, and does anything stick out of the card? */
async function geometry(page, title) {
  return card(page, title).evaluate((el) => {
    const box = el.getBoundingClientRect();
    const lines = [...el.querySelectorAll(".goal-item-title, .goal-branch-title, .goal-now-title, .goal-needs-title, .goal-needs-detail")];
    const multi = lines.filter((n) => n.getBoundingClientRect().height > parseFloat(getComputedStyle(n).lineHeight) * 1.6).map((n) => n.textContent);
    const outside = [...el.querySelectorAll(".goal-work *, .goal-needs *, .goal-now *")]
      .filter((n) => {
        const r = n.getBoundingClientRect();
        return r.width > 0 && (r.right > box.right + 1 || r.left < box.left - 1);
      })
      .map((n) => n.className || n.tagName);
    return { multi, outside, pageOverflow: document.documentElement.scrollWidth - window.innerWidth };
  });
}

(async () => {
  requireBuild();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "goal-tree-lab-"));
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "goal-tree-lab-ws-"));
  const shots = shotDir(dataDir);
  const { goalId, t2 } = await seed(dataDir, workspace);
  killInstance(PORT);
  let child = await boot({ dataDir, port: PORT });
  let code = 1;
  try {
    const chromium = loadChromium();
    const browser = await chromium.launch();
    const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await load(page);
    await openGoals(page);

    // ---- desktop: the tree, the current item, what waits on the owner ----
    const active = card(page, ACTIVE);
    check("the tally counts milestones, never a percentage", /3 done · 1 working · 1 awaiting approval · 1 planned/.test(await active.locator(".goal-work-tally").textContent()) && !/%/.test(await active.locator(".goal-work").textContent()));
    check("the current step names the milestone being worked on", (await active.locator(".goal-now-title").textContent())?.startsWith("Queue writes while offline"));
    check("the approval the goal waits on is above the tree", /iPhone build approval/.test(await active.locator(".goal-needs").textContent()) && /Needs approval/.test(await active.locator(".goal-needs").textContent()));
    check("the working milestone is marked Now", (await active.locator(".goal-item.is-current .goal-item-now").count()) === 1);
    check("the running step is open, the settled one closed", (await active.locator(".goal-branch").first().locator(".goal-items .goal-item").count()) === 4 && (await active.locator(".goal-branch").nth(1).locator(".goal-items").count()) === 0);
    check("milestones from a step outside the window gather under earlier steps", (await active.locator(".goal-branch-title:has-text('Earlier steps')").count()) === 1);
    let geo = await geometry(page, ACTIVE);
    check("desktop: every step and milestone is one line", geo.multi.length === 0, JSON.stringify(geo.multi));
    check("desktop: nothing sticks out of the card", geo.outside.length === 0 && geo.pageOverflow <= 0, JSON.stringify(geo));

    await active.locator(".goal-branch").nth(1).locator(".goal-branch-toggle").click();
    check("a settled step opens onto its status line and milestones", /Last turn: Continue/.test(await active.locator(".goal-branch").nth(1).textContent()) && (await active.locator(".goal-branch").nth(1).locator(".goal-item").count()) === 2);
    await active.locator(".goal-item:has-text('Cache schema') .goal-item-row").click();
    check("a verified milestone shows how it was verified", /Verified: cache\.test: 42 passed/.test(await active.locator(".goal-item:has-text('Cache schema') .goal-item-detail").textContent()));
    await active.locator(".goal-item:has-text('Cache eviction') .goal-item-row").click();
    check("a milestone recorded done but unverified says so", /not reported as verified/.test(await active.locator(".goal-item:has-text('Cache eviction') .goal-item-detail").textContent()));
    await active.locator(".goal-item.is-current .goal-item-row").click();
    const detail = active.locator(".goal-item.is-current .goal-item-detail");
    check("an opened milestone shows its note", /wiring the service worker/.test(await detail.textContent()));
    await page.screenshot({ path: path.join(shots, "goal-tree-desktop.png"), fullPage: true });
    await detail.locator(".sched-lastlink:has-text('Open task')").click();
    await page.waitForSelector(".detail .detail-head", { timeout: 10000 });
    check("Open task opens the step's task", /step 2: Sync queue/.test(await page.locator(".detail .detail-head").textContent()));
    if (!(await page.locator(".goal-view").count())) await openGoals(page);

    // ---- a goal from before milestones: only what was recorded ----
    const old = card(page, OLD);
    check("an old goal invents no milestones", /no milestones reported yet/.test(await old.locator(".goal-work-tally").textContent()));
    check("its newest step shows the status line read from its report", /Last turn: Complete/.test(await old.locator(".goal-branch").first().textContent()));
    check("an ended goal asks nothing of the owner", (await old.locator(".goal-needs").count()) === 0);

    // ---- live: a milestone recorded while the console is open appears without a reload ----
    await addMilestone(dataDir, goalId, t2);
    await page.evaluate(async (id) => {
      const ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`);
      await new Promise((r) => (ws.onopen = r));
      ws.send(JSON.stringify({ type: "goal.update", id, patch: { title: "Offline support" } }));
      await new Promise((r) => setTimeout(r, 500));
      ws.close();
    }, goalId);
    const appeared = await active.locator(".goal-item-title:has-text('Conflict resolution UI')").waitFor({ timeout: 10000 }).then(() => true, () => false);
    check("a newly recorded milestone appears live", appeared);
    await page.context().close();

    // ---- iPhone ----
    const phoneContext = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 3 });
    const phone = await phoneContext.newPage();
    phone.on("pageerror", (e) => errors.push(e.message));
    await load(phone);
    await openGoals(phone);
    geo = await geometry(phone, ACTIVE);
    check("iPhone: every step and milestone is one line", geo.multi.length === 0, JSON.stringify(geo.multi));
    check("iPhone: nothing sideways", geo.outside.length === 0 && geo.pageOverflow <= 0, JSON.stringify(geo));
    const rowHeight = await card(phone, ACTIVE).locator(".goal-item-row").first().evaluate((n) => n.getBoundingClientRect().height);
    check("iPhone: milestone rows are tap-sized", rowHeight >= 40, String(rowHeight));
    await card(phone, ACTIVE).screenshot({ path: path.join(shots, "goal-tree-iphone.png") });
    await card(phone, ACTIVE).locator(".goal-item.ws-awaiting_approval .goal-item-row").tap();
    check("iPhone: a tap opens a milestone's blocker", /Needs approval: Mikkel installs/.test(await card(phone, ACTIVE).locator(".goal-item.ws-awaiting_approval .goal-item-detail").textContent()));
    await phoneContext.close();

    // ---- a restart keeps everything ----
    killInstance(PORT);
    child = await boot({ dataDir, port: PORT });
    const after = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
    after.on("pageerror", (e) => errors.push(e.message));
    await load(after);
    await openGoals(after);
    check("after a restart the milestones are all there", (await card(after, ACTIVE).locator(".goal-work-tally").textContent()).includes("2 planned"));
    check("after a restart the backfilled status lines remain", /Last turn: Complete/.test(await card(after, OLD).locator(".goal-branch").first().textContent()));
    check("no page errors", errors.length === 0, errors.join(" | "));

    await browser.close();
    code = check.summary();
    console.log(`screenshots: ${shots}`);
  } catch (e) {
    console.error(e);
  } finally {
    killInstance(PORT);
    child.kill();
  }
  process.exit(code);
})();
