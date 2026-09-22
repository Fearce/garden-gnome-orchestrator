// Lab for per-message model attribution in the task feed (`npm run run-attribution-lab`).
//
// The SSR gate (`test:run-attribution`) proves the panel labels a row from the row's own run, but it
// hands the store a runs map by hand. The half it cannot see is the one that actually broke in the
// field: the connect snapshot carries only the newest runs FLEET-WIDE, so a long task's earlier runs
// reach the console only because `thread.history` now ships the task's own runs. Seed enough newer runs
// to push the older one out of that snapshot, then open the task in a real browser and read the labels.
//
// Boots its own throwaway instance. Not in GATES: it needs a browser + an instance, like the other labs.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { loadChromium, authPassword, requireBuild, boot, killInstance, createChecks, shotDir } = require("./lab-harness.cjs");

const PORT = 4387;
const SNAPSHOT_RUNS = 300; // mirrors ws/hub.ts — the bound this lab exists to push the older run past
const check = createChecks();
const TASK = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
const OPUS_RUN = "aaaaaaaa-2222-4222-8222-000000000001";
const SONNET_RUN = "aaaaaaaa-2222-4222-8222-000000000002";

function seed(dataDir) {
  const Database = require(path.join(__dirname, "..", "node_modules", "better-sqlite3"));
  const db = new Database(path.join(dataDir, "orchestrator.sqlite"));
  const now = Date.now();
  const insThread = db.prepare(
    "INSERT INTO threads (id, title, raw_prompt, brief, workspace, state, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)",
  );
  const insRun = db.prepare(
    "INSERT INTO agent_runs (id, thread_id, role, model, account, effort, state, started_at, ended_at) VALUES (?,?,?,?,?,?,?,?,?)",
  );
  const insMsg = db.prepare(
    "INSERT INTO messages (id, thread_id, run_id, role, kind, content, created_at) VALUES (?,?,?,?,?,?,?)",
  );

  insThread.run(TASK, "MIXED MODEL TASK", "p", "b", process.cwd(), "implementing", now - 900_000, now);
  insRun.run(OPUS_RUN, TASK, "implementor", "claude-opus-5-5", "personal", "high", "done", now - 900_000, now - 800_000);
  insRun.run(SONNET_RUN, TASK, "implementor", "claude-sonnet-5", "personal", "medium", "running", now - 700_000, null);
  insMsg.run("msg-opus", TASK, OPUS_RUN, "implementor", "text", "OPUS LINE: written before the model changed.", now - 850_000);
  insMsg.run("msg-sonnet", TASK, SONNET_RUN, "implementor", "text", "SONNET LINE: written after the model changed.", now - 650_000);

  // Bury both of this task's runs under a full snapshot's worth of newer runs on OTHER tasks, so the
  // connect frame cannot carry them and only the history reply can.
  const filler = db.transaction(() => {
    for (let i = 0; i < SNAPSHOT_RUNS + 20; i++) {
      const tid = `bbbbbbbb-0000-4000-8000-${String(i).padStart(12, "0")}`;
      // Closed, so 320 filler cards do not paginate the task under test off the board — their RUNS are
      // what this lab needs, and the connect snapshot carries runs regardless of task state.
      insThread.run(tid, `FILLER ${i}`, "p", "b", process.cwd(), "closed", now - 10_000 + i, now - 10_000 + i);
      insRun.run(`cccccccc-0000-4000-8000-${String(i).padStart(12, "0")}`, tid, "implementor", "claude-opus-5-5", "personal", "high", "done", now - 10_000 + i, now - 9_000 + i);
    }
  });
  filler();
  // Prove the seed really buried them: the connect frame is the newest SNAPSHOT_RUNS rows by
  // started_at, so a rank past that bound is what makes this lab test the history payload.
  const rank = db
    .prepare("SELECT COUNT(*) AS n FROM agent_runs WHERE started_at > (SELECT started_at FROM agent_runs WHERE id = ?)")
    .get(OPUS_RUN).n;
  db.close();
  return { opusRunRank: rank };
}

async function openTask(page) {
  await page.click(`.card:has-text("MIXED MODEL TASK")`, { timeout: 30000 });
  await page.waitForSelector(".detail-head", { timeout: 15000 });
  await page.waitForFunction(
    () => [...document.querySelectorAll(".fi.text .body")].some((b) => b.textContent?.startsWith("OPUS LINE")),
    undefined,
    { timeout: 20000 },
  );
}

/** Wait for the older run's label, and report its ABSENCE as the defect it is. Without the history
 *  reply's `runs` payload this never arrives — a bare `waitForFunction` would then die on an anonymous
 *  Playwright timeout instead of saying which claim failed. */
async function awaitOpusLabel(page, where) {
  try {
    await page.waitForFunction(
      () => {
        const row = [...document.querySelectorAll(".fi.text")].find((r) => r.querySelector(".body")?.textContent?.startsWith("OPUS LINE"));
        return !!row?.querySelector(".role-model")?.textContent;
      },
      undefined,
      { timeout: 20000 },
    );
    return true;
  } catch {
    check(`the older run resolves to a model ${where}`, false, "no .role-model on the OPUS row — thread.history did not carry the task's runs");
    return false;
  }
}

async function labelsInFeed(page) {
  return page.evaluate(() => {
    const out = {};
    for (const row of document.querySelectorAll(".fi.text")) {
      const text = row.querySelector(".body")?.textContent ?? "";
      const key = text.startsWith("OPUS LINE") ? "opus" : text.startsWith("SONNET LINE") ? "sonnet" : null;
      if (key) out[key] = row.querySelector(".role-model")?.textContent ?? null;
    }
    return out;
  });
}

(async () => {
  requireBuild();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "run-attribution-"));
  killInstance(PORT);
  // Boot FIRST: the server's own constructor is what creates the schema this seed writes into.
  const child = await boot({ dataDir, port: PORT, env: { ORCH_LAB_FIXTURES: "1" } });
  let code = 1;
  let browser;
  try {
    const { opusRunRank } = seed(dataDir);
    check(
      "the older run is genuinely outside the connect snapshot",
      opusRunRank >= SNAPSHOT_RUNS,
      `${opusRunRank} newer runs — the snapshot carries ${SNAPSHOT_RUNS}`,
    );
    const chromium = loadChromium();
    browser = await chromium.launch();
    const ctx = await browser.newContext({ viewport: { width: 1500, height: 950 } });
    const page = await ctx.newPage();
    await page.request.post(`http://127.0.0.1:${PORT}/api/login`, { data: { password: authPassword() } });
    await page.goto(`http://127.0.0.1:${PORT}/`, { timeout: 45000 });
    await page.waitForSelector(".accounts .acct", { timeout: 30000 }); // hello landed

    await openTask(page);
    // The history reply carries the runs; the label appears with it, not before.
    await awaitOpusLabel(page, "on open");

    const labels = await labelsInFeed(page);
    check("the Opus run's message says Opus", labels.opus === "Opus 5.5 High", JSON.stringify(labels));
    check("the Sonnet run's message says Sonnet", labels.sonnet === "Sonnet 5 Medium", JSON.stringify(labels));

    const chip = await page.evaluate(() => {
      const el = [...document.querySelectorAll(".fchip")].find((b) => b.textContent?.includes("implementor"));
      const model = el?.querySelector(".role-model");
      return { label: model?.textContent ?? null, title: model?.getAttribute("title") ?? null };
    });
    check("the role chip counts the models rather than naming one", chip.label === "Sonnet 5 Medium +1", JSON.stringify(chip));
    check("the role chip enumerates them in its tooltip", chip.title === "Ran on Sonnet 5 Medium, Opus 5.5 High", JSON.stringify(chip));

    // A reload re-delivers the bounded snapshot and re-fetches history from nothing; the labels must
    // come back, which they can only do from the history payload.
    await page.reload({ timeout: 45000 });
    await page.waitForSelector(".accounts .acct", { timeout: 30000 });
    await openTask(page);
    await awaitOpusLabel(page, "after a reload");
    const afterReload = await labelsInFeed(page);
    check("a reload keeps the Opus message on Opus", afterReload.opus === "Opus 5.5 High", JSON.stringify(afterReload));
    check("a reload keeps the Sonnet message on Sonnet", afterReload.sonnet === "Sonnet 5 Medium", JSON.stringify(afterReload));

    await page.screenshot({ path: path.join(shotDir(dataDir), "run-attribution.png"), fullPage: false });
    await ctx.close();
    code = check.summary();
  } catch (e) {
    console.error(e);
  } finally {
    if (browser) await browser.close().catch(() => {});
    child.kill();
    killInstance(PORT);
    try {
      fs.rmSync(dataDir, { recursive: true, force: true });
    } catch {}
  }
  process.exit(code);
})();
