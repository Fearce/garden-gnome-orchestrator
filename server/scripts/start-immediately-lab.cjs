#!/usr/bin/env node
// Queued task control: real browser, protocol, manager, SQLite and slot bookkeeping.
// Only the pipeline spawn is stubbed, so this lab cannot launch a paid agent.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const Database = require("better-sqlite3");
const { SERVER_ROOT, loadChromium, authPassword, boot, killInstance, createChecks } = require("./lab-harness.cjs");

const PORT = 4413;
const BASE = `http://127.0.0.1:${PORT}`;
const check = createChecks();
const ids = ["11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222", "33333333-3333-4333-8333-333333333333"];

async function openTask(page, title) {
  await page.locator(".card").filter({ hasText: title }).click({ position: { x: 14, y: 10 } });
  await page.waitForFunction((title) => document.querySelector(".detail-head")?.textContent.includes(title), title);
  const expand = page.getByRole("button", { name: "Expand header", exact: true });
  if (await expand.count()) await expand.click();
}

async function main() {
  const buildDir = path.join(SERVER_ROOT, ".start-immediately-lab-dist");
  execFileSync(process.execPath, [require.resolve("typescript/bin/tsc"), "-p", "tsconfig.json", "--outDir", buildDir], { cwd: SERVER_ROOT, stdio: "inherit", windowsHide: true });
  const entry = path.join(buildDir, "lab-entry.mjs");
  fs.writeFileSync(entry, `import { ThreadManager } from './orchestrator/threadManager.js';
ThreadManager.prototype.startPipeline = function(id) {
  this.reservePipelineSlot(id);
  this.setState(id, 'implementing');
};
await import('./index.js');
`);
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "start-immediately-"));
  let browser;
  let db;
  let child;
  try {
    child = await boot({ dataDir, port: PORT, entry, env: { CODEX_WAKE: "off" } });
    db = new Database(path.join(dataDir, "orchestrator.sqlite"));
    const insert = db.prepare("INSERT INTO threads(id,title,state,workspace,raw_prompt,brief,created_at,updated_at) VALUES(?,?,'queued',?,'lab','lab',?,?)");
    for (const [i, title] of ["Capacity holder", "Older queued task", "Chosen queued task"].entries()) {
      insert.run(ids[i], title, dataDir, Date.now() + i, Date.now() + i);
    }
    const kv = db.prepare("INSERT INTO kv(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value");
    kv.run("setting_max_concurrent", "1");
    kv.run("setting_max_concurrent_per_repo", "1");
    browser = await loadChromium().launch();
    const context = await browser.newContext({ viewport: { width: 1440, height: 950 } });
    const page = await context.newPage();
    await page.request.post(`${BASE}/api/login`, { data: { password: authPassword() } });
    await page.goto(BASE);
    await page.waitForSelector(".accounts .acct", { state: "attached", timeout: 45000 });
    await openTask(page, "Capacity holder");
    await page.getByRole("button", { name: "Start immediately", exact: true }).click();
    await page.waitForFunction(() => /implementing/i.test(document.querySelector(".detail-head .badge")?.textContent ?? ""));
    await openTask(page, "Chosen queued task");
    const button = page.getByRole("button", { name: "Start immediately", exact: true });
    check("queued task exposes an enabled immediate-start button", await button.isVisible() && await button.isEnabled());
    await button.click();
    await page.waitForFunction(() => /implementing/i.test(document.querySelector(".detail-head .badge")?.textContent ?? ""));
    const state = (id) => db.prepare("SELECT state FROM threads WHERE id=?").get(id).state;
    check("click starts chosen task despite both limits", state(ids[0]) === "implementing" && state(ids[2]) === "implementing");
    check("older task remains queued", state(ids[1]) === "queued");
    check("limits remain at one", ["setting_max_concurrent", "setting_max_concurrent_per_repo"].every((key) => db.prepare("SELECT value FROM kv WHERE key=?").get(key).value === "1"));
    check("running task hides the action", await button.count() === 0);
    await page.reload();
    await page.waitForSelector(".accounts .acct", { state: "attached" });
    await openTask(page, "Chosen queued task");
    check("started state survives reload", /implementing/i.test(await page.locator(".detail-head .badge").textContent()));
    check("reload does not restore the queued-only action", await button.count() === 0);
    await context.close();

    const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    const mobile = await phone.newPage();
    await mobile.request.post(`${BASE}/api/login`, { data: { password: authPassword() } });
    await mobile.goto(BASE);
    await mobile.waitForSelector(".accounts .acct", { state: "attached" });
    await openTask(mobile, "Older queued task");
    const mobileButton = mobile.getByRole("button", { name: "Start immediately", exact: true });
    await mobileButton.scrollIntoViewIfNeeded();
    const bounds = await mobileButton.boundingBox();
    check("phone button fits the viewport", !!bounds && bounds.x >= 0 && bounds.x + bounds.width <= 390 && bounds.y >= 0 && bounds.y + bounds.height <= 844);
    await mobileButton.tap();
    await mobile.waitForFunction(() => /implementing/i.test(document.querySelector(".detail-head .badge")?.textContent ?? ""));
    check("phone tap starts the remaining queued task", state(ids[1]) === "implementing");
    await phone.close();
    return check.summary();
  } finally {
    if (browser) await browser.close();
    if (db) db.close();
    if (child) child.kill();
    killInstance(PORT);
  }
}

main().then((code) => process.exit(code)).catch((error) => { console.error(error); process.exit(2); });
