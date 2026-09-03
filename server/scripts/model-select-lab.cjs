// Drive the "Auto model selection" settings surface in a real browser, headlessly, without touching
// prod — the toggle's round-trip and the scoreboard that renders the grades feeding the next pick.
//
//   npm run model-lab --prefix server
//   npm run model-lab --prefix server -- --keep
//
// Why a lab and not a bundle grep: the toggle is a real round-trip (click → settings.set → the server's
// broadcast is the only thing the switch reads back), and the scoreboard is rendered ONLY from
// server-side data, so both are exactly the class of thing a green typecheck says nothing about. Prod is
// off-limits to click (see .claude/rules/verify-a-ui-change-shipped.md), so this boots its OWN instance
// on :4337 against a temp DATA_DIR, seeds `model_grades` rows, and clicks freely. Bogus account tokens
// (via lab-harness) mean the boot ping can't start a real 5h window; the instance is killed by port owner.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Database = require("better-sqlite3");
const { loadChromium, authPassword, requireBuild, boot, killInstance, createChecks } = require("./lab-harness.cjs");

const PORT = 4337;
const BASE = `http://127.0.0.1:${PORT}`;
const NAV_TIMEOUT = 45_000; // this box runs near 100% CPU; a cold goto has measured 28s

/** Two graded picks, chosen so the rendered table can be verified digit by digit. */
const SEED = [
  { model: "claude-haiku-4-5-20251001", provider: "claude", score: 88, done: 1, qa: 2, cost: 0.42, minutes: 6 },
  { model: "glm-4.6", provider: "zai", score: 40, done: 0, qa: 3, cost: 1.5, minutes: 21 },
];

function seed(dataDir) {
  const db = new Database(path.join(dataDir, "orchestrator.sqlite"));
  const at = Date.now();
  const insert = db.prepare(
    `INSERT INTO model_grades(thread_id, workspace, title, provider, model, effort, reason, outcome, score,
       qa_rounds, cost_usd, num_turns, duration_ms, ran_models, graded_model, created_at, graded_at)
     VALUES(@threadId, @workspace, @title, @provider, @model, 'high', 'seeded by the lab', @outcome, @score,
       @qaRounds, @costUsd, 20, @durationMs, @model, @model, @createdAt, @gradedAt)`,
  );
  SEED.forEach((s, i) =>
    insert.run({
      threadId: `lab-${i}`,
      workspace: "c:/lab/repo",
      title: `seeded task ${i}`,
      provider: s.provider,
      model: s.model,
      outcome: s.done ? "done" : "review",
      score: s.score,
      qaRounds: s.qa,
      costUsd: s.cost,
      durationMs: s.minutes * 60_000,
      createdAt: at - 60_000,
      gradedAt: at,
    }),
  );
  db.close();
}

async function openSettings(browser) {
  const page = await browser.newPage({ viewport: { width: 1500, height: 950 } });
  await page.request.post(`${BASE}/api/login`, { data: { password: authPassword() } });
  await page.goto(`${BASE}/`, { timeout: NAV_TIMEOUT });
  // Wait for the socket's `hello` — not just for the shell to mount. Every value this lab reads (the
  // toggle's state, the whole scoreboard) comes from that frame, and the panel renders neutral defaults
  // until it lands: opening on `.topbar` alone reads "off" and an empty board on a busy box, which is
  // indistinguishable from the feature being broken. The account chips are hello-only, so they are the signal.
  await page.waitForSelector(".accounts .acct", { timeout: 25_000 });
  await page.click('[aria-label="Open settings"]');
  await page.waitForSelector('[role="dialog"][aria-label="Settings"]', { timeout: 20_000 });
  await page.click('[data-settings-category="pipeline"]');
  return page;
}

const TOGGLE = 'button.switch[aria-label="Auto-select the implementor model"]';

/** Wait for the SERVER to have persisted the toggle. The switch reflects the click optimistically, so
 *  reloading straight after it is a race — on a loaded box the new page can win against the round-trip
 *  and read back the old value, which looks exactly like a broken setting. The instance's own kv row is
 *  the thing being claimed, so poll that (read-only, cross-process: WAL frames are visible). */
async function waitForPersisted(dataDir, key, timeoutMs = 15_000) {
  const file = path.join(dataDir, "orchestrator.sqlite");
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const db = new Database(file, { readonly: true });
    const row = db.prepare("SELECT value FROM kv WHERE key = ?").get(key);
    db.close();
    if (row) return row.value;
    await new Promise((r) => setTimeout(r, 250));
  }
  return null;
}

/** The scoreboard as the operator reads it: one row per model, in render order. */
function readBoard(page) {
  return page.evaluate(() => {
    const board = document.querySelector(".ams-board");
    if (!board) return null;
    return [...board.querySelectorAll(".ams-row:not(.ams-head)")].map((row) =>
      [...row.querySelectorAll("span")].map((s) => s.textContent.trim()),
    );
  });
}

async function main() {
  requireBuild();
  const check = createChecks();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "model-lab-"));
  const keep = process.argv.includes("--keep");
  console.log(`model-select-lab — ${BASE} (data ${dataDir})`);

  try {
    // First boot creates the schema; seed into it, then boot again so the hello frame carries the stats.
    await boot({ dataDir, port: PORT });
    killInstance(PORT);
    seed(dataDir);
    await boot({ dataDir, port: PORT });

    const browser = await loadChromium().launch();
    try {
      const page = await openSettings(browser);
      check("the Auto model selection group renders", (await page.locator('.settings-group-label:text-is("Auto model selection")').count()) === 1);
      check("the toggle is present", (await page.locator(TOGGLE).count()) === 1);
      check("it is OFF for a fresh instance", (await page.getAttribute(TOGGLE, "aria-checked")) === "false", await page.getAttribute(TOGGLE, "aria-checked"));

      const board = await readBoard(page);
      check("the scoreboard renders both graded models", board?.length === 2, JSON.stringify(board));
      const haiku = board?.find((r) => r[0].includes("haiku"));
      check("its numbers are the server's", haiku?.join("|") === "claude-haiku-4-5-20251001|1|88|100%|2|$0.42|—", haiku?.join("|"));
      const glm = board?.find((r) => r[0] === "glm-4.6");
      check("a handed-back task shows as not accepted", glm?.join("|") === "glm-4.6|1|40|0%|3|$1.50|—", glm?.join("|"));

      // The round-trip: click, then wait for the SERVER to own it before believing anything.
      await page.click(TOGGLE);
      check("clicking it turns it on", (await page.getAttribute(TOGGLE, "aria-checked")) === "true", await page.getAttribute(TOGGLE, "aria-checked"));
      const stored = await waitForPersisted(dataDir, "setting_auto_model_selection");
      check("the click reaches the server and is persisted", stored === "1", String(stored));

      const shot = path.join(dataDir, "auto-model-selection.png");
      await page.locator('[role="dialog"][aria-label="Settings"]').screenshot({ path: shot });
      console.log(`  screenshot: ${shot}`);
      await page.close();

      // A reload proves it was PERSISTED server-side rather than held in the client's store.
      const second = await openSettings(browser);
      check("it survives a reload (persisted server-side)", (await second.getAttribute(TOGGLE, "aria-checked")) === "true", await second.getAttribute(TOGGLE, "aria-checked"));
      await second.close();
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
