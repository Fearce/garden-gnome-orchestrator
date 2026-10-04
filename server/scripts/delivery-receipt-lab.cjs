// Lab for the delivery line under an owner's task instruction (`npm run delivery-receipt-lab`). What the
// store gate (`web/scripts/outbound-receipts.test.ts`) cannot show is the real round trip: the server's
// `thread.inject.accepted` frame ending "Sending…" while the final reply is still held back, a refused
// instruction offering Send again / Dismiss, a dead server reading "Waiting for connection", and a
// message typed while the server was down surviving a closed tab and landing exactly once.
// Boots its own throwaway instance; not in GATES (needs a browser and an instance, like the other labs).
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Database = require("better-sqlite3");
const { loadChromium, authPassword, requireBuild, requireFreshWebBuild, boot, killInstance, createChecks, shotDir } = require("./lab-harness.cjs");

const PORT = 4385;
const BASE = `http://127.0.0.1:${PORT}`;
const TASK = "61111111-1111-4111-8111-111111111111";
const DOOMED = "62222222-2222-4222-8222-222222222222";
/** How long the lab holds back each final `thread.action`, so the accepted state is on screen to read. */
const HOLD_MS = 4_000;
const check = createChecks();

function seed(dataDir) {
  const db = new Database(path.join(dataDir, "orchestrator.sqlite"));
  const now = Date.now();
  const ins = db.prepare("INSERT INTO threads (id, title, raw_prompt, brief, workspace, state, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)");
  // At the approval gate nothing runs, so an instruction is stored and held for the first kickoff
  // without starting an agent.
  ins.run(TASK, "RECEIPT TASK", "p", "b", process.cwd(), "awaiting_approval", now, now);
  ins.run(DOOMED, "DOOMED TASK", "p", "b", process.cwd(), "awaiting_approval", now - 1000, now - 1000);
  db.close();
}

function storedCopies(dataDir, text) {
  const db = new Database(path.join(dataDir, "orchestrator.sqlite"), { readonly: true });
  const notes = db.prepare("SELECT COUNT(*) AS n FROM messages WHERE content LIKE ?").get(`%${text}%`).n;
  db.close();
  return { notes };
}

function removeTask(dataDir, id) {
  const db = new Database(path.join(dataDir, "orchestrator.sqlite"));
  db.pragma("foreign_keys = ON");
  db.prepare("DELETE FROM threads WHERE id = ?").run(id);
  db.close();
}

async function openTask(page, title) {
  await page.locator(`.card:has-text("${title}")`).click({ position: { x: 14, y: 10 } });
  await page.waitForFunction((t) => document.querySelector(".detail-head")?.textContent?.includes(t), title, { timeout: 20000 });
}

async function inject(page, text) {
  await page.fill(".inject-bar textarea", text);
  await page.click('.inject-bar .row button:text-is("Inject")');
}

/** The feed rows mentioning `text`: optimistic copies and server echoes alike. */
async function rowsFor(page, text) {
  return page.evaluate((t) => [...document.querySelectorAll(".fi.system")].filter((n) => n.textContent?.includes(t)).map((n) => n.textContent ?? ""), text);
}

async function receiptFor(page, text) {
  return page.evaluate((t) => {
    const row = [...document.querySelectorAll(".fi.system")].find((n) => n.textContent?.includes(t) && n.querySelector(".delivery-receipt"));
    const receipt = row?.querySelector(".delivery-receipt");
    return receipt ? { cls: receipt.className, text: receipt.textContent ?? "" } : null;
  }, text);
}

/** Forward the socket both ways, recording frames, but hold each `thread.action` for HOLD_MS. */
async function holdFinalReplies(page, frames) {
  await page.routeWebSocket(/\/ws$/, (ws) => {
    const server = ws.connectToServer();
    ws.onMessage((message) => server.send(message));
    server.onMessage((message) => {
      let type = "";
      try {
        type = JSON.parse(String(message)).type ?? "";
      } catch {
        /* binary or non-JSON */
      }
      // Recorded as the page receives them, so a held reply appears in order only once released.
      const deliver = () => {
        if (type === "thread.inject.accepted" || type === "thread.action") frames.push({ at: Date.now(), frame: JSON.parse(String(message)) });
        ws.send(message);
      };
      if (type === "thread.action") setTimeout(deliver, HOLD_MS);
      else deliver();
    });
  });
}

(async () => {
  requireBuild();
  requireFreshWebBuild();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "delivery-receipt-"));
  const shots = shotDir(dataDir);
  killInstance(PORT);
  let child = await boot({ dataDir, port: PORT });
  let code = 1;
  try {
    seed(dataDir);
    const chromium = loadChromium();
    const browser = await chromium.launch();
    const ctx = await browser.newContext({ viewport: { width: 1500, height: 950 } });
    await ctx.request.post(`${BASE}/api/login`, { data: { password: authPassword() } });
    let page = await ctx.newPage();
    const frames = [];
    await holdFinalReplies(page, frames);
    await page.goto(`${BASE}/`, { timeout: 45000 });
    await page.waitForSelector(".accounts .acct", { state: "attached", timeout: 30000 });

    // 1 — accepted ends Sending… while the final reply is still on its way.
    await openTask(page, "RECEIPT TASK");
    const first = "epic fail, I cant delete events";
    await inject(page, first);
    await page.waitForTimeout(1200);
    const during = await receiptFor(page, first);
    const rowsDuring = await rowsFor(page, first);
    check("the server acknowledges the stored instruction first", frames[0]?.frame.type === "thread.inject.accepted", JSON.stringify(frames.map((f) => f.frame.type)));
    check("…while the final reply is still held back", frames.every((f) => f.frame.type !== "thread.action"), JSON.stringify(frames.map((f) => f.frame.type)));
    check("no Sending… spinner while GGO already holds it", !during || !/sending/.test(during.cls), JSON.stringify(during));
    check("the instruction is visible exactly once meanwhile", rowsDuring.length === 1, JSON.stringify(rowsDuring));
    await page.screenshot({ path: path.join(shots, "1-accepted.png") });
    await page.waitForFunction((t) => ![...document.querySelectorAll(".fi.system .delivery-receipt")].some((r) => r.closest(".fi")?.textContent?.includes(t)), first, { timeout: HOLD_MS + 15000 });
    const settled = await rowsFor(page, first);
    check("the final reply leaves one feed line and no receipt", settled.length === 1, JSON.stringify(settled));
    check("…and the server stored it once", storedCopies(dataDir, first).notes === 1, JSON.stringify(storedCopies(dataDir, first)));

    // 2 — a refused instruction is kept, explained, and recoverable.
    await openTask(page, "DOOMED TASK");
    removeTask(dataDir, DOOMED);
    const refused = "this task was removed under the console";
    await inject(page, refused);
    await page.waitForSelector(".delivery-receipt.failed", { timeout: HOLD_MS + 15000 });
    const failedText = (await page.textContent(".delivery-receipt.failed")) ?? "";
    check("a refusal reads Not delivered with its reason", /Not delivered/.test(failedText) && /No such task/.test(failedText), failedText);
    check("…and offers Send again and Dismiss", (await page.locator('.delivery-receipt.failed button:text-is("Send again")').count()) === 1 && (await page.locator('.delivery-receipt.failed button:text-is("Dismiss")').count()) === 1);
    await page.screenshot({ path: path.join(shots, "2-refused.png") });
    const before = frames.length;
    await page.click('.delivery-receipt.failed button:text-is("Send again")');
    await page.waitForTimeout(HOLD_MS + 1500);
    await page.waitForSelector(".delivery-receipt.failed", { timeout: 15000 });
    const resentIds = frames.slice(before).map((f) => f.frame.clientId);
    check("Send again went out under a new delivery id", resentIds.length > 0 && !frames.slice(0, before).some((f) => resentIds.includes(f.frame.clientId)), JSON.stringify(resentIds));
    await page.click('.delivery-receipt.failed button:text-is("Dismiss")');
    check("Dismiss removes it", (await page.locator(".delivery-receipt.failed").count()) === 0);

    // 3 — a dead server reads as such, and a message typed meanwhile survives a closed tab.
    await openTask(page, "RECEIPT TASK");
    child.kill();
    killInstance(PORT);
    await page.waitForFunction(() => /offline|reconnect/i.test(document.querySelector(".conn")?.textContent ?? ""), null, { timeout: 60000 }).catch(() => {});
    const offline = "typed while the server was down";
    await inject(page, offline);
    await page.waitForSelector(".delivery-receipt.offline", { timeout: 15000 });
    const waiting = (await page.textContent(".delivery-receipt.offline")) ?? "";
    check("a dead server reads Waiting for connection, not Sending…", /Waiting for connection/.test(waiting), waiting);
    await page.screenshot({ path: path.join(shots, "3-offline.png") });
    await page.close();

    child = await boot({ dataDir, port: PORT });
    page = await ctx.newPage();
    await page.goto(`${BASE}/`, { timeout: 45000 });
    await page.waitForSelector(".accounts .acct", { state: "attached", timeout: 30000 });
    await openTask(page, "RECEIPT TASK");
    await page.waitForFunction((t) => [...document.querySelectorAll(".fi.system")].some((n) => n.textContent?.includes(t) && !n.querySelector(".delivery-receipt")), offline, { timeout: 30000 });
    await page.waitForTimeout(1500);
    const recovered = await rowsFor(page, offline);
    check("after a reload the queued message was delivered", recovered.length === 1, JSON.stringify(recovered));
    check("…exactly once", storedCopies(dataDir, offline).notes === 1, JSON.stringify(storedCopies(dataDir, offline)));
    await page.screenshot({ path: path.join(shots, "4-recovered.png") });
    console.log(`\nscreenshots: ${shots}`);
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
  process.exit(2);
});
