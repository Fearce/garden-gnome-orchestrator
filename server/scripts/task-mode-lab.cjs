#!/usr/bin/env node
/**
 * task-mode-lab — drives the TIMED + SHOTGUN console surfaces in a real (headless) browser.
 *
 * A typecheck and a build prove the code compiles; they say nothing about whether the composer row
 * actually round-trips a pick to the server, whether a collaborator is really hidden from the board,
 * or whether the lead's panel lists its shares. This drives all of that against its OWN throwaway
 * instance on alt ports with an empty temp DB — never prod, whose DB would auto-resume real agents.
 *
 *   npm run task-mode-lab --prefix server
 *
 * Read `.claude/rules/task-modes.md` for what the surfaces mean, and the project memory
 * `browser-test-throwaway-instance` for why the instance is built this way.
 */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { SERVER_ROOT, loadChromium, authPassword, requireBuild, boot, killInstance, createChecks } = require("./lab-harness.cjs");

const PORT = 4337;
const BASE = `http://127.0.0.1:${PORT}`;
const DATA_DIR = path.join(os.tmpdir(), "gg-taskmode-lab");
const HOUR = 3_600_000;
// A label only — these fixture threads never touch disk, and the console renders the path verbatim.
const FIXTURE_WORKSPACE = "fixture/repo";

/** Block until the console's WS is connected, so a read reflects the SERVER's state rather than the
 *  client's pre-`hello` defaults. `.conn` is the console's own connection indicator. */
async function waitForLiveSocket(page) {
  await page.waitForFunction(() => document.querySelector(".conn")?.textContent?.trim().toLowerCase() === "live", null, { timeout: 30_000 });
  await page.waitForTimeout(250); // let the hello-driven re-render flush
}

/** Seed the rows the surfaces read. Done directly against the throwaway DB after boot, so no agent
 *  ever runs: the console renders from thread rows, which is exactly what is under test. */
function seed() {
  const Database = require(path.join(SERVER_ROOT, "node_modules", "better-sqlite3"));
  const db = new Database(path.join(DATA_DIR, "orchestrator.sqlite"));
  const now = Date.now();
  const insert = db.prepare(
    `INSERT INTO threads(id, title, state, workspace, brief, raw_prompt, duration_ms, deadline_at, agent_count, parent_id, assignment, created_at, updated_at)
     VALUES(@id, @title, @state, @workspace, @brief, @raw, @duration, @deadline, @agents, @parent, @assignment, @at, @at)`,
  );
  const row = (o) =>
    insert.run({
      workspace: FIXTURE_WORKSPACE,
      brief: "lab",
      raw: "lab",
      duration: null,
      deadline: null,
      agents: null,
      parent: null,
      assignment: null,
      at: now,
      ...o,
    });

  row({ id: "t-plain", title: "An ordinary task", state: "implementing" });
  row({ id: "t-timed", title: "A timed task", state: "implementing", duration: 8 * HOUR, deadline: now + 6 * HOUR + 12 * 60_000 });
  row({ id: "t-over", title: "A finished window", state: "review", duration: HOUR, deadline: now - 60_000 });
  row({ id: "t-lead", title: "A shotgun lead", state: "implementing", agents: 3 });
  row({
    id: "t-kid1",
    title: "Share: the api",
    state: "implementing",
    parent: "t-lead",
    assignment: JSON.stringify({ title: "api", objective: "build the api", files: ["src/api", "src/db"] }),
  });
  row({
    id: "t-kid2",
    title: "Share: the web",
    state: "done",
    parent: "t-lead",
    assignment: JSON.stringify({ title: "web", objective: "build the web", files: ["web/src"] }),
  });
  db.close();
}

async function main() {
  requireBuild();
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
  fs.mkdirSync(DATA_DIR, { recursive: true });
  killInstance(PORT);

  const check = createChecks();
  let child;
  let browser;
  try {
    console.log(`booting a throwaway instance on ${PORT} (empty DB at ${DATA_DIR})…`);
    child = await boot({ dataDir: DATA_DIR, port: PORT });
    seed();

    const chromium = loadChromium();
    browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
    const errors = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    page.on("console", (m) => m.type() === "error" && errors.push(m.text()));

    // The instance inherits the real .env password, so log in the way CLAUDE.md documents.
    await page.request.post(`${BASE}/api/login`, { data: { password: authPassword() } });
    // An explicit timeout + one retry: this box runs near 100% CPU, where a cold goto has measured
    // 28s while plain HTTP answers in ms. A busy box must not read as a broken feature.
    await page.goto(`${BASE}/`, { timeout: 45_000 }).catch(() => page.goto(`${BASE}/`, { timeout: 45_000 }));
    await page.waitForSelector(".topbar", { timeout: 45_000 });
    await waitForLiveSocket(page);
    await page.waitForSelector(".card", { timeout: 45_000 });

    // ---- the board ------------------------------------------------------------------------------
    const titles = await page.$$eval(".card .title", (els) => els.map((e) => e.textContent.trim()));
    check("the board renders the ordinary task", titles.includes("An ordinary task"), titles.join(" | "));
    check("the board renders the timed task", titles.includes("A timed task"), titles.join(" | "));
    check("the board renders the shotgun lead", titles.includes("A shotgun lead"), titles.join(" | "));
    // The whole point of hiding them: N collaborator cards beside their lead is the clutter the brief rules out.
    check("a COLLABORATOR is hidden from the board", !titles.includes("Share: the api") && !titles.includes("Share: the web"), titles.join(" | "));

    const timedBadge = await page.$eval('[data-thread-id="t-timed"] .timed-badge', (e) => e.textContent.trim()).catch(() => null);
    check("the timed card shows a live countdown", !!timedBadge && /left$/.test(timedBadge), String(timedBadge));
    check("...reading the real remaining time, not the total", !!timedBadge && timedBadge.startsWith("6h"), String(timedBadge));
    const overBadge = await page.$eval('[data-thread-id="t-over"] .timed-badge', (e) => ({ text: e.textContent.trim(), over: e.className.includes("over") })).catch(() => null);
    check("a task past its deadline reads 'window ended'", overBadge?.text === "window ended", JSON.stringify(overBadge));
    check("...and is styled as over", overBadge?.over === true, JSON.stringify(overBadge));
    const shotBadge = await page.$eval('[data-thread-id="t-lead"] .shotgun-badge', (e) => e.textContent.trim()).catch(() => null);
    check("the lead card shows its agent count (lead + collaborators)", shotBadge === "⚡ 3", String(shotBadge));
    const plainBadges = await page.$$eval('[data-thread-id="t-plain"] .timed-badge, [data-thread-id="t-plain"] .shotgun-badge', (els) => els.length);
    check("an ordinary card grows NO new badges", plainBadges === 0, String(plainBadges));

    // ---- the lead's detail panel ------------------------------------------------------------------
    await page.click('[data-thread-id="t-lead"]');
    await page.waitForSelector(".taskmode-panel", { timeout: 15_000 });
    const collabs = await page.$$eval(".taskmode-collab .taskmode-collab-title", (els) => els.map((e) => e.textContent.trim()));
    check("the lead's panel lists both shares", collabs.includes("Share: the api") && collabs.includes("Share: the web"), collabs.join(" | "));
    const collabStates = await page.$$eval(".taskmode-collab .taskmode-collab-state", (els) => els.map((e) => e.textContent.trim().toLowerCase()));
    check("...each with its own live state", collabStates.some((s) => s.includes("done")) && collabStates.length === 2, collabStates.join(" | "));

    // Clicking a share opens it — the collaborator is reachable even though it is off the board.
    await page.click(".taskmode-collab");
    await page.waitForTimeout(400);
    const shareRow = await page.$eval(".taskmode-panel", (e) => e.textContent).catch(() => "");
    check("a hidden collaborator can still be opened from its lead", /share of/i.test(shareRow), shareRow.slice(0, 120));
    check("...and names the files it owns", /src\/api/.test(shareRow), shareRow.slice(0, 200));

    // ---- the timed task's panel -------------------------------------------------------------------
    await page.click('[data-thread-id="t-timed"]');
    await page.waitForSelector(".taskmode-panel", { timeout: 15_000 });
    const windowRow = await page.$eval(".taskmode-panel", (e) => e.textContent);
    check("the timed panel states the window it was given", /8h/.test(windowRow), windowRow.slice(0, 120));
    check("...and how much is left", /left/.test(windowRow), windowRow.slice(0, 120));

    // ---- the composer row: a real round-trip through the server ------------------------------------
    const durSel = ".composer-taskmode select[aria-label='Work window']";
    const agtSel = ".composer-taskmode select[aria-label='Agents']";
    check("the composer shows the task-mode row", !!(await page.$(durSel)) && !!(await page.$(agtSel)));
    check("it starts off (no time limit, 1 agent)", (await page.$eval(durSel, (e) => e.value)) === "0" && (await page.$eval(agtSel, (e) => e.value)) === "1");
    check("...and is visually quiet while off", !(await page.$eval(".composer-taskmode", (e) => e.className.includes("on"))));

    await page.selectOption(durSel, "480");
    await page.selectOption(agtSel, "3");
    await page.waitForTimeout(600); // the value round-trips through settings.set → the server → the broadcast
    check("the row lights up once a mode is on", await page.$eval(".composer-taskmode", (e) => e.className.includes("on")));
    check("the duration select is lit", await page.$eval(durSel, (e) => e.className.includes("lit")));
    check("the agents select is lit", await page.$eval(agtSel, (e) => e.className.includes("lit")));

    // The real test of the round-trip: reload and see the SERVER's value come back, not local state.
    // The composer renders IMMEDIATELY from the client's default settings and only adopts the server's
    // once the WS `hello` lands, so reading the select the moment the element exists races that frame
    // and reads the default every time — a green-looking check that proves nothing, and a red one that
    // blames the feature. Wait for the socket to actually be live first.
    await page.reload({ timeout: 45_000 });
    await page.waitForSelector(".composer-taskmode", { timeout: 45_000 });
    await waitForLiveSocket(page);
    check("the window pick survived a reload (server-persisted)", (await page.$eval(durSel, (e) => e.value)) === "480", await page.$eval(durSel, (e) => e.value));
    check("the agent pick survived a reload", (await page.$eval(agtSel, (e) => e.value)) === "3", await page.$eval(agtSel, (e) => e.value));

    // Clearing it must genuinely reset both, not just the one that was touched.
    await page.click(".taskmode-clear");
    await page.waitForTimeout(600);
    await page.reload({ timeout: 45_000 });
    await page.waitForSelector(".composer-taskmode", { timeout: 45_000 });
    await waitForLiveSocket(page);
    check("clearing resets the window", (await page.$eval(durSel, (e) => e.value)) === "0", await page.$eval(durSel, (e) => e.value));
    check("clearing resets the agent count", (await page.$eval(agtSel, (e) => e.value)) === "1", await page.$eval(agtSel, (e) => e.value));

    check("no console errors while driving all of it", errors.length === 0, errors.slice(0, 3).join(" | "));

    await page.screenshot({ path: path.join(DATA_DIR, "task-mode-lab.png"), fullPage: false });
    console.log(`\nscreenshot: ${path.join(DATA_DIR, "task-mode-lab.png")}`);
  } finally {
    if (browser) await browser.close().catch(() => {});
    if (child) child.kill();
    killInstance(PORT);
  }
  process.exit(check.summary() ? 0 : 1);
}

main().catch((e) => {
  console.error("lab error:", e);
  killInstance(PORT);
  process.exit(2);
});
