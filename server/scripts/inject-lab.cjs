// Lab for the thread composer's inject row (`npm run inject-lab`). Two things a bundle grep cannot
// prove: the two button tooltips are state-CONDITIONAL, so only a render says which text the console
// actually shows while a reviewer owns the slot; and "Interrupt & inject" on a task in `qa` has to
// survive the whole click → socket → injectThread round-trip, which is the regression this exists for
// (it used to leave QA running while merely recording the injection — server side, gate `test:inject-qa`).
// Boots its own throwaway instance, seeds one task each in `qa`, `reviewing` and `implementing`,
// and drives all three. Not in GATES: it needs a browser + an instance, like the other labs.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { loadChromium, authPassword, requireBuild, boot, killInstance, createChecks, shotDir } = require("./lab-harness.cjs");

const PORT = 4381;
const check = createChecks();

async function titles(page) {
  return page.evaluate(() => {
    const btn = (label) => [...document.querySelectorAll(".inject-bar .row button")].find((b) => b.textContent.trim() === label);
    return { inject: btn("Inject")?.title ?? null, interrupt: btn("Interrupt & inject")?.title ?? null };
  });
}

async function placeholder(page) {
  return page.getAttribute(".inject-bar textarea", "placeholder");
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
  const child = await boot({ dataDir, port: PORT, env: { ORCH_LAB_FIXTURES: "1" } });
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
    ins.run("44444444-4444-4444-8444-444444444444", "NO HANDLE QA TASK", "p", "b", process.cwd(), "qa", now - 3000, now - 3000);
    ins.run("55555555-5555-4555-8555-555555555555", "AWAITING REVIEWER TASK", "p", "b", process.cwd(), "awaiting_user", now - 4000, now - 4000);
    db.prepare("INSERT INTO agent_runs (id, thread_id, role, model, state, started_at) VALUES (?,?,?,?,?,?)").run(
      "55555555-0000-4000-8000-000000000000",
      "55555555-5555-4555-8555-555555555555",
      "reviewer",
      "fixture-reviewer",
      "running",
      now - 3500,
    );
    // Reproduce the old per-instruction noise alongside content the owner must still see.
    const spam = [
      "[delivered] RI-1234abcd reached active qa run 8765abcd; its verdict is held until the instruction is acknowledged and acted on.",
      "\u21aa RI-1234abcd survived the server restart; prior QA delivery is no longer claimed, and the next QA run will receive it with its attachments.",
      "\u29d7 RI-1234abcd survived the server restart and is queued for the next implementor run; it is not claimed as delivered to the dead one.",
    ];
    const message = db.prepare("INSERT INTO messages (id,thread_id,role,kind,content,created_at) VALUES (?,?,?,?,?,?)");
    for (let i = 0; i < 24; i++) message.run(`qa-noise-${i}`, "11111111-1111-4111-8111-111111111111", "director", "system", spam[i % spam.length], now + i);
    message.run("qa-owner-note", "11111111-1111-4111-8111-111111111111", "director", "system", "[accepted] RI-1234abcd: please keep my instruction visible", now + 25);
    message.run("qa-restart-summary", "11111111-1111-4111-8111-111111111111", "director", "system", "QA has 8 pending instructions after the server restart.", now + 26);
    db.close();

    const chromium = loadChromium();
    const browser = await chromium.launch();
    const ctx = await browser.newContext({ viewport: { width: 1500, height: 950 } });
    const page = await ctx.newPage();
    await page.request.post(`http://127.0.0.1:${PORT}/api/login`, { data: { password: authPassword() } });
    const liveFixture = await page.request.post(`http://127.0.0.1:${PORT}/api/lab/live-qa/11111111-1111-4111-8111-111111111111`);
    check("the happy-path QA task has a real live QA fixture", liveFixture.ok(), await liveFixture.text().catch(() => ""));
    await page.goto(`http://127.0.0.1:${PORT}/`, { timeout: 45000 });
    await page.waitForSelector(".accounts .acct", { state: "attached", timeout: 30000 }); // hello landed

    await openTask(page, "REVIEWED TASK");
    async function checkNoise(label) {
      // Selection paints the panel before its paged history arrives, especially after reload.
      await page.waitForFunction(() => {
        const text = document.querySelector(".detail-body")?.textContent ?? "";
        return text.includes("please keep my instruction visible") && text.includes("8 pending instructions");
      }, { timeout: 20000 });
      const body = await page.textContent(".detail-body");
      check(`${label}: old QA delivery/restart spam is hidden`, !spam.some((line) => body.includes(line)));
      check(`${label}: the owner instruction remains visible`, body.includes("please keep my instruction visible"));
      check(`${label}: the concise restart summary remains visible`, body.includes("8 pending instructions"));
    }
    await checkNoise("desktop");
    await page.setViewportSize({ width: 582, height: 912 });
    await checkNoise("narrow panel");
    await page.reload();
    await page.waitForSelector(".accounts .acct", { state: "attached", timeout: 30000 });
    await openTask(page, "REVIEWED TASK");
    await checkNoise("reloaded history");
    await page.setViewportSize({ width: 1500, height: 950 });
    const qa = await titles(page);
    check("QA-stage composer names its actual recipient", /QA reviewer/i.test((await placeholder(page)) ?? ""), await placeholder(page));
    check("QA-stage Inject tooltip names QA", /Send to QA now/.test(qa.inject ?? ""), qa.inject);
    check("QA-stage Inject tooltip promises acknowledgement and implementation", /verdict waits for acknowledgement/.test(qa.inject ?? "") && /queued for implementation/.test(qa.inject ?? ""), qa.inject);
    check("QA-stage Interrupt tooltip stops promising to stop an implementor", !/Stop the implementor/.test(qa.interrupt ?? ""), qa.interrupt);
    check("QA-stage Interrupt tooltip says what it really does", /Stop QA now and return this task to the implementor/.test(qa.interrupt ?? ""), qa.interrupt);

    await openTask(page, "WORKING TASK");
    const impl = await titles(page);
    check("implementing composer names its actual recipient", /implementor/i.test((await placeholder(page)) ?? ""), await placeholder(page));
    check("implementing Inject tooltip is unchanged", /Send to the implementor now/.test(impl.inject ?? ""), impl.inject);
    check("implementing Interrupt tooltip is unchanged", /Stop the implementor now/.test(impl.interrupt ?? ""), impl.interrupt);

    // Auto-review append fences the verdict until the reviewer acknowledges and acts or explicitly
    // hands write-capable work to implementation. Interrupt deliberately supersedes that review.
    await openTask(page, "AUTOREVIEWED TASK");
    const ar = await titles(page);
    check("auto-review composer names its actual recipient", /auto-reviewer/i.test((await placeholder(page)) ?? ""), await placeholder(page));
    check("auto-review Inject tooltip names the auto-reviewer", /Send to the auto-reviewer now/.test(ar.inject ?? ""), ar.inject);
    check("auto-review Inject tooltip fences the verdict and names the hand-off", /verdict cannot settle/.test(ar.inject ?? "") && /hands the instruction to implementation/.test(ar.inject ?? ""), ar.inject);
    check("auto-review Interrupt tooltip stops promising to stop an implementor", !/Stop the implementor/.test(ar.interrupt ?? ""), ar.interrupt);
    check("auto-review Interrupt tooltip says what it really does", /Stop and supersede Auto-review/.test(ar.interrupt ?? "") && /return this task to implementation/.test(ar.interrupt ?? ""), ar.interrupt);

    await openTask(page, "AWAITING REVIEWER TASK");
    check("an auto-reviewer awaiting owner input remains the named recipient", /auto-reviewer/i.test((await placeholder(page)) ?? ""), await placeholder(page));

    await openTask(page, "NO HANDLE QA TASK");
    await page.fill(".inject-bar textarea", "this should stay typed when no QA handle exists");
    await page.click('.inject-bar .row button:text-is("Interrupt & inject")');
    await page.waitForFunction(
      () => document.body.textContent?.includes("QA has no live stop handle right now"),
      { timeout: 20000 },
    );
    const failedBadge = (await page.textContent(".detail-head .badge")) ?? "";
    check("the no-live QA path stays visibly in QA", /qa/i.test(failedBadge), failedBadge);
    const failedDirective = page.locator(".fi.system").filter({ hasText: "no QA handle" }).filter({ has: page.locator(".delivery-receipt.failed") });
    await failedDirective.waitFor({ state: "visible" });
    check("the failed no-live path retains the directive with a failed receipt", await failedDirective.count() === 1 && (await failedDirective.textContent()).includes("Not delivered"), await failedDirective.textContent());

    // ...and the click itself, end to end through the socket: a task in `qa` must survive it.
    await openTask(page, "REVIEWED TASK");
    await page.fill(".inject-bar textarea", "swap the button for an item blacklist");
    await page.click('.inject-bar .row button:text-is("Interrupt & inject")');
    await page.waitForFunction(
      () => [...document.querySelectorAll(".fi .body, .feed *")].some((n) => (n.textContent ?? "").includes("returning to the implementor")),
      { timeout: 20000 },
    );
    const badge = (await page.textContent(".detail-head .badge")) ?? "";
    check("the task did NOT flip to review on the click", !/review/i.test(badge), badge);
    check("...it visibly returned toward implementation", /implementing/i.test(badge), badge);

    await page.screenshot({ path: path.join(shotDir(dataDir), "qa-inject-row.png") });
    console.log(`\nscreenshot: ${path.join(shotDir(dataDir), "qa-inject-row.png")}`);
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
