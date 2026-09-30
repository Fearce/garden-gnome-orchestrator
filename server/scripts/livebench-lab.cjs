// Drive Settings → LiveBench rankings in a real browser against a throwaway instance.
//
//   npm run livebench-lab --prefix server
//   npm run livebench-lab --prefix server -- --shots data/livebench-lab-shots
//
// Seeds a fresh 120-row LiveBench snapshot (with holes: a missing category score, a missing
// organization) into the instance's kv row, so the boot refresh leaves it alone and the table is
// deterministic. Then it clicks EVERY column header twice and checks the rendered order against an
// independent comparator (numbers numerically, text alphabetically, missing values last in both
// directions), plus the arrow, the filter, the runnable highlight, the sticky header and model column,
// a phone-width pass, and the Nocturne theme.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Database = require("better-sqlite3");
const { loadChromium, authPassword, requireBuild, requireFreshWebBuild, boot, killInstance, createChecks, shotDir, isVoiceBridgeNoise } = require("./lab-harness.cjs");

const PORT = 4351;
const BASE = `http://127.0.0.1:${PORT}`;
const NAV_TIMEOUT = 45_000;
const CATEGORIES = ["Reasoning", "Coding", "Agentic Coding", "Mathematics", "Data Analysis", "Language", "IF"];
const ORGS = ["OpenAI", "Anthropic", "Google", "DeepSeek", "Z.AI", "xAI", "Moonshot AI"];

function fixtureRows() {
  const rows = [];
  for (let i = 0; i < 120; i++) {
    const categories = {};
    CATEGORIES.forEach((c, j) => {
      // A deterministic spread with single-digit scores mixed in, so a lexical sort would visibly misorder them.
      const spread = (i * 37 + j * 53) % 97;
      if (!(i % 17 === 3 && c === "Agentic Coding")) categories[c] = i % 9 === 0 ? (spread % 9) + 0.5 : spread + 3;
    });
    const values = Object.values(categories);
    const overall = Math.round((values.reduce((a, b) => a + b, 0) / values.length) * 10) / 10;
    const row = { model: `model-${String.fromCharCode(97 + (i % 26))}-${i}`, overall, categories };
    if (i % 11 !== 5) row.organization = ORGS[i % ORGS.length];
    rows.push(row);
  }
  rows.push({ model: "claude-opus-5-5-xhigh-effort", overall: 84.2, categories: Object.fromEntries(CATEGORIES.map((c) => [c, 80])), organization: "Anthropic" });
  return rows;
}

function seed(dataDir) {
  const db = new Database(path.join(dataDir, "orchestrator.sqlite"));
  const snapshot = { version: 1, release: "2026-06-25", fetchedAt: Date.now() - 3 * 3_600_000, rows: fixtureRows(), organizationsCaptured: true };
  db.prepare("INSERT INTO kv(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run("livebench_scores_v1", JSON.stringify(snapshot));
  db.close();
  return snapshot;
}

async function openRankings(page, { phone = false } = {}) {
  await page.request.post(`${BASE}/api/login`, { data: { password: authPassword() } });
  await page.goto(`${BASE}/`, { timeout: NAV_TIMEOUT });
  await page.waitForSelector(".accounts .acct", { state: "attached", timeout: 30_000 });
  await page.click('[aria-label="Open settings"]');
  await page.waitForSelector('[role="dialog"][aria-label="Settings"]', { timeout: 20_000 });
  if (phone) await page.selectOption('.settings-mobile-nav select[aria-label="Settings category"]', "livebench");
  else await page.click('[data-settings-category="livebench"]');
  await page.waitForSelector(".lb-table tbody tr", { timeout: 20_000 });
}

/** The table as rendered: header labels, the sorted header, and every body row's cell texts. */
function readTable(page) {
  return page.evaluate(() => {
    const heads = [...document.querySelectorAll(".lb-table thead th")];
    return {
      labels: heads.map((th) => th.textContent.trim()),
      sort: heads.map((th) => th.getAttribute("aria-sort")),
      arrows: heads.map((th) => !!th.querySelector(".lb-arrow.on")),
      rows: [...document.querySelectorAll(".lb-table tbody tr")].map((tr) => [...tr.children].map((c) => c.textContent.trim())),
    };
  });
}

const collator = new Intl.Collator("en", { sensitivity: "base", numeric: true });

/** Independent of the app's comparator: is this column in `direction` order, missing values last? */
function orderProblem(values, kind, direction) {
  const missing = (v) => v === "—" || v === "";
  const firstMissing = values.findIndex(missing);
  if (firstMissing >= 0 && values.slice(firstMissing).some((v) => !missing(v))) return `a value follows a missing one at row ${firstMissing}`;
  const present = firstMissing >= 0 ? values.slice(0, firstMissing) : values;
  for (let i = 1; i < present.length; i++) {
    const cmp = kind === "number" ? Number(present[i - 1]) - Number(present[i]) : collator.compare(present[i - 1], present[i]);
    if ((direction === "asc" && cmp > 0) || (direction === "desc" && cmp < 0)) return `rows ${i - 1}/${i}: ${present[i - 1]} then ${present[i]}`;
  }
  return null;
}

async function sortPass(page, check) {
  const { labels } = await readTable(page);
  const textColumns = new Set(["Model", "Organization"]);
  for (let col = 0; col < labels.length; col++) {
    const kind = textColumns.has(labels[col]) ? "text" : "number";
    for (const click of [1, 2]) {
      await page.locator(".lb-table thead th").nth(col).locator("button").click();
      const table = await readTable(page);
      const direction = table.sort[col] === "ascending" ? "asc" : table.sort[col] === "descending" ? "desc" : null;
      const expected = click === 1 ? (kind === "text" || labels[col] === "Rank" ? "asc" : "desc") : kind === "text" || labels[col] === "Rank" ? "desc" : "asc";
      const values = table.rows.map((r) => r[col]);
      const problem = orderProblem(values, kind, direction);
      check(
        `${labels[col]} click ${click}: ${expected}, only this arrow lit, order holds with missing last`,
        direction === expected && table.arrows.filter(Boolean).length === 1 && table.arrows[col] && !problem,
        `direction=${direction} arrows=${table.arrows.filter(Boolean).length} ${problem ?? ""} head=${values.slice(0, 4).join(",")} tail=${values.slice(-3).join(",")}`,
      );
    }
  }
}

async function geometry(page) {
  return page.evaluate(() => {
    const box = document.querySelector(".lb-scroll");
    box.scrollTop = 1500;
    box.scrollLeft = 400;
    const boxRect = box.getBoundingClientRect();
    const head = document.querySelector(".lb-table thead th").getBoundingClientRect();
    const visibleRow = [...document.querySelectorAll(".lb-table tbody tr")].find((tr) => tr.getBoundingClientRect().top > boxRect.top + 40);
    const model = visibleRow.querySelector(".lb-col-model").getBoundingClientRect();
    const rank = visibleRow.querySelector(".lb-col-rank").getBoundingClientRect();
    const out = {
      scrollsX: box.scrollWidth > box.clientWidth,
      headerTopDelta: Math.round(head.top - boxRect.top - box.clientTop),
      rankPinned: Math.round(rank.left - boxRect.left - box.clientLeft),
      modelPinned: Math.round(model.left - rank.right),
      numAlign: getComputedStyle(visibleRow.querySelector(".lb-col-num")).textAlign,
      numeric: getComputedStyle(document.querySelector(".lb-table")).fontVariantNumeric,
      fonts: [...new Set([".lb-table thead th", ".lb-table tbody td", ".lb-table tbody th"].map((s) => getComputedStyle(document.querySelector(s)).fontFamily))],
      rowBg: getComputedStyle(visibleRow.querySelector(".lb-col-model")).backgroundColor,
    };
    box.scrollTop = 0;
    box.scrollLeft = 0;
    return out;
  });
}

async function main() {
  requireBuild();
  requireFreshWebBuild();
  const check = createChecks();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "livebench-lab-"));
  const shots = shotDir(dataDir);
  const keep = process.argv.includes("--keep");
  console.log(`livebench-lab — ${BASE} (data ${dataDir})`);
  let snapshot;
  try {
    await boot({ dataDir, port: PORT });
    killInstance(PORT);
    snapshot = seed(dataDir);
    await boot({ dataDir, port: PORT });

    const browser = await loadChromium().launch();
    try {
      const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
      const page = await context.newPage();
      const errors = [];
      page.on("console", (m) => m.type() === "error" && !isVoiceBridgeNoise(m) && errors.push(m.text()));
      await openRankings(page);

      const meta = await page.textContent(".lb-meta");
      check("the header names the snapshot's release date", /Snapshot:\s*25 Jun 2026/.test(meta ?? ""), meta);
      check("the header says how fresh the fetch is", /fetched \d+ \w+ \d{4}, \d\d:\d\d \(3h ago\)/.test(meta ?? ""), meta);
      const table = await readTable(page);
      check("every snapshot row renders", table.rows.length === snapshot.rows.length, `${table.rows.length} of ${snapshot.rows.length}`);
      check(
        "columns come from the snapshot's categories with readable labels",
        table.labels.join("|") === ["Rank", "Model", "Organization", "Global Average", ...CATEGORIES.slice(0, -1), "Instruction Following"].join("|"),
        table.labels.join("|"),
      );
      check("default sort is Global Average, highest first", table.sort[3] === "descending" && table.rows[0][1] === "claude-opus-5-5-xhigh-effort" && !orderProblem(table.rows.map((r) => r[3]), "number", "desc"), table.rows[0].join("|"));
      check("rank 1 is the top global average", table.rows[0][0] === "1");
      await page.screenshot({ path: path.join(shots, "livebench-classic.png") });

      await sortPass(page, check);

      const runnable = await page.locator(".lb-table tbody tr.runnable").count();
      check("rows GGO can run are highlighted", runnable >= 1, `${runnable} runnable rows`);
      const runnableTitle = await page.locator(".lb-table tbody tr.runnable .lb-col-model").first().getAttribute("title");
      check("the highlight names the local model it runs as", /runnable in GGO as claude:claude-opus-5-5/.test(runnableTitle ?? ""), runnableTitle);
      await page.click(".lb-chip");
      check("the runnable filter keeps only highlighted rows", (await page.locator(".lb-table tbody tr").count()) === runnable);
      await page.click(".lb-chip");
      await page.fill(".lb-search", "model-c");
      const filtered = (await readTable(page)).rows.map((r) => r[1]);
      check("the model filter narrows the rows", filtered.length > 0 && filtered.length < snapshot.rows.length && filtered.every((m) => m.includes("model-c")), filtered.slice(0, 5).join(","));
      await page.fill(".lb-search", "no-such-model-anywhere");
      check("an empty filter result says so", /No model matches/.test((await page.textContent(".lb-scroll")) ?? ""));
      await page.fill(".lb-search", "");

      const desk = await geometry(page);
      check("the header stays pinned while the body scrolls", Math.abs(desk.headerTopDelta) <= 1, JSON.stringify(desk));
      check("numeric cells are right-aligned tabular numbers", desk.numAlign === "right" && /tabular-nums/.test(desk.numeric), `${desk.numAlign} ${desk.numeric}`);
      check("no cursive or decorative face anywhere in the table", desk.fonts.every((f) => /Inter Tight|JetBrains Mono/.test(f) && !/cursive|script/i.test(f)), desk.fonts.join(" / "));

      await page.click('[data-settings-category="appearance"]');
      await page.click('.theme-option:has-text("Nocturne")');
      await page.waitForFunction(() => document.documentElement.dataset.theme === "nocturne", null, { timeout: 10_000 });
      await page.click('[data-settings-category="livebench"]');
      await page.waitForSelector(".lb-table tbody tr");
      const night = await geometry(page);
      check("Nocturne repaints the table from its own tokens", night.rowBg !== desk.rowBg, `${desk.rowBg} → ${night.rowBg}`);
      await page.waitForTimeout(400);
      await page.screenshot({ path: path.join(shots, "livebench-nocturne.png") });
      await page.click('[data-settings-category="appearance"]');
      await page.click('.theme-option:has-text("Classic")');
      check("no console errors on desktop", errors.length === 0, errors.join(" | "));
      await context.close();

      const phoneContext = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
      const phone = await phoneContext.newPage();
      await openRankings(phone, { phone: true });
      const narrow = await geometry(phone);
      check("a phone scrolls the table sideways instead of squashing it", narrow.scrollsX, JSON.stringify(narrow));
      check("rank and model stay pinned while the scores scroll sideways", Math.abs(narrow.rankPinned) <= 1 && Math.abs(narrow.modelPinned) <= 1, JSON.stringify(narrow));
      check("the header stays pinned on a phone too", Math.abs(narrow.headerTopDelta) <= 1, JSON.stringify(narrow));
      await phone.locator(".lb-table thead th").nth(4).locator("button").tap();
      check("a tap on a header sorts on touch", (await readTable(phone)).sort[4] === "descending");
      await phone.screenshot({ path: path.join(shots, "livebench-phone.png") });
      await phoneContext.close();
    } finally {
      await browser.close();
    }
  } finally {
    if (!keep) {
      killInstance(PORT);
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  }
  console.log(`screenshots: ${shots}`);
  process.exit(check.summary());
}

main().catch((err) => {
  console.error(err);
  killInstance(PORT);
  process.exit(1);
});
