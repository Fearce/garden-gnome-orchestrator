// Lab for the ⛏ tools toggle in the task feed (`npm run tools-filter-lab`).
//
// The SSR gate (`test:tools-filter-narration`) proves which rows the panel renders with tools hidden.
// This drives the part it cannot: a real click on the toggle, the preference surviving a reload, and the
// narration still on screen once the history reply rebuilds the feed from the database. Reported: with
// tools off, an implementor's narration ("…I'll verify which host is currently serving gnomerang.com")
// vanished together with the tool calls.
//
// Boots its own throwaway instance. Not in GATES: it needs a browser + an instance, like the other labs.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { loadChromium, authPassword, requireBuild, boot, killInstance, createChecks, shotDir } = require("./lab-harness.cjs");

const PORT = 4403;
const check = createChecks();
const TASK = "dddddddd-1111-4111-8111-dddddddddddd";
const IMPL_RUN = "dddddddd-2222-4222-8222-000000000001";
const QA_RUN = "dddddddd-2222-4222-8222-000000000002";
const NARRATION = "NARRATION: I found two manual deploy scripts. Before writing the workflow, I'll verify which host is currently serving gnomerang.com.";

function seed(dataDir) {
  const Database = require(path.join(__dirname, "..", "node_modules", "better-sqlite3"));
  const db = new Database(path.join(dataDir, "orchestrator.sqlite"));
  const now = Date.now();
  db.prepare("INSERT INTO threads (id, title, raw_prompt, brief, workspace, state, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)").run(
    TASK, "TOOLS FILTER TASK", "p", "b", process.cwd(), "qa", now - 900_000, now,
  );
  const insRun = db.prepare("INSERT INTO agent_runs (id, thread_id, role, model, account, effort, state, started_at, ended_at) VALUES (?,?,?,?,?,?,?,?,?)");
  insRun.run(IMPL_RUN, TASK, "implementor", "claude-opus-5-5", "personal", "high", "done", now - 900_000, now - 300_000);
  insRun.run(QA_RUN, TASK, "qa", "claude-opus-5-5", "personal", "high", "done", now - 250_000, now - 100_000);
  const insMsg = db.prepare("INSERT INTO messages (id, thread_id, run_id, role, kind, content, created_at) VALUES (?,?,?,?,?,?,?)");
  insMsg.run("m-think", TASK, IMPL_RUN, "implementor", "thinking", NARRATION, now - 850_000);
  insMsg.run("m-tool", TASK, IMPL_RUN, "implementor", "tool", 'TOOLCALL_Bash {"command":"dig gnomerang.com"}', now - 840_000);
  insMsg.run("m-result", TASK, IMPL_RUN, "implementor", "result", "TOOLRESULT_46.225.138.103", now - 839_000);
  insMsg.run("m-text", TASK, IMPL_RUN, "implementor", "text", "PROSE: the workflow deploys over SSH.", now - 400_000);
  insMsg.run("m-qa-think", TASK, QA_RUN, "qa", "thinking", "QA NARRATION: re-running the deploy check.", now - 200_000);
  db.close();
}

/** What the feed shows: which seeded rows are rendered AND inside the visible panel, not merely in the DOM. */
async function feedState(page) {
  return page.evaluate(() => {
    const feed = document.querySelector(".feed");
    const box = feed?.getBoundingClientRect();
    const shown = (needle) => {
      const row = [...document.querySelectorAll(".feed .fi")].find((r) => r.textContent?.includes(needle));
      if (!row || !box) return false;
      row.scrollIntoView({ block: "center" });
      const r = row.getBoundingClientRect();
      return r.height > 0 && r.bottom > box.top && r.top < box.bottom;
    };
    const toggle = document.querySelector(".tools-toggle");
    return {
      toolsOn: !!toggle && !toggle.classList.contains("off"),
      toggleTitle: toggle?.getAttribute("title") ?? null,
      narration: shown("NARRATION: I found two manual deploy scripts"),
      qaNarration: shown("QA NARRATION"),
      prose: shown("PROSE:"),
      tool: shown("TOOLCALL_Bash"),
      result: shown("TOOLRESULT_"),
    };
  });
}

async function openTask(page) {
  await page.click(`.card:has-text("TOOLS FILTER TASK")`, { timeout: 30000 });
  await page.waitForSelector(".detail-head", { timeout: 15000 });
  await page.waitForFunction(() => document.querySelector(".feed")?.textContent?.includes("PROSE:"), undefined, { timeout: 20000 });
}

(async () => {
  requireBuild();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "tools-filter-"));
  killInstance(PORT);
  const child = await boot({ dataDir, port: PORT, env: { ORCH_LAB_FIXTURES: "1" } });
  let code = 1;
  let browser;
  try {
    seed(dataDir);
    const chromium = loadChromium();
    browser = await chromium.launch();
    const ctx = await browser.newContext({ viewport: { width: 1500, height: 950 } });
    const page = await ctx.newPage();
    await page.request.post(`http://127.0.0.1:${PORT}/api/login`, { data: { password: authPassword() } });
    await page.goto(`http://127.0.0.1:${PORT}/`, { timeout: 45000 });
    await page.waitForSelector(".accounts .acct", { state: "attached", timeout: 30000 });
    await openTask(page);

    const on = await feedState(page);
    check("tools on: tool calls and results show", on.toolsOn && on.tool && on.result, JSON.stringify(on));
    check("tools on: narration shows", on.narration && on.qaNarration && on.prose, JSON.stringify(on));

    await page.click(".tools-toggle");
    const off = await feedState(page);
    check("tools off: the toggle reads off", !off.toolsOn, JSON.stringify(off));
    check("tools off: tool calls and results are hidden", !off.tool && !off.result, JSON.stringify(off));
    check("tools off: the implementor's narration stays visible", off.narration, JSON.stringify(off));
    check("tools off: QA's narration and the prose stay visible", off.qaNarration && off.prose, JSON.stringify(off));
    check("the toggle says what it hides", /tool calls/.test(off.toggleTitle ?? "") && !/reasoning —/.test(off.toggleTitle ?? ""), off.toggleTitle);
    await page.screenshot({ path: path.join(shotDir(dataDir), "tools-filter-off.png"), fullPage: false });

    // A reload rebuilds the feed from thread.history alone, with the preference read back from storage.
    await page.reload({ timeout: 45000 });
    await page.waitForSelector(".accounts .acct", { state: "attached", timeout: 30000 });
    await openTask(page);
    const reloaded = await feedState(page);
    check("after a reload the toggle is still off", !reloaded.toolsOn, JSON.stringify(reloaded));
    check("after a reload the narration is still visible and tools still hidden", reloaded.narration && reloaded.qaNarration && !reloaded.tool && !reloaded.result, JSON.stringify(reloaded));

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
