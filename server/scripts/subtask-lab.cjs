// Lab for SUB-TASKS in the console (`npm run subtask-lab`).
//
// `test:subtasks` proves the server half with a stubbed agent. What it cannot see is the console: that a
// sub-task never gets a board card of its own, that the parent card and panel say it exists, that it opens
// like any task (feed + composer) with a way back, and that a Jev sub-task answers a question typed into
// that composer. The last check calls the REAL TypeSafe API (fractions of a cent) with the key from
// server/.env, because a question that round-trips through the browser is the feature.
//
// Boots its own throwaway instance. Not in GATES: it needs a browser, an instance and a Jev key.
// Uncommitted work: `npx tsc -p tsconfig.json --outDir .subtask-lab-dist` + `npm run build:lab --prefix
// ../web`, then GGO_LAB_ENTRY=.subtask-lab-dist/index.js GGO_LAB_WEB_DIST=.lab-web-dist.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { loadChromium, authPassword, requireBuild, boot, killInstance, createChecks, shotDir } = require("./lab-harness.cjs");

const PORT = 4393;
const check = createChecks();
const PARENT = "aaaaaaaa-2222-4222-8222-aaaaaaaaaaaa";
const CODING = "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb";
const JEV = "cccccccc-2222-4222-8222-cccccccccccc";

function seed(dataDir) {
  const Database = require(path.join(__dirname, "..", "node_modules", "better-sqlite3"));
  const db = new Database(path.join(dataDir, "orchestrator.sqlite"));
  const now = Date.now();
  const insThread = db.prepare(
    "INSERT INTO threads (id, title, raw_prompt, brief, workspace, state, created_at, updated_at, parent_id, sub_task, stage_outputs) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
  );
  const insRun = db.prepare(
    "INSERT INTO agent_runs (id, thread_id, role, model, account, effort, state, started_at, ended_at, cost_usd) VALUES (?,?,?,?,?,?,?,?,?,?)",
  );
  const insMsg = db.prepare("INSERT INTO messages (id, thread_id, run_id, role, kind, content, created_at) VALUES (?,?,?,?,?,?,?)");
  const spec = (provider, model) =>
    JSON.stringify({ provider, model, effort: provider === "jev" ? null : "high", spawnedByRole: "implementor", spawnedByName: "Nim", spawnedByRunId: "run-parent" });
  const jevStage = JSON.stringify({
    jevState: { log: "142 passed, 0 failed, 3 skipped" },
    jevQuestions: { green: { type: "noul", instructions: "Did every test pass?" } },
    jevEvaluations: [
      {
        at: now - 60_000,
        model: "jev-1.13.0",
        questions: { green: { type: "noul", instructions: "Did every test pass?" } },
        answers: { green: { type: "noul", noul: 0.97 } },
        inputTokens: 290,
        costUsd: 0.0000122,
        askedBy: "agent",
      },
    ],
    subTaskReported: true,
  });
  insThread.run(PARENT, "PARENT TASK", "p", "the owner's brief", process.cwd(), "implementing", now - 900_000, now, null, null, null);
  insThread.run(CODING, "Port the parser tests", "", "port them", process.cwd(), "implementing", now - 600_000, now, PARENT, spec("codex", "gpt-6-sol"), null);
  insThread.run(JEV, "Tests green?", "", "Jev judgement sub-task.", process.cwd(), "done", now - 120_000, now, PARENT, spec("jev", "jev-latest"), jevStage);
  insRun.run("run-parent", PARENT, "implementor", "claude-opus-5-5", "personal", "high", "running", now - 890_000, null, null);
  insRun.run("run-coding", CODING, "implementor", "gpt-6-sol", "codex:gpt-6-sol", "high", "running", now - 590_000, null, null);
  insRun.run("run-jev", JEV, "implementor", "jev-latest", "jev", null, "done", now - 61_000, now - 60_000, 0.0000122);
  insMsg.run("msg-parent", PARENT, "run-parent", "implementor", "text", "PARENT LINE: splitting the test port off.", now - 800_000);
  insMsg.run("msg-coding", CODING, "run-coding", "implementor", "text", "SUBTASK LINE: porting parser tests now.", now - 500_000);
  insMsg.run("msg-jev", JEV, "run-jev", "implementor", "text", "**Jev answered** (jev-1.13.0 · 290 input tokens · $0.00001)\n\n- **green** (yes/no): **97% yes**", now - 60_000);
  db.close();
}

const detailText = (page) => page.evaluate(() => document.querySelector(".detail")?.textContent ?? "");

(async () => {
  requireBuild();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "subtask-lab-"));
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
    await page.waitForSelector(".accounts .acct", { timeout: 30000 }); // hello landed

    // ---- the board: sub-tasks live inside their parent ----
    check("a sub-task has no board card of its own", (await page.locator(`.card:has-text("Port the parser tests")`).count()) === 0);
    const badge = await page.locator(`.card:has-text("PARENT TASK") .subtask-badge`).textContent().catch(() => null);
    check("the parent card counts its sub-tasks", (badge ?? "").includes("2"), String(badge));

    // ---- the parent panel: a sub-task strip, and no interleaved sub-agent chatter ----
    await page.click(`.card:has-text("PARENT TASK")`, { timeout: 30000 });
    await page.waitForSelector(".detail-head", { timeout: 15000 });
    await page.waitForSelector(".subtask-chip", { timeout: 15000 }).catch(() => {});
    const chips = await page.$$eval(".subtask-chip", (els) => els.map((e) => e.textContent ?? ""));
    check("the parent panel lists both sub-tasks with their backend", chips.length === 2 && chips.some((c) => c.includes("Codex") && c.includes("Port the parser tests")) && chips.some((c) => c.includes("Jev")), JSON.stringify(chips));
    await page.waitForFunction(() => document.body.innerText.includes("PARENT LINE"), undefined, { timeout: 15000 }).catch(() => {});
    check("the sub-agent's own messages are not interleaved into the parent's feed", !(await detailText(page)).includes("SUBTASK LINE"));
    await page.screenshot({ path: path.join(shotDir(dataDir), "subtask-parent.png") });

    // ---- a coding sub-task opens like any task, and leads back ----
    await page.click(`.subtask-chip:has-text("Port the parser tests")`);
    try {
      await page.waitForFunction(() => document.body.innerText.includes("SUBTASK LINE"), undefined, { timeout: 20000 });
    } catch {
      /* reported below */
    }
    const codingText = await detailText(page);
    check("opening the chip shows the sub-agent's own feed", codingText.includes("SUBTASK LINE"));
    check("it says whose sub-task it is and what it runs on", /sub-task of/i.test(codingText) && codingText.includes("Codex · gpt-6-sol · high") && codingText.includes("spawned by Nim"), codingText.slice(0, 400));
    check("it has a composer to message the sub-agent directly", (await page.locator(".detail textarea").count()) > 0);
    check("a coding sub-task keeps its model picker", (await page.locator(".detail .task-model-picker").count()) === 1);
    await page.screenshot({ path: path.join(shotDir(dataDir), "subtask-coding.png") });
    await page.click(`.taskmode-link:has-text("PARENT TASK")`);
    await page.waitForFunction(() => document.body.innerText.includes("PARENT LINE"), undefined, { timeout: 15000 }).catch(() => {});
    check("the parent link leads back", (await detailText(page)).includes("PARENT LINE"));

    // ---- a Jev sub-task: answers shown, and a typed question round-trips through the real API ----
    await page.click(`.subtask-chip:has-text("Tests green?")`);
    await page.waitForFunction(() => document.body.innerText.includes("97% yes"), undefined, { timeout: 20000 }).catch(() => {});
    check("the Jev sub-task shows its answers", (await detailText(page)).includes("97% yes"));
    const placeholder = await page.locator(".detail textarea").getAttribute("placeholder").catch(() => null);
    check("its composer asks for a question, not an instruction", (placeholder ?? "").includes("Ask Jev"), String(placeholder));
    check("it offers no implementor model picker", (await page.locator(".detail .task-model-picker").count()) === 0);
    await page.fill(".detail textarea", "Were any tests skipped?");
    await page.click(`.detail button.btn.primary:has-text("Inject")`);
    try {
      await page.waitForFunction(
        () => [...document.querySelectorAll(".fi.text .body")].filter((b) => b.textContent?.includes("Jev answered")).length >= 2,
        undefined,
        { timeout: 45000 },
      );
      check("the question is answered by Jev in the feed", true);
    } catch {
      check("the question is answered by Jev in the feed", false, (await detailText(page)).slice(-600));
    }
    await page.screenshot({ path: path.join(shotDir(dataDir), "subtask-jev.png") });

    // ---- Settings: the Jev card reports the key ----
    await page.click('[aria-label="Open settings"]');
    await page.waitForSelector('[role="dialog"][aria-label="Settings"]', { timeout: 15000 });
    await page.click('[data-settings-category="subscriptions"]');
    await page.waitForSelector('.sub-card:has-text("TypeSafe AI")', { timeout: 15000 }).catch(() => {});
    const jevCard = await page.locator('.sub-card:has-text("TypeSafe AI")').textContent().catch(() => "");
    check("Settings shows the Jev card with its key stored", (jevCard ?? "").includes("sub-agent ready") && (jevCard ?? "").includes("Key stored"), jevCard ?? "");
    await page.locator('.sub-card:has-text("TypeSafe AI")').screenshot({ path: path.join(shotDir(dataDir), "subtask-settings.png") }).catch(() => {});

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
