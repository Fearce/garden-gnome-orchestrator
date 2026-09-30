// Lab for the card that closes a done/review task's feed (`npm run final-report-lab`). The owner's
// complaint was that the implementor's final report drowned under QA and self-improvement rows, so the
// one thing only a browser shows is WHERE it lands: last in the real feed, below the later QA chatter,
// and in view when the task opens (the panel sticks to its newest row). It also drives the opt-in
// "Summarize done task deliverables" toggle through the real Settings panel and proves the card swaps
// to the stored summary with the implementor's own report one click away.
//
// Seeds one done task: an implementor run with its final report, two QA rows AFTER it, the durable
// memo, a deliverable, and a stored summary. The throwaway runs bogus account tokens, so the summarizer's
// background refresh on open fails harmlessly and the stored summary is what renders.
//
//   npm run final-report-lab --prefix server
//   npm run final-report-lab --prefix server -- --keep
//
// Safe against prod: temp DATA_DIR, bogus tokens, its own port, killed by port owner (lab-harness.cjs).

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Database = require("better-sqlite3");
const { loadChromium, authPassword, requireBuild, boot, killInstance, createChecks, shotDir, waitForPersisted, waitForSettingsReloadSafe, isVoiceBridgeNoise } = require("./lab-harness.cjs");

const PORT = 5347;
const BASE = `http://127.0.0.1:${PORT}`;
const TASK_ID = "final-report-lab-task-00000000001";
const MEMO_ID = "final-report-lab-memo-1";
const KV_KEY = "setting_summarize_done_deliverables";
const TOGGLE = 'button.switch[aria-label="Summarize done task deliverables"]';

const REPORT = "Implemented the CSV export for the orders page.\n\n**Validation:** `npm test` passed, 42 checks.\n\nCommit `abc1234` pushed to master.";
const QA_TEXT = "QA verdict: PASS. Every hunk reviewed; nothing further to add.";
const SELF_IMPROVE_TEXT = "Self-improvement: recorded a memory about the export helper.";
const SUMMARY = "The CSV export is live on the orders page.\n\n**Deliverables**\n- Sample export — `out/sample.csv`";

function seed(dataDir) {
  const workspace = path.join(dataDir, "workspace");
  fs.mkdirSync(path.join(workspace, "out"), { recursive: true });
  const csv = path.join(workspace, "out", "sample.csv");
  fs.writeFileSync(csv, "id,total\n1,10\n", "utf8");

  const db = new Database(path.join(dataDir, "orchestrator.sqlite"));
  const now = Date.now();
  const stage = {
    deliverableSummary: { text: SUMMARY, model: "claude-sonnet-5", memoId: MEMO_ID, sourceKey: "lab-seeded", taskState: "done", createdAt: now - 5_000 },
  };
  db.prepare(
    "INSERT INTO threads (id, title, state, workspace, brief, raw_prompt, stage_outputs, created_at, updated_at) VALUES (?, ?, 'done', ?, ?, ?, ?, ?, ?)",
  ).run(TASK_ID, "Add a CSV export to the orders page", workspace, "Add a CSV export.", "Add a CSV export.", JSON.stringify(stage), now - 600_000, now);
  const run = db.prepare("INSERT INTO agent_runs (id, thread_id, role, model, account, state, started_at, ended_at) VALUES (?, ?, ?, 'claude-opus-5-5', 'subscription-a', 'done', ?, ?)");
  run.run("frl-impl", TASK_ID, "implementor", now - 500_000, now - 300_000);
  run.run("frl-qa", TASK_ID, "qa", now - 290_000, now - 100_000);
  const msg = db.prepare("INSERT INTO messages (id, thread_id, run_id, role, kind, content, created_at) VALUES (?, ?, ?, ?, 'text', ?, ?)");
  msg.run("frl-m1", TASK_ID, "frl-impl", "implementor", REPORT, now - 300_000);
  msg.run("frl-m2", TASK_ID, "frl-qa", "qa", QA_TEXT, now - 120_000);
  msg.run("frl-m3", TASK_ID, "frl-impl", "implementor", SELF_IMPROVE_TEXT, now - 60_000);
  db.prepare(
    "INSERT INTO implementation_memos (id, thread_id, run_id, work_revision, revision, outcome, handoff, report, model, account, deliverables, source, started_at, completed_at, created_at, updated_at) VALUES (?, ?, 'frl-impl', 'implementation:1', 1, 'completed', 'done', ?, 'claude-opus-5-5', 'subscription-a', '[]', 'run', ?, ?, ?, ?)",
  ).run(MEMO_ID, TASK_ID, REPORT, now - 500_000, now - 300_000, now - 300_000, now - 300_000);
  db.prepare(
    "INSERT INTO findings (id, thread_id, from_run_id, from_role, kind, summary, detail, path, label, severity, routed, created_at) VALUES ('frl-f1', ?, 'frl-impl', 'implementor', 'deliverable', 'Sample export', 'Ten rows', ?, 'Sample export', 'info', 0, ?)",
  ).run(TASK_ID, csv, now - 310_000);
  db.close();
}

/** Where the closing card sits: the last row of the feed, below every later row, and in view. */
async function cardPlacement(page) {
  return page.evaluate(() => {
    const feed = document.querySelector(".detail-body .feed");
    const card = feed?.querySelector(".fi.final-report");
    const scroller = document.querySelector(".detail-body");
    if (!feed || !card || !scroller) return null;
    const rows = [...feed.children];
    const cardBox = card.getBoundingClientRect();
    const viewBox = scroller.getBoundingClientRect();
    return {
      isLast: rows.at(-1) === card,
      afterQa: rows.findIndex((row) => row.textContent?.includes("QA verdict: PASS")) < rows.indexOf(card),
      afterSelfImprove: rows.findIndex((row) => row.textContent?.includes("Self-improvement: recorded")) < rows.indexOf(card),
      inView: cardBox.bottom > viewBox.top && cardBox.top < viewBox.bottom,
      text: card.textContent ?? "",
    };
  });
}

async function openTask(page) {
  await page.goto(`${BASE}/`, { timeout: 45_000 });
  await page.waitForSelector(".accounts .acct", { state: "attached", timeout: 30_000 });
  await page.click(".card", { timeout: 45_000 });
  await page.waitForSelector(".detail .fi.final-report", { timeout: 20_000 });
  await page.waitForTimeout(600); // the stick-to-newest scroll runs after layout
}

async function main() {
  requireBuild();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "final-report-lab-"));
  console.log(`final-report-lab: one done task with QA + self-improvement rows after its report on ${BASE}`);
  const check = createChecks();
  killInstance(PORT);
  let child = null;
  try {
    child = await boot({ dataDir, port: PORT });
    child.kill();
    killInstance(PORT);
    seed(dataDir);
    child = await boot({ dataDir, port: PORT });

    const chromium = loadChromium();
    const browser = await chromium.launch();
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await ctx.newPage();
    const errors = [];
    page.on("console", (m) => {
      if (m.type() === "error" && !isVoiceBridgeNoise(m)) errors.push(m.text());
    });
    page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
    await page.request.post(`${BASE}/api/login`, { data: { password: authPassword() } });

    // ---- setting OFF (the default): the implementor's own report closes the feed ----
    await openTask(page);
    let at = await cardPlacement(page);
    check("the final report is the LAST row of the feed", !!at?.isLast, JSON.stringify(at));
    check("...below the QA verdict that came after it", !!at?.afterQa);
    check("...and below the self-improvement row", !!at?.afterSelfImprove);
    check("...and in view when the task opens", !!at?.inView);
    check("with the setting off it shows the implementor's report verbatim", !!at?.text.includes("Implemented the CSV export") && !!at?.text.includes("abc1234"), at?.text);
    check("no summary shows while the setting is off", !at?.text.includes("Summarized by"));
    await page.screenshot({ path: path.join(shotDir(dataDir), "final-report-raw.png") });

    // ---- the memo button opens the real audit modal ----
    await page.click(".fi.final-report .final-report-open");
    await page.waitForSelector(".modal.implementation-memo-modal", { timeout: 5_000 });
    check("Open work memo opens the memo modal", (await page.locator(".modal.implementation-memo-modal").count()) === 1);
    await page.keyboard.press("Escape");
    await page.waitForSelector(".modal.implementation-memo-modal", { state: "detached", timeout: 5_000 });

    // ---- turn the setting on through the real Settings panel ----
    await page.click('[aria-label="Open settings"]');
    await page.waitForSelector('[role="dialog"][aria-label="Settings"]', { timeout: 20_000 });
    await page.click('[data-settings-category="pipeline"]');
    await page.waitForSelector(TOGGLE, { timeout: 10_000 });
    check("the toggle defaults to off", (await page.getAttribute(TOGGLE, "aria-checked")) === "false");
    await page.click(TOGGLE);
    check("the toggle round-trips to the server", (await waitForPersisted(dataDir, KV_KEY, "1")) === "1");
    await waitForSettingsReloadSafe(dataDir, KV_KEY, "1");
    await page.keyboard.press("Escape");
    await page.waitForSelector('[role="dialog"][aria-label="Settings"]', { state: "detached", timeout: 5_000 }).catch(() => {});

    // ---- setting ON: the stored Sonnet summary leads, the full report stays one click away ----
    await openTask(page);
    await page.waitForSelector(".fi.final-report .final-report-provenance", { timeout: 15_000 });
    at = await cardPlacement(page);
    check("with the setting on the card is still last", !!at?.isLast, JSON.stringify(at));
    check("it leads with the summary", !!at?.text.includes("The CSV export is live"), at?.text);
    check("it names the summarizer", !!at?.text.includes("Summarized by Sonnet 5"));
    const fullVisibleBefore = await page.locator(".final-report-full .body").isVisible();
    await page.click(".final-report-full summary");
    const fullVisibleAfter = await page.locator(".final-report-full .body").isVisible();
    check("the implementor's full report is collapsed, then one click away", !fullVisibleBefore && fullVisibleAfter);
    check("...and it is the real report", ((await page.locator(".final-report-full .body").textContent()) ?? "").includes("abc1234"));
    await page.screenshot({ path: path.join(shotDir(dataDir), "final-report-summary.png") });

    // ---- the implementor role filter keeps the card; the QA filter hides it ----
    await page.click('.feed-filter .fchip:has-text("qa")');
    check("the QA filter hides the implementor's card", (await page.locator(".fi.final-report").count()) === 0);
    await page.click('.feed-filter .fchip:has-text("all")');
    check("the all filter brings it back", (await page.locator(".fi.final-report").count()) === 1);

    check("no console errors", errors.length === 0, errors.join(" | "));
    console.log(`\nscreenshots: ${shotDir(dataDir)}`);
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
