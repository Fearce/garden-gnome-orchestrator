// Lab for the owner's note list (`npm run notes-lab`). What a typecheck, `test:notes` and a bundle grep
// all miss: whether the Notes tab actually renders the broadcast, whether the tick really removes a note
// through the socket (and STAYS removed across a reload — the list is server-authoritative, so an
// optimistic-looking disappearance proves nothing), whether the link is a real clickable anchor at the
// right href, and whether a link the server would never accept can still reach an `href` if a row got
// into the DB some other way. Boots its own throwaway instance and seeds its own notes. Not in GATES:
// it needs a browser + an instance, like the other labs.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { loadChromium, authPassword, requireBuild, boot, killInstance, createChecks } = require("./lab-harness.cjs");

const PORT = 4383;
const check = createChecks();

const TASK_ID = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
const PR_URL = "https://github.com/acme/vota/pull/412";

/** The rendered rows, top to bottom — body text, the href the console would actually navigate to, and
 *  whether it rendered as an anchor at all. */
async function rows(page) {
  return page.evaluate(() =>
    [...document.querySelectorAll(".notes-list .note-row")].map((li) => {
      const a = li.querySelector("a.note-body");
      return {
        body: (li.querySelector(".note-body")?.textContent ?? "").trim(),
        href: a ? a.getAttribute("href") : null,
        isLink: !!a,
        target: a ? a.getAttribute("target") : null,
        rel: a ? a.getAttribute("rel") : null,
        kind: [...li.classList].find((c) => c.startsWith("k-")) ?? null,
      };
    }),
  );
}

async function openNotes(page) {
  await page.click('.board-tab:has-text("Notes")');
  await page.waitForSelector(".notes-view", { timeout: 15000 });
}

(async () => {
  requireBuild();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "notes-lab-"));
  killInstance(PORT);
  const child = await boot({ dataDir, port: PORT });
  let code = 1;
  try {
    // Seed straight into the instance's own DB so the boot-loaded state serves it over the socket. The
    // `javascript:` row is deliberately inserted HERE, below the service that would refuse it — that is
    // the only way to prove the render guards the href independently of the write guard.
    const Database = require(path.join(__dirname, "..", "node_modules", "better-sqlite3"));
    const db = new Database(path.join(dataDir, "orchestrator.sqlite"));
    const now = Date.now();
    db.prepare("INSERT INTO threads (id, title, raw_prompt, brief, workspace, state, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)").run(
      TASK_ID,
      "FIX THE CRAWLER",
      "p",
      "b",
      process.cwd(),
      "review",
      now,
      now,
    );
    const note = db.prepare(
      "INSERT INTO operator_notes (id, seq, body, url, thread_id, thread_title, workspace, from_role, from_name, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
    );
    note.run("n1", 1, "branch fix-crawler pushed", "https://github.com/acme/vota/tree/fix-crawler", TASK_ID, "FIX THE CRAWLER", process.cwd(), "implementor", "Liv", now - 60_000);
    note.run("n2", 2, "PR #412 ready to merge", PR_URL, TASK_ID, "FIX THE CRAWLER", process.cwd(), "implementor", "Liv", now - 30_000);
    note.run("n3", 3, "hostile link", "javascript:alert(document.cookie)", null, null, null, null, null, now - 10_000);
    db.close();

    const chromium = loadChromium();
    const browser = await chromium.launch();
    const ctx = await browser.newContext({ viewport: { width: 1500, height: 950 } });
    const page = await ctx.newPage();
    const errors = [];
    page.on("console", (m) => {
      if (m.type() === "error") errors.push(m.text());
    });
    await page.request.post(`http://127.0.0.1:${PORT}/api/login`, { data: { password: authPassword() } });
    await page.goto(`http://127.0.0.1:${PORT}/`, { timeout: 45000 });
    await page.waitForSelector(".accounts .acct", { timeout: 30000 }); // hello landed

    // ---- the badge on the task board is the whole point: it says "something is waiting on you" ----
    const badge = (await page.textContent('.board-tab:has-text("Notes") .board-tab-count')) ?? "";
    check("the Tasks view shows a Notes count badge", badge.trim() === "3", badge);

    await openNotes(page);
    let list = await rows(page);
    check("every seeded note renders", list.length === 3, JSON.stringify(list.map((r) => r.body)));
    check("newest first", list[0].body === "hostile link" && list[2].body === "branch fix-crawler pushed", JSON.stringify(list.map((r) => r.body)));

    // ---- the click target ----
    const pr = list.find((r) => r.body.startsWith("PR #412"));
    check("a PR note is a real anchor at its url", pr.isLink && pr.href === PR_URL, JSON.stringify(pr));
    check("...opening in a new tab, safely", pr.target === "_blank" && /noopener/.test(pr.rel ?? ""), JSON.stringify(pr));
    check("...and is typed as a pull request", pr.kind === "k-pr", pr.kind);
    check("a branch note is typed as a branch", list.find((r) => r.body.includes("branch fix-crawler")).kind === "k-branch");

    // ---- a link the write guard would have refused must still never reach an href ----
    const hostile = list.find((r) => r.body === "hostile link");
    check("a javascript: url is NOT rendered as a link", !hostile.isLink, JSON.stringify(hostile));
    const anyJs = await page.evaluate(() => [...document.querySelectorAll("a[href]")].some((a) => /^javascript:/i.test(a.getAttribute("href") ?? "")));
    check("...and no javascript: href exists anywhere on the page", !anyJs);

    // ---- the owner adds one of their own ----
    await page.fill(".note-compose-body", "review the deploy before Friday");
    await page.fill(".note-compose-url", "https://example.com/deploys/9");
    await page.click(".note-compose .btn.primary");
    await page.waitForFunction(() => document.querySelectorAll(".notes-list .note-row").length === 4, { timeout: 15000 });
    list = await rows(page);
    check("the owner's own note lands at the top", list[0].body === "review the deploy before Friday", list[0].body);
    check("...as a clickable link", list[0].href === "https://example.com/deploys/9", list[0].href);
    check("the composer clears after adding", (await page.inputValue(".note-compose-body")) === "" && (await page.inputValue(".note-compose-url")) === "");
    await page.screenshot({ path: path.join(dataDir, "notes.png") });

    // ---- the tick is how the owner clears a note: it must round-trip, not just vanish locally ----
    await page.click('.notes-list .note-row:has-text("PR #412") .note-done');
    await page.waitForFunction(() => document.querySelectorAll(".notes-list .note-row").length === 3, { timeout: 15000 });
    check("ticking a note removes it from the list", !(await rows(page)).some((r) => r.body.startsWith("PR #412")));

    await page.reload({ timeout: 45000 });
    await page.waitForSelector(".accounts .acct", { timeout: 30000 });
    await openNotes(page);
    list = await rows(page);
    check("the deletion survived a reload (server-authoritative)", list.length === 3 && !list.some((r) => r.body.startsWith("PR #412")), JSON.stringify(list.map((r) => r.body)));
    check("the added note survived a reload too", list.some((r) => r.body === "review the deploy before Friday"));

    // ---- the note names its task, and jumps to it ----
    const from = await page.textContent('.notes-list .note-row:has-text("branch fix-crawler") .note-from');
    check("a note from a task names the agent and its repo", /Liv/.test(from) && /implementor/.test(from), from);
    check("the owner's own note says so instead", (await page.textContent('.notes-list .note-row:has-text("review the deploy") .note-from')) === "you");
    await page.click('.notes-list .note-row:has-text("branch fix-crawler") button.note-from');
    await page.waitForSelector(".detail-head", { timeout: 15000 });
    const head = (await page.textContent(".detail-head")) ?? "";
    check("clicking the source opens that task", head.includes("FIX THE CRAWLER"), head.slice(0, 80));
    check("...and switches back to the task board", await page.isVisible(".lanes"));

    // ---- clear all ----
    await openNotes(page);
    page.once("dialog", (d) => d.accept());
    await page.click('.notes-view .btn.ghost:has-text("Clear all")');
    await page.waitForSelector(".notes-view .empty", { timeout: 15000 });
    check("Clear all empties the list", (await rows(page)).length === 0);
    check("...and the board tab drops its badge", (await page.$('.board-tab:has-text("Notes") .board-tab-count')) === null);

    check("no console errors", errors.length === 0, errors.join(" | "));

    await page.screenshot({ path: path.join(dataDir, "notes-empty.png") });
    console.log(`\nscreenshots: ${path.join(dataDir, "notes.png")} (populated) + notes-empty.png`);
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
