// Lab for the thread composer's inject row (`npm run inject-lab`). Two things a bundle grep cannot
// prove: the two button tooltips are state-CONDITIONAL, so only a render says which text the console
// actually shows while a reviewer owns the slot; and "Interrupt & inject" on a task in `qa` has to
// survive the whole click → socket → injectThread round-trip, which is the regression this exists for
// (it used to abort QA's turn and park the task in `review` — server side, gate `test:inject-qa`).
// Boots its own throwaway instance, seeds one task in `qa` and one in `implementing`, drives both.
// Not in GATES: it needs a browser + an instance, like the other labs.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { loadChromium, authPassword, requireBuild, boot, killInstance, createChecks } = require("./lab-harness.cjs");

const PORT = 4381;
const check = createChecks();

async function titles(page) {
  return page.evaluate(() => {
    const btn = (label) => [...document.querySelectorAll(".inject-bar .row button")].find((b) => b.textContent.trim() === label);
    return { inject: btn("Inject")?.title ?? null, interrupt: btn("Interrupt & inject")?.title ?? null };
  });
}

async function openTask(page, title) {
  await page.click(`.card:has-text("${title}")`);
  await page.waitForSelector(".detail-head", { timeout: 15000 });
  await page.waitForFunction(
    (t) => document.querySelector(".detail-head")?.textContent?.includes(t),
    title,
    { timeout: 15000 },
  );
}

(async () => {
  requireBuild();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "inject-tip-"));
  killInstance(PORT);
  const child = await boot({ dataDir, port: PORT });
  let code = 1;
  try {
    // Seed straight into the instance's own DB, then let the boot-loaded state serve it over the socket.
    const Database = require(path.join(__dirname, "..", "node_modules", "better-sqlite3"));
    const db = new Database(path.join(dataDir, "orchestrator.sqlite"));
    const now = Date.now();
    const ins = db.prepare(
      "INSERT INTO threads (id, title, raw_prompt, brief, workspace, state, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)",
    );
    ins.run("11111111-1111-4111-8111-111111111111", "REVIEWED TASK", "p", "b", process.cwd(), "qa", now, now);
    ins.run("22222222-2222-4222-8222-222222222222", "WORKING TASK", "p", "b", process.cwd(), "implementing", now - 1000, now - 1000);
    ins.run("33333333-3333-4333-8333-333333333333", "AUTOREVIEWED TASK", "p", "b", process.cwd(), "reviewing", now - 2000, now - 2000);
    db.close();

    const chromium = loadChromium();
    const browser = await chromium.launch();
    const ctx = await browser.newContext({ viewport: { width: 1500, height: 950 } });
    const page = await ctx.newPage();
    await page.request.post(`http://127.0.0.1:${PORT}/api/login`, { data: { password: authPassword() } });
    await page.goto(`http://127.0.0.1:${PORT}/`, { timeout: 45000 });
    await page.waitForSelector(".accounts .acct", { timeout: 30000 }); // hello landed

    await openTask(page, "REVIEWED TASK");
    const qa = await titles(page);
    check("QA-stage Inject tooltip names the reviewer", /Send to the reviewer now/.test(qa.inject ?? ""), qa.inject);
    check("QA-stage Inject tooltip promises the implementor hand-off", /queue it for the implementor/.test(qa.inject ?? ""), qa.inject);
    check("QA-stage Interrupt tooltip stops promising to stop an implementor", !/Stop the implementor/.test(qa.interrupt ?? ""), qa.interrupt);
    check("QA-stage Interrupt tooltip says what it really does", /Nothing to stop while the reviewer has the task/.test(qa.interrupt ?? ""), qa.interrupt);

    await openTask(page, "WORKING TASK");
    const impl = await titles(page);
    check("implementing Inject tooltip is unchanged", /Send to the implementor now/.test(impl.inject ?? ""), impl.inject);
    check("implementing Interrupt tooltip is unchanged", /Stop the implementor now/.test(impl.interrupt ?? ""), impl.interrupt);

    // The auto-review lane differs from the QA one: the note reaches the reviewer only — nothing on
    // that lane drains the implementor queue (runAutoReview drops buffered notes when it settles), so
    // the tooltip must NOT promise a hand-off the server doesn't perform.
    await openTask(page, "AUTOREVIEWED TASK");
    const ar = await titles(page);
    check("auto-review Inject tooltip names the auto-reviewer", /Send to the auto-reviewer now/.test(ar.inject ?? ""), ar.inject);
    check("auto-review Inject tooltip promises no implementor hand-off", !/queue it for the implementor/.test(ar.inject ?? ""), ar.inject);
    check("auto-review Interrupt tooltip stops promising to stop an implementor", !/Stop the implementor/.test(ar.interrupt ?? ""), ar.interrupt);
    check("auto-review Interrupt tooltip says what it really does", /Nothing to stop while the auto-reviewer has the task/.test(ar.interrupt ?? ""), ar.interrupt);

    // ...and the click itself, end to end through the socket: a task in `qa` must survive it.
    await openTask(page, "REVIEWED TASK");
    await page.fill(".inject-bar textarea", "swap the button for an item blacklist");
    await page.click('.inject-bar .row button:text-is("Interrupt & inject")');
    await page.waitForFunction(
      () => [...document.querySelectorAll(".fi .body, .feed *")].some((n) => (n.textContent ?? "").includes("queued for the implementor")),
      { timeout: 20000 },
    );
    const badge = (await page.textContent(".detail-head .badge")) ?? "";
    check("the task did NOT flip to review on the click", !/review/i.test(badge), badge);
    check("...it is still in the QA stage", /qa/i.test(badge), badge);

    await page.screenshot({ path: path.join(dataDir, "qa-inject-row.png") });
    console.log(`\nscreenshot: ${path.join(dataDir, "qa-inject-row.png")}`);
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
