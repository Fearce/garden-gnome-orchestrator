// Lab for the gnome read receipts on injected messages (`npm run receipts-lab`). Proves in a real
// browser what the unit gate (`test:injection-receipts`) cannot: that the hat under an injected row
// walks sent -> delivered -> read as the live QA fixture takes and ACKs the message, that the
// implementor's copy of the same message stays visibly "waiting" (QA consumed it, the implementor did
// not), that a queued message shows waiting, that every state has an accessible label naming the
// recipient and time, and that all of it survives a page reload.
// Boots its own throwaway instance. Not in GATES: it needs a browser + an instance, like the other labs.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { loadChromium, authPassword, requireBuild, boot, killInstance, createChecks, shotDir } = require("./lab-harness.cjs");

const PORT = 4383;
const check = createChecks();
const READING = "11111111-1111-4111-8111-1111111111aa";
const SILENT = "22222222-2222-4222-8222-2222222222aa";
const STATES = "33333333-3333-4333-8333-3333333333aa";

async function openTask(page, title) {
  await page.click(`.card:has-text("${title}")`);
  await page.waitForFunction((t) => document.querySelector(".detail-head")?.textContent?.includes(t), title, { timeout: 15000 });
}

/** The receipt chips under the newest feed row whose text contains `needle`. */
async function marksFor(page, needle) {
  return page.evaluate((n) => {
    const rows = [...document.querySelectorAll(".fi.system")].filter((r) => (r.querySelector(".body")?.textContent ?? "").includes(n));
    const row = rows[rows.length - 1];
    if (!row) return null;
    return [...row.querySelectorAll(".receipt-mark")].map((m) => ({
      recipient: m.getAttribute("data-recipient"),
      status: [...m.classList].find((c) => c !== "receipt-mark"),
      word: m.querySelector(".receipt-word")?.textContent ?? "",
      label: m.getAttribute("aria-label") ?? "",
      title: m.getAttribute("title") ?? "",
      role: m.getAttribute("role"),
      tick: !!m.querySelector("svg path[d^='M4.7']"),
      size: m.querySelector("svg")?.getBoundingClientRect().height ?? 0,
    }));
  }, needle);
}

async function waitForMark(page, needle, recipient, status) {
  await page.waitForFunction(
    ({ n, r, s }) => {
      const rows = [...document.querySelectorAll(".fi.system")].filter((x) => (x.querySelector(".body")?.textContent ?? "").includes(n));
      return !!rows[rows.length - 1]?.querySelector(`.receipt-mark.${s}[data-recipient="${r}"]`);
    },
    { n: needle, r: recipient, s: status },
    { timeout: 20000 },
  );
}

async function inject(page, text, button) {
  await page.fill(".inject-bar textarea", text);
  await page.click(`.inject-bar .row button:text-is("${button}")`);
}

function seedStates(dbPath) {
  // One message per receipt state the live fixture cannot reach on its own, written the way the server
  // writes them, so the lab sees every hat side by side.
  const Database = require(path.join(__dirname, "..", "node_modules", "better-sqlite3"));
  const db = new Database(dbPath);
  const now = Date.now();
  const msg = db.prepare("INSERT INTO messages (id, thread_id, role, kind, content, created_at) VALUES (?,?,?,?,?,?)");
  const rec = db.prepare(
    `INSERT INTO injection_receipts (id, message_id, thread_id, recipient, instruction, status, run_id, provider, detail, created_at, sent_at, delivered_at, read_at, failed_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  );
  const rows = [
    ["delivered", "codex", null, now - 50_000, now - 49_000, null, null],
    ["sent", "grok", "This agent gives no read signal; the message was handed to its input.", now - 40_000, null, null, null],
    ["failed", null, "The task was cancelled before this agent took the message.", null, null, null, now - 30_000],
  ];
  rows.forEach(([status, provider, detail, sentAt, deliveredAt, readAt, failedAt], i) => {
    const id = randomUUID();
    const text = `seeded ${status} instruction`;
    msg.run(id, STATES, "director", "system", `↪ injected: ${text}`, now - 60_000 + i * 1000);
    rec.run(randomUUID(), id, STATES, "implementor", text, status, provider ? "seeded-run" : null, provider, detail, now - 60_000 + i * 1000, sentAt, deliveredAt, readAt, failedAt);
  });
  db.close();
}

(async () => {
  requireBuild();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "receipts-lab-"));
  killInstance(PORT);
  const child = await boot({ dataDir, port: PORT, env: { ORCH_LAB_FIXTURES: "1" } });
  let code = 1;
  try {
    const Database = require(path.join(__dirname, "..", "node_modules", "better-sqlite3"));
    const dbPath = path.join(dataDir, "orchestrator.sqlite");
    const db = new Database(dbPath);
    const now = Date.now();
    const ins = db.prepare("INSERT INTO threads (id, title, raw_prompt, brief, workspace, state, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)");
    ins.run(READING, "READING QA TASK", "p", "b", process.cwd(), "qa", now, now);
    ins.run(SILENT, "SILENT QA TASK", "p", "b", process.cwd(), "qa", now - 1000, now - 1000);
    ins.run(STATES, "RECEIPT STATES TASK", "p", "b", process.cwd(), "review", now - 2000, now - 2000);
    db.close();
    seedStates(dbPath);

    const chromium = loadChromium();
    const browser = await chromium.launch();
    const ctx = await browser.newContext({ viewport: { width: 1500, height: 950 } });
    const page = await ctx.newPage();
    await page.addInitScript(() => {
      const NativeSocket = window.WebSocket;
      window.__receiptSockets = [];
      window.WebSocket = class extends NativeSocket {
        constructor(...args) {
          super(...args);
          window.__receiptSockets.push(this);
        }
      };
    });
    await page.request.post(`http://127.0.0.1:${PORT}/api/login`, { data: { password: authPassword() } });
    for (const [id, reads] of [[READING, "1"], [SILENT, "0"]]) {
      const res = await page.request.post(`http://127.0.0.1:${PORT}/api/lab/live-qa/${id}?reads=${reads}`);
      check(`live QA fixture attached (reads=${reads})`, res.ok(), await res.text().catch(() => ""));
    }
    await page.goto(`http://127.0.0.1:${PORT}/`, { timeout: 45000 });
    await page.waitForSelector(".accounts .acct", { state: "attached", timeout: 30000 });

    // 1. QA takes the message and ACKs it; the implementor's copy is only queued.
    await openTask(page, "READING QA TASK");
    const asked = "also check the export dialog";
    await inject(page, asked, "Inject");
    await waitForMark(page, asked, "implementor", "pending");
    const early = await marksFor(page, asked);
    check("QA starts below read (accepting is not reading)", early?.some((m) => m.recipient === "qa" && m.status !== "read"), JSON.stringify(early));
    await waitForMark(page, asked, "qa", "delivered").catch(() => {});
    await waitForMark(page, asked, "qa", "read");
    const read = await marksFor(page, asked);
    const qa = read?.find((m) => m.recipient === "qa");
    const impl = read?.find((m) => m.recipient === "implementor");
    check("QA's hat shows read with a tick", qa?.status === "read" && qa.tick && qa.word === "QA read", JSON.stringify(qa));
    check("the implementor's copy is still waiting, without a tick", impl?.status === "pending" && !impl.tick && impl.word === "Implementor waiting", JSON.stringify(impl));
    check("the read label names the recipient and the time", /^Read by .+ \(QA\) at \d/.test(qa?.label ?? "") && qa?.label === qa?.title && qa?.role === "img", qa?.label);
    check("the waiting label says why", /Waiting for .+ \(Implementor\)\./.test(impl?.label ?? ""), impl?.label);
    check("the hat stays small", (qa?.size ?? 0) > 0 && (qa?.size ?? 99) <= 16, String(qa?.size));

    // Repeating identical text is a new injection, never a receipt for the previous input.
    await inject(page, asked, "Inject");
    // The first row already has an implementor pending mark. Wait for the second server echo,
    // rather than letting that old mark satisfy the wait before the new injection arrives.
    await page.waitForFunction((n) => [...document.querySelectorAll(".fi.system")].filter((r) =>
      (r.querySelector(".body")?.textContent ?? "").includes(n) && r.querySelector(".receipt-mark"),
    ).length === 2, asked, { timeout: 20000 });
    await waitForMark(page, asked, "implementor", "pending");
    const repeatEarly = (await marksFor(page, asked))?.find((m) => m.recipient === "qa");
    check("repeated text waits for its own delivery and ACK", repeatEarly?.status === "sent" && !repeatEarly.tick, JSON.stringify(repeatEarly));
    await waitForMark(page, asked, "qa", "read");
    await page.evaluate(() => window.__receiptSockets.forEach((socket) => socket.close()));
    await page.waitForFunction(() => window.__receiptSockets.length >= 2 && window.__receiptSockets.at(-1)?.readyState === WebSocket.OPEN);
    await waitForMark(page, asked, "qa", "read");
    const reconnected = await marksFor(page, asked);
    check("reconnect retains exact recipient states without duplicate receipts", reconnected?.length === 2 && reconnected.find((m) => m.recipient === "qa")?.status === "read" && reconnected.find((m) => m.recipient === "implementor")?.status === "pending", JSON.stringify(reconnected));

    // 2. Queue mode: held for the implementor's hand-off, so waiting and never ticked.
    const queued = "rename the export button after the review";
    const queueButton = await page.$('.inject-bar .row button:text-is("Queue")');
    if (queueButton) {
      await inject(page, queued, "Queue");
      await waitForMark(page, queued, "implementor", "pending");
      const q = await marksFor(page, queued);
      check("a queued message is waiting for the implementor only", q?.length === 1 && q[0].status === "pending", JSON.stringify(q));
    }

    // 3. A provider with no consumption signal stops at "sent" and says so.
    await openTask(page, "SILENT QA TASK");
    const silent = "keep the old palette";
    await inject(page, silent, "Inject");
    await waitForMark(page, silent, "qa", "sent");
    const s = (await marksFor(page, silent))?.find((m) => m.recipient === "qa");
    check("a signal-less QA run is only 'sent', never read", s?.status === "sent" && !s.tick && /no read signal/.test(s.label), JSON.stringify(s));

    // 4. Every other state renders distinctly.
    await openTask(page, "RECEIPT STATES TASK");
    await page.waitForSelector(".receipt-mark.failed", { timeout: 15000 });
    const delivered = (await marksFor(page, "seeded delivered"))?.[0];
    const sent = (await marksFor(page, "seeded sent"))?.[0];
    const failed = (await marksFor(page, "seeded failed"))?.[0];
    check("delivered is labelled as in context, not read", delivered?.word === "Implementor delivered" && !delivered.tick && /not confirmed read/.test(delivered.label) && /Codex turn carrying it produced model output/.test(delivered.label), delivered?.label);
    check("sent is its own state", sent?.word === "Implementor sent", JSON.stringify(sent));
    check("failed reads as not delivered with the reason", failed?.word === "Implementor not delivered" && /cancelled before this agent took/.test(failed.label), failed?.label);
    await page.locator(".fi.system", { hasText: "seeded delivered" }).screenshot({ path: path.join(shotDir(dataDir), "receipt-delivered.png") }).catch(() => {});

    // 5. Reload: every receipt comes back from the server, no duplicates.
    await page.reload();
    await page.waitForSelector(".accounts .acct", { state: "attached", timeout: 30000 });
    await openTask(page, "READING QA TASK");
    await waitForMark(page, asked, "qa", "read");
    const after = await marksFor(page, asked);
    check("after reload QA is still read and the implementor still waiting", after?.length === 2 && after.find((m) => m.recipient === "qa")?.status === "read" && after.find((m) => m.recipient === "implementor")?.status === "pending", JSON.stringify(after));
    const rows = await page.evaluate((n) => [...document.querySelectorAll(".fi.system .body")].filter((b) => (b.textContent ?? "").includes(n)).length, asked);
    check("the injected row is not duplicated by the reload", rows >= 1 && rows <= 2, String(rows));
    await page.locator(".fi.system", { hasText: asked }).last().screenshot({ path: path.join(shotDir(dataDir), "receipt-qa-read.png") });
    await page.screenshot({ path: path.join(shotDir(dataDir), "receipts.png") });
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
  process.exit(2);
});
