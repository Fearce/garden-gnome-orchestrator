// Lab for scheduled reminders (`npm run schedule-reminder-lab`).
//
// `test:scheduler` proves the scheduler sends a reminder and falls back to the note list; this drives the
// part it cannot: the editor accepting a reminder with no prompt and no repo, the card showing the
// reminder line instead of a repo/prompt, the row the server actually stored, and a real "Run now"
// reaching the fallback through the live wiring in index.ts. The lab instance has no Discord bot token,
// so the DM is refused and the reminder has to land on the owner's note list.
//
// Boots its own throwaway instance. Not in GATES: it needs a browser + an instance, like the other labs.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Database = require("better-sqlite3");
const { loadChromium, authPassword, requireBuild, boot, killInstance, createChecks, shotDir } = require("./lab-harness.cjs");

const PORT = 4407;
const check = createChecks();
const TITLE = "Domain renewal";
const TEXT = "The example.com domain expires on 22 October. Renew it before then.";

function readDb(dataDir, sql, ...args) {
  const db = new Database(path.join(dataDir, "orchestrator.sqlite"), { readonly: true });
  try {
    return db.prepare(sql).all(...args);
  } finally {
    db.close();
  }
}

async function poll(fn, timeoutMs = 15000) {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const value = fn();
    if (value || Date.now() > until) return value;
    await new Promise((r) => setTimeout(r, 250));
  }
}

async function createReminder(page) {
  await page.click('button:has-text("New schedule")');
  await page.waitForSelector(".sched-modal", { timeout: 10000 });
  await page.fill('.sched-modal input[placeholder^="e.g. Nightly"]', TITLE);
  // A prompt with no repo cannot be saved; the same form with only a reminder can.
  await page.fill(".sched-modal .sched-prompt-input", "audit something");
  const promptNoRepo = await page.isDisabled('.sched-modal button:has-text("Create schedule")');
  check("a prompt without a repo cannot be saved", promptNoRepo);
  await page.fill(".sched-modal .sched-prompt-input", "");
  const empty = await page.isDisabled('.sched-modal button:has-text("Create schedule")');
  check("a schedule with neither prompt nor reminder cannot be saved", empty);
  await page.fill(".sched-modal .sched-reminder-input", TEXT);
  await page.selectOption(".sched-modal .sched-freq", "custom");
  await page.fill(".sched-modal .sched-rawcron", "0 9 15 10 *");
  await page.check('.sched-modal label:has-text("Run once") input');
  const enabled = await page.isEnabled('.sched-modal button:has-text("Create schedule")');
  check("a reminder with no prompt and no repo can be saved", enabled);
  await page.screenshot({ path: path.join(shotDir(page.__dataDir), "schedule-reminder-editor.png") });
  await page.click('.sched-modal button:has-text("Create schedule")');
  await page.waitForSelector(".sched-modal", { state: "detached", timeout: 10000 });
}

(async () => {
  requireBuild();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "schedule-reminder-"));
  killInstance(PORT);
  const child = await boot({ dataDir, port: PORT });
  let code = 1;
  let browser;
  try {
    const chromium = loadChromium();
    browser = await chromium.launch();
    const ctx = await browser.newContext({ viewport: { width: 1500, height: 950 } });
    const page = await ctx.newPage();
    page.__dataDir = dataDir;
    await page.request.post(`http://127.0.0.1:${PORT}/api/login`, { data: { password: authPassword() } });
    await page.goto(`http://127.0.0.1:${PORT}/`, { timeout: 45000 });
    await page.waitForSelector(".accounts .acct", { state: "attached", timeout: 30000 });
    await page.click('button[title="View and manage scheduled tasks"]');
    await page.waitForSelector(".sched-view", { timeout: 15000 });

    await createReminder(page);

    const card = page.locator(`.sched-card:has-text("${TITLE}")`);
    await card.waitFor({ timeout: 15000 });
    const shape = await card.evaluate((el) => ({
      reminder: el.querySelector(".sched-reminder")?.textContent ?? null,
      bell: !!el.querySelector(".sched-reminder svg"),
      prompt: !!el.querySelector(".sched-prompt"),
      repo: !!el.querySelector(".ws-path, .workspace-path, [class*='wspath']"),
      runNowTitle: [...el.querySelectorAll("button")].find((b) => b.textContent?.trim() === "Run now")?.getAttribute("title") ?? null,
      once: el.textContent?.includes("once") ?? false,
    }));
    check("the card shows the reminder text with a bell", shape.reminder === TEXT && shape.bell, JSON.stringify(shape));
    check("the card shows no empty prompt or repo", !shape.prompt && !shape.repo, JSON.stringify(shape));
    check("Run now says it sends the reminder", /Discord/.test(shape.runNowTitle ?? ""), shape.runNowTitle);
    check("the run-once badge shows", shape.once);

    const rows = await poll(() => {
      const r = readDb(dataDir, "SELECT * FROM scheduled_tasks WHERE title = ?", TITLE);
      return r.length ? r : null;
    });
    const row = rows?.[0];
    check("the server stored the reminder text", row?.reminder === TEXT, JSON.stringify(row));
    check("…with no prompt and no repo", row?.prompt === "" && row?.workspace === "", JSON.stringify(row));
    check("…as a run-once, armed for its date", row?.run_once === 1 && row?.enabled === 1 && row?.next_run_at > Date.now(), JSON.stringify(row));

    // This instance has no Discord bot token, so the DM is refused and the reminder must reach the note list.
    await card.locator('button:text-is("Run now")').click();
    const notes = await poll(() => {
      const n = readDb(dataDir, "SELECT body, thread_title FROM operator_notes");
      return n.length ? n : null;
    });
    check("a refused DM puts the reminder on the note list", !!notes?.some((n) => n.body.includes(TEXT)), JSON.stringify(notes));
    check("…saying why it was not delivered on Discord", !!notes?.some((n) => /Discord/.test(n.thread_title ?? "")), JSON.stringify(notes));
    const after = readDb(dataDir, "SELECT * FROM scheduled_tasks WHERE title = ?", TITLE)[0];
    check("Run now records the fire and keeps the run-once armed", after?.last_run_at > 0 && after?.enabled === 1, JSON.stringify(after));
    const threads = readDb(dataDir, "SELECT COUNT(*) AS n FROM threads")[0];
    check("a reminder-only fire starts no task", threads?.n === 0, JSON.stringify(threads));
    await page.screenshot({ path: path.join(shotDir(dataDir), "schedule-reminder-card.png") });

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
