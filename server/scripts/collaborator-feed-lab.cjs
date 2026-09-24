// Lab for a shotgun task's collaborators in the lead's panel (`npm run collaborator-feed-lab`).
//
// The SSR gate (`test:collaborator-feed`) hands the store both feeds by hand. The half it cannot see is
// the fetch: a collaborator has no board card and is never opened, so its history reaches the console
// only because the lead's panel asks for it. Seed a lead + collaborator with messages on disk, open the
// lead in a real browser, and read who each row is attributed to — then again after a reload.
//
// Boots its own throwaway instance. Not in GATES: it needs a browser + an instance, like the other labs.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { loadChromium, authPassword, requireBuild, boot, killInstance, createChecks, shotDir } = require("./lab-harness.cjs");

const PORT = 4389;
const check = createChecks();
const LEAD = "dddddddd-1111-4111-8111-dddddddddddd";
const KID = "eeeeeeee-1111-4111-8111-eeeeeeeeeeee";

function seed(dataDir) {
  const Database = require(path.join(__dirname, "..", "node_modules", "better-sqlite3"));
  const db = new Database(path.join(dataDir, "orchestrator.sqlite"));
  const now = Date.now();
  const insThread = db.prepare(
    "INSERT INTO threads (id, title, raw_prompt, brief, workspace, state, created_at, updated_at, agent_count, parent_id, assignment) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
  );
  const insRun = db.prepare(
    "INSERT INTO agent_runs (id, thread_id, role, model, account, effort, state, started_at, ended_at) VALUES (?,?,?,?,?,?,?,?,?)",
  );
  const insMsg = db.prepare("INSERT INTO messages (id, thread_id, run_id, role, kind, content, created_at) VALUES (?,?,?,?,?,?,?)");
  const assignment = JSON.stringify({ title: "Economy share", objective: "price potions", files: ["src/economy.cs"] });
  insThread.run(LEAD, "TWO AGENT TASK", "p", "the owner's brief", process.cwd(), "implementing", now - 900_000, now, 2, null, null);
  insThread.run(KID, "Economy share", "p", "COLLABORATOR ASSIGNMENT BRIEF", process.cwd(), "implementing", now - 899_000, now, null, LEAD, assignment);
  insRun.run("run-lead", LEAD, "implementor", "claude-opus-5-5", "personal", "high", "running", now - 890_000, null);
  insRun.run("run-kid", KID, "implementor", "gpt-6-sol", "codex:gpt-6-sol", "high", "running", now - 890_000, null);
  insMsg.run("msg-lead", LEAD, "run-lead", "implementor", "text", "LEAD LINE: working on quests.", now - 800_000);
  insMsg.run("msg-kid", KID, "run-kid", "implementor", "text", "COLLAB LINE: working on potion prices.", now - 700_000);
  db.close();
}

async function openLead(page) {
  await page.click(`.card:has-text("TWO AGENT TASK")`, { timeout: 30000 });
  await page.waitForSelector(".detail-head", { timeout: 15000 });
  try {
    await page.waitForFunction(
      () => [...document.querySelectorAll(".fi.text .body")].some((b) => b.textContent?.startsWith("COLLAB LINE")),
      undefined,
      { timeout: 20000 },
    );
  } catch {
    check("the collaborator's message loads into the lead's panel", false, "no COLLAB LINE row — the collaborator's history was never fetched");
  }
}

async function readPanel(page) {
  return page.evaluate(() => {
    const rows = {};
    for (const row of document.querySelectorAll(".fi.text")) {
      const text = row.querySelector(".body")?.textContent ?? "";
      const key = text.startsWith("LEAD LINE") ? "lead" : text.startsWith("COLLAB LINE") ? "collab" : null;
      if (key) rows[key] = row.querySelector(".role-name")?.textContent ?? null;
    }
    return {
      rows,
      order: [...document.querySelectorAll(".fi.text .body")].map((b) => b.textContent?.slice(0, 11)),
      assignmentShown: document.body.innerText.includes("COLLABORATOR ASSIGNMENT BRIEF"),
      strip: [...document.querySelectorAll(".taskmode-collab-title")].map((e) => e.textContent),
    };
  });
}

function assertPanel(panel, where) {
  const { rows } = panel;
  check(`the lead's row and the collaborator's row are both shown ${where}`, !!rows.lead && !!rows.collab, JSON.stringify(panel));
  check(`the two rows name different agents ${where}`, !!rows.lead && !!rows.collab && rows.lead !== rows.collab, JSON.stringify(rows));
  check(`the rows interleave by time ${where}`, panel.order.indexOf("LEAD LINE: ") < panel.order.indexOf("COLLAB LINE"), JSON.stringify(panel.order));
  check(`the collaborator's assignment does not pose as a director message ${where}`, !panel.assignmentShown);
  const collabName = (rows.collab ?? "").replace(/[()]/g, "").split(",")[0].trim();
  check(`the agents strip names the collaborator beside its share ${where}`, panel.strip.some((s) => s === `${collabName} · Economy share`), JSON.stringify(panel.strip));
}

(async () => {
  requireBuild();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "collaborator-feed-"));
  killInstance(PORT);
  // Boot FIRST: the server's own constructor is what creates the schema this seed writes into.
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

    check("the collaborator has no card of its own", (await page.locator(`.card:has-text("Economy share")`).count()) === 0);
    await openLead(page);
    assertPanel(await readPanel(page), "on open");

    await page.reload({ timeout: 45000 });
    await page.waitForSelector(".accounts .acct", { timeout: 30000 });
    await openLead(page);
    assertPanel(await readPanel(page), "after a reload");

    await page.screenshot({ path: path.join(shotDir(dataDir), "collaborator-feed.png"), fullPage: false });
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
