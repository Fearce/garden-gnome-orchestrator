// Lab for the console's search box (`npm run search-lab`). `test:task-search` proves the QUERY finds
// the right tasks in the right order; what it cannot see is whether any of that reaches the rail. The
// box lived over `director_messages` alone for months, so the failure this guards against is precisely
// "the server knows the answer and the UI shows the old empty state": the Tasks section rendering at
// all, the evidence line and highlight that make a hit legible, and the click that opens the task —
// which is the entire point of searching. Boots its own throwaway instance and seeds its own history.
// Not in GATES: it needs a browser + an instance, like the other labs.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { loadChromium, authPassword, requireBuild, boot, killInstance, createChecks } = require("./lab-harness.cjs");

const PORT = 4385;
const check = createChecks();

// The shape of the real miss: the owner's words never say "milkshake", the implementor's do.
const MONSTER = { id: "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa", title: "Adjust colors to purple black red white palette" };
// Newer, and mentions it once in a crawl dump — must NOT outrank the task that did the work.
const CRAWL = { id: "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb", title: "Nightly crawl of the menu sites" };

/** The task cards as the rail renders them, top to bottom. */
async function taskHits(page) {
  return page.evaluate(() =>
    [...document.querySelectorAll(".ds-results .ds-task")].map((el) => ({
      title: (el.querySelector(".ds-task-title")?.textContent ?? "").trim(),
      snippet: (el.querySelector(".ds-snippet")?.textContent ?? "").trim(),
      where: (el.querySelector(".ds-task-where")?.textContent ?? "").trim(),
      repo: (el.querySelector(".ds-task-repo")?.textContent ?? "").trim(),
      state: (el.querySelector(".ds-task-state")?.textContent ?? "").trim(),
      marks: [...el.querySelectorAll("mark.ds-hit")].map((m) => m.textContent),
    })),
  );
}

async function search(page, query) {
  await page.fill(".rail-search-input", query);
  await page.waitForFunction(
    (q) => (document.querySelector(".ds-status")?.textContent ?? "").includes(`“${q}”`),
    query,
    { timeout: 15000 },
  );
}

(async () => {
  requireBuild();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "search-lab-"));
  killInstance(PORT);
  const child = await boot({ dataDir, port: PORT });
  let code = 1;
  try {
    const Database = require(path.join(__dirname, "..", "node_modules", "better-sqlite3"));
    const db = new Database(path.join(dataDir, "orchestrator.sqlite"));
    const now = Date.now();
    const task = db.prepare(
      "INSERT INTO threads (id, title, raw_prompt, brief, workspace, state, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)",
    );
    task.run(MONSTER.id, MONSTER.title, "p", "Can u make a 3d model of this i can print? 3mf file", "C:\\3d", "done", now - 900_000, now);
    task.run(CRAWL.id, CRAWL.title, "p", "run a crawl and fix any failures", "C:\\workspace", "review", now - 60_000, now);

    const msg = db.prepare("INSERT INTO messages (id, thread_id, role, kind, content, created_at) VALUES (?,?,?,?,?,?)");
    msg.run("m1", MONSTER.id, "implementor", "text", "I'll tackle this. The image is a cute purple furry creature drinking a milkshake — an organic character sculpt.", now - 890_000);
    for (let i = 0; i < 12; i++) {
      msg.run(`m2-${i}`, MONSTER.id, "implementor", "tool", `Write {"file":"C:\\\\3d\\\\milkshake-monster\\\\part${i}.py"}`, now - 880_000 + i);
    }
    // One incidental hit, buried in a wall of crawler output — the snippet must be windowed, not shipped.
    msg.run("m3", CRAWL.id, "implementor", "result", "z".repeat(120_000) + "\n\n  fetched /menu/milkshakes-and-cold-drinks.html \t 57 dishes\n" + "z".repeat(120_000), now - 50_000);
    db.prepare("INSERT INTO director_messages (id, role, kind, content, created_at) VALUES (?,?,?,?,?)").run(
      "d1",
      "user",
      "text",
      "remember the milkshake print when you get a chance",
      now - 30_000,
    );
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

    // ---- the bug, end to end: a word only the agent ever said still finds its task ----
    await search(page, "milkshake");
    await page.waitForSelector(".ds-results .ds-task", { timeout: 15000 });
    let hits = await taskHits(page);
    check("the rail renders a Tasks section", hits.length === 2, JSON.stringify(hits.map((h) => h.title)));
    check(
      "a task whose title and brief never say it is found",
      hits.some((h) => h.title === MONSTER.title),
      JSON.stringify(hits.map((h) => h.title)),
    );
    check("the task that did the work sorts above the newer log dump", hits[0]?.title === MONSTER.title, hits[0]?.title);

    // ---- the evidence that makes a hit legible ----
    const monster = hits.find((h) => h.title === MONSTER.title) ?? {};
    check("its snippet quotes what the agent actually wrote", /cute purple furry creature/.test(monster.snippet), monster.snippet);
    check("the match is highlighted", (monster.marks ?? []).some((m) => m.toLowerCase() === "milkshake"), JSON.stringify(monster.marks));
    check("it says how deeply the task matched", /13 messages in the conversation/.test(monster.where), monster.where);
    check("it names the repo and the state", monster.repo === "3d" && /done/i.test(monster.state), `${monster.repo} / ${monster.state}`);

    const crawl = hits.find((h) => h.title === CRAWL.title) ?? {};
    check("a 240 KB log line arrives as a windowed snippet", crawl.snippet.length < 500 && crawl.snippet.length > 0, `${crawl.snippet.length} chars`);
    check("...still carrying the match, on one line", /milkshakes-and-cold-drinks/.test(crawl.snippet) && !/\n/.test(crawl.snippet), crawl.snippet.slice(0, 90));
    // An unbroken run of tool output (base64, a slicer dump) wraps to a dozen lines unless clamped, and
    // one such card pushes every other hit off the screen. Measured, not read off the stylesheet.
    const boxes = await page.$$eval(".ds-results .ds-task", (els) =>
      els.map((el) => ({
        card: el.getBoundingClientRect().height,
        clipped: (() => {
          const s = el.querySelector(".ds-snippet");
          return s ? { shown: s.clientHeight, full: s.scrollHeight } : null;
        })(),
      })),
    );
    check("a pathological snippet is clipped, not laid out in full", boxes[1]?.clipped?.full > boxes[1]?.clipped?.shown, JSON.stringify(boxes[1]?.clipped));
    check("...so one noisy hit can't dwarf the others", boxes[1]?.card < boxes[0]?.card * 1.6, JSON.stringify(boxes.map((b) => Math.round(b.card))));
    check("...while the readable one is not clipped at all", boxes[0]?.clipped?.full === boxes[0]?.clipped?.shown, JSON.stringify(boxes[0]?.clipped));

    // ---- the director conversation is still searched, as its own section ----
    const sections = await page.$$eval(".ds-results .ds-section", (els) => els.map((e) => e.textContent.trim()));
    check("both halves are labelled", sections.join("|") === "Tasks|Director conversation", sections.join("|"));
    check("the director hit still renders", (await page.$$(".ds-results .ds-result")).length === 1);
    const status = (await page.textContent(".ds-status")) ?? "";
    check("the status line counts both", /2 tasks · 1 director message/.test(status), status);
    await page.screenshot({ path: path.join(dataDir, "search.png") });

    // ---- the click that is the entire point ----
    await page.click(`.ds-results .ds-task:has-text("${MONSTER.title}")`);
    await page.waitForSelector(".detail-head", { timeout: 15000 });
    check("clicking a task hit opens that task", ((await page.textContent(".detail-head")) ?? "").includes(MONSTER.title));
    check("...and hands the rail back to the transcript", await page.isVisible(".transcript"), "results still shown");
    check("...with the box cleared", (await page.inputValue(".rail-search-input")) === "");

    // ---- a term nobody said says so, rather than showing a stale list ----
    await search(page, "kombucha");
    check("a no-match query shows no task cards", (await page.$$(".ds-results .ds-task")).length === 0);
    const emptyText = (await page.textContent(".ds-results")) ?? "";
    check("...and says where it looked", /no task’s title, brief or conversation/.test(emptyText), emptyText.slice(0, 140));

    // ---- a typed wildcard is a literal, in the browser too ----
    await search(page, "milk%ake");
    check("a % typed in the box is not a wildcard", (await page.$$(".ds-results .ds-task")).length === 0);

    check("no console errors", errors.length === 0, errors.join(" | "));
    code = check.summary();
    console.log(`\nscreenshot: ${path.join(dataDir, "search.png")}`);
    await browser.close();
  } catch (e) {
    console.error(e);
  } finally {
    try {
      child.kill();
    } catch {
      /* already gone */
    }
    killInstance(PORT);
  }
  process.exit(code);
})();
