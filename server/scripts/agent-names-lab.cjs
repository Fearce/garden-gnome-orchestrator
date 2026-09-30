// Lab for "no agent runs nameless" (`npm run agent-names-lab`). A gate proves the server names every
// agent at creation; only a render proves the task header actually SHOWS it — "QA (Name, model)" rather
// than a bare "QA (model)". Boots a throwaway instance twice: the first boot seeds a task whose QA ran
// before names were generated at creation (re-arming the one-time backfill), the second boot must backfill
// it. Then a FRESH QA run is started through the server's real createRun → wireRun path (the lab QA
// fixture) and both tasks' QA headers are read in a real browser. Not in GATES: it needs a browser + an
// instance, like the other labs. To test uncommitted server work, see the GGO_LAB_ENTRY note in
// lab-harness.cjs.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { loadChromium, authPassword, requireBuild, boot, killInstance, createChecks, shotDir } = require("./lab-harness.cjs");

const PORT = 4433;
const FRESH = "a1a1a1a1-1111-4111-8111-111111111111";
const LEGACY = "b2b2b2b2-2222-4222-8222-222222222222";
const LEGACY_RUN = "b2b2b2b2-0000-4000-8000-000000000000";
const check = createChecks();
const GENERATED = /^[A-Z][a-z]+ [A-Z][a-z]+$/;

function openDb(dataDir) {
  const Database = require(path.join(__dirname, "..", "node_modules", "better-sqlite3"));
  return new Database(path.join(dataDir, "orchestrator.sqlite"));
}

/** The pre-fix world: a finished task whose QA run has no name on record, and the backfill not yet run. */
function seedLegacy(dataDir) {
  const db = openDb(dataDir);
  const now = Date.now();
  insertThread(db, LEGACY, "LEGACY QA TASK", "done", now - 60_000);
  db.prepare("INSERT INTO agent_runs (id, thread_id, role, model, state, started_at, ended_at) VALUES (?,?,?,?,?,?,?)").run(
    LEGACY_RUN, LEGACY, "qa", "claude-opus-5-5", "done", now - 50_000, now - 40_000,
  );
  addQaMessage(db, LEGACY, LEGACY_RUN, "Legacy QA verdict: looks good.", now - 45_000);
  const names = JSON.parse(db.prepare("SELECT value FROM kv WHERE key = 'office_names'").get()?.value ?? "{}");
  delete names[`${LEGACY}::qa`];
  db.prepare("INSERT OR REPLACE INTO kv (key, value) VALUES ('office_names', ?)").run(JSON.stringify(names));
  db.prepare("DELETE FROM kv WHERE key = 'office_names_backfill_v1'").run();
  db.close();
}

function insertThread(db, id, title, state, at) {
  db.prepare("INSERT INTO threads (id, title, raw_prompt, brief, workspace, state, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)").run(
    id, title, "p", "b", process.cwd(), state, at, at,
  );
}

/** Seeded AFTER boot: a task left in `qa` across a boot is reconciled to failed, as a real one would be. */
function seedFresh(dataDir) {
  const db = openDb(dataDir);
  insertThread(db, FRESH, "FRESH QA TASK", "qa", Date.now());
  db.close();
}

function addQaMessage(db, threadId, runId, text, at) {
  db.prepare("INSERT INTO messages (id, thread_id, run_id, role, kind, content, created_at, attachments) VALUES (?,?,?,?,?,?,?,?)").run(
    `${runId}-msg`, threadId, runId, "qa", "text", text, at, "[]",
  );
}

/** The fresh fixture run's id, then a line of QA output under it so the feed renders its header. */
function tagFreshRun(dataDir) {
  const db = openDb(dataDir);
  const run = db.prepare("SELECT id FROM agent_runs WHERE thread_id = ? AND role = 'qa' ORDER BY started_at DESC LIMIT 1").get(FRESH);
  if (run) addQaMessage(db, FRESH, run.id, "Fresh QA: reviewing the diff now.", Date.now());
  const names = JSON.parse(db.prepare("SELECT value FROM kv WHERE key = 'office_names'").get()?.value ?? "{}");
  db.close();
  return { runId: run?.id ?? null, names };
}

async function qaHeaderName(page, title) {
  await page.click(`.card:has-text("${title}"), .closed-card:has-text("${title}")`);
  await page.waitForFunction((t) => document.querySelector(".detail-head")?.textContent?.includes(t), title, { timeout: 20000 });
  await page.waitForFunction(() => [...document.querySelectorAll(".fi .role-tag")].some((n) => /qa/i.test(n.querySelector(".role-word")?.textContent ?? "")), null, { timeout: 20000 });
  return page.evaluate(() => {
    const tag = [...document.querySelectorAll(".fi .role-tag")].find((n) => /qa/i.test(n.querySelector(".role-word")?.textContent ?? ""));
    const label = tag?.querySelector(".role-name");
    if (!label) return { text: tag?.textContent ?? null, name: null };
    const model = label.querySelector(".role-model")?.textContent ?? "";
    const name = (label.textContent ?? "").replace(/^\(|\)$/g, "").replace(model, "").replace(/,\s*$/, "").trim();
    return { text: tag.textContent, name };
  });
}

(async () => {
  requireBuild();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-names-lab-"));
  killInstance(PORT);
  let child = await boot({ dataDir, port: PORT, env: { ORCH_LAB_FIXTURES: "1" } });
  let code = 1;
  try {
    child.kill();
    killInstance(PORT);
    seedLegacy(dataDir);
    child = await boot({ dataDir, port: PORT, env: { ORCH_LAB_FIXTURES: "1" } });
    seedFresh(dataDir);

    const chromium = loadChromium();
    const browser = await chromium.launch();
    const page = await (await browser.newContext({ viewport: { width: 1500, height: 950 } })).newPage();
    await page.request.post(`http://127.0.0.1:${PORT}/api/login`, { data: { password: authPassword() } });
    const started = await page.request.post(`http://127.0.0.1:${PORT}/api/lab/live-qa/${FRESH}`);
    check("a fresh QA run starts through the real createRun → wireRun path", started.ok(), await started.text().catch(() => ""));
    const { runId, names } = tagFreshRun(dataDir);
    check("the fresh QA run has a name on record the moment it exists", !!runId && GENERATED.test(names[`${FRESH}::qa`] ?? ""), JSON.stringify(names));
    check("the legacy QA was backfilled at boot", GENERATED.test(names[`${LEGACY}::qa`] ?? ""), JSON.stringify(names));

    await page.goto(`http://127.0.0.1:${PORT}/`, { timeout: 45000 });
    await page.waitForSelector(".accounts .acct", { state: "attached", timeout: 30000 });

    const fresh = await qaHeaderName(page, "FRESH QA TASK");
    check("the fresh QA header shows its name", fresh.name === names[`${FRESH}::qa`], JSON.stringify(fresh));
    await page.screenshot({ path: path.join(shotDir(dataDir), "fresh-qa-name.png") });
    const legacy = await qaHeaderName(page, "LEGACY QA TASK");
    check("the legacy QA header shows its backfilled name", legacy.name === names[`${LEGACY}::qa`], JSON.stringify(legacy));
    await page.screenshot({ path: path.join(shotDir(dataDir), "legacy-qa-name.png") });
    console.log(`\nscreenshots: ${shotDir(dataDir)}`);
    await browser.close();
    code = check.summary();
  } finally {
    try {
      child.kill();
    } catch {
      /* already gone */
    }
    killInstance(PORT);
  }
  process.exit(code);
})().catch((e) => {
  console.error(e);
  killInstance(PORT);
  process.exit(1);
});
