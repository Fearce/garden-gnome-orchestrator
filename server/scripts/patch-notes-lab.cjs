// Lab for the Patch notes board area (`npm run patch-notes-lab`). `test:patch-notes` proves the git read
// against a fixture repo; this proves the console: the tab's "new to you" count agrees with the commits
// above the last-seen one, opening the area records them as seen, the filters and the internal toggle
// show exactly the rows they claim, a commit body expands, paging loads older changes, the next-update
// section appears exactly when the upstream is ahead, and a phone reaches the area through the
// All-areas picker without the page scrolling sideways, and a busy day (5+ operator-facing changes)
// that has ended opens with its digest — asked of the server with exactly that day's shas, shown only in
// Everything — while today gets none until the browser's clock passes midnight.
//
// The throwaway instance reads THIS checkout's real history (the server reads the repo it runs from),
// so every expectation is computed from `git log` at run time rather than hard-coded.
//
// Uncommitted work: build isolated copies first —
//   (server) npx tsc -p tsconfig.json --outDir .patch-notes-lab-dist
//   (web)    npx vite build --outDir ../server/.lab-web-dist-patchnotes --emptyOutDir
// then run with GGO_LAB_ENTRY=.patch-notes-lab-dist/index.js GGO_LAB_WEB_DIST=.lab-web-dist-patchnotes.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { loadChromium, authPassword, requireBuild, boot, killInstance, createChecks, shotDir } = require("./lab-harness.cjs");

// GGO_LAB_PORT moves the lab off 4391 when another task's dev server already holds it (the lab kills its port).
const PORT = Number(process.env.GGO_LAB_PORT) || 4391;
const REPO = path.resolve(__dirname, "..", "..");
const SEEN_KEY = "ggo.patchNotesSeen";
const INTERNAL = new Set(["docs", "test", "tests", "chore", "refactor", "style", "build", "ci"]);
const check = createChecks();

function git(...args) {
  return execFileSync("git", ["-C", REPO, ...args], { encoding: "utf8", windowsHide: true }).trim();
}

/** The first page's commits as the server classifies them: sha, operator-facing summary, internal flag. */
function history(count) {
  return git("log", "--no-merges", `--max-count=${count}`, "--format=%H%x1f%s")
    .split("\n")
    .map((line) => {
      const [sha, subject] = line.split("\x1f");
      const m = /^([a-z]+)(?:\([^)]*\))?!?:\s*(.+)$/i.exec(subject);
      const summary = m ? m[2].trim() : subject.trim();
      return { sha, internal: !!m && INTERNAL.has(m[1].toLowerCase()), summary: summary.charAt(0).toUpperCase() + summary.slice(1) };
    });
}

function upstreamAhead() {
  try {
    return Number(git("rev-list", "--no-merges", "--count", "HEAD..@{u}")) || 0;
  } catch {
    return 0;
  }
}

async function rows(page) {
  return page.evaluate(() =>
    [...document.querySelectorAll(".pn-day .pn-row")].map((li) => ({
      kind: [...li.classList].find((c) => c.startsWith("k-")),
      summary: (li.querySelector(".pn-summary")?.textContent ?? "").trim(),
      isNew: !!li.querySelector(".pn-flag.new"),
    })),
  );
}

async function waitForRows(page) {
  await page.waitForFunction(() => document.querySelectorAll(".pn-day .pn-row").length > 0, null, { timeout: 30000 });
}

async function desktopPass(browser, dataDir, expectedNew, seenSha, local) {
  const ctx = await browser.newContext({ viewport: { width: 1500, height: 950 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  // The lab's bogus account token makes every real digest a 502; digestPass covers digests on their own.
  await ctx.route("**/api/patch-notes/digest", (route) => route.fulfill({ json: { summary: "Lab digest." } }));
  // Seed before the app boots: its first-visit branch records HEAD as seen when the key is missing, and
  // would overwrite a seed written after load. This pass never reloads, so the script runs once.
  await ctx.addInitScript(([key, sha]) => localStorage.setItem(key, sha), [SEEN_KEY, seenSha]);
  await page.request.post(`http://127.0.0.1:${PORT}/api/login`, { data: { password: authPassword() } });
  await page.goto(`http://127.0.0.1:${PORT}/`, { timeout: 60000 });
  await page.waitForSelector(".accounts .acct", { state: "attached", timeout: 60000 });

  const tab = '.board-tab:has-text("Patch notes")';
  try {
    await page.waitForSelector(`${tab} .board-tab-count`, { timeout: 30000 });
  } catch {
    /* reported below */
  }
  const badge = ((await page.textContent(`${tab} .board-tab-count`).catch(() => "")) ?? "").trim();
  check("the tab counts the operator-facing commits above the last-seen one", badge === String(expectedNew), `badge "${badge}", expected ${expectedNew}`);

  await page.click(tab);
  await page.waitForSelector(".pn-view", { timeout: 15000 });
  await waitForRows(page);
  let list = await rows(page);
  const firstFacing = local.find((c) => !c.internal);
  check("newest operator-facing change is listed first", list[0]?.summary === firstFacing.summary, `${list[0]?.summary} vs ${firstFacing.summary}`);
  check("internal commits are hidden by default", list.every((r) => r.kind !== "k-internal"));
  check("rows above the last-seen commit are flagged new to you", list.filter((r) => r.isNew).length === expectedNew, `${list.filter((r) => r.isNew).length} flagged`);
  // The view marks HEAD seen once its own refresh lands, which can be after the rows first paint.
  const head = git("rev-parse", "HEAD");
  await page.waitForFunction(([key, sha]) => localStorage.getItem(key) === sha, [SEEN_KEY, head], { timeout: 15000 }).catch(() => {});
  const seenNow = await page.evaluate((key) => localStorage.getItem(key), SEEN_KEY);
  check("opening the area records HEAD as seen", seenNow === head, `${seenNow} vs ${head}`);

  const ahead = upstreamAhead();
  const upcoming = await page.$(".pn-upcoming");
  check("the next-update section shows exactly when the upstream is ahead", ahead > 0 ? !!upcoming : !upcoming, `ahead ${ahead}`);
  await page.screenshot({ path: path.join(shotDir(dataDir), "patch-notes-desktop.png") });

  await page.click(".pn-internal input");
  list = await rows(page);
  const internalLoaded = local.filter((c) => c.internal).length;
  check("the internal toggle reveals the docs/test/chore commits", list.filter((r) => r.kind === "k-internal").length === internalLoaded, `${list.filter((r) => r.kind === "k-internal").length} vs ${internalLoaded}`);
  await page.click(".pn-internal input");

  await page.click('.pn-filter:has-text("Fixed")');
  list = await rows(page);
  check("the Fixed filter shows only fixes", list.length > 0 && list.every((r) => r.kind === "k-fix"), JSON.stringify(list.slice(0, 3)));
  await page.click('.pn-filter:has-text("Everything")');

  const expandable = page.locator(".pn-day .pn-summary:not([disabled])").first();
  await expandable.click();
  const body = await page.waitForSelector(".pn-day .pn-row.open .pn-body p", { timeout: 5000 }).catch(() => null);
  check("clicking a change with a body expands it", !!body);
  const trailer = await page.evaluate(() => [...document.querySelectorAll(".pn-body")].some((b) => /co-authored-by/i.test(b.textContent ?? "")));
  check("commit trailers never reach the notes", !trailer);

  const before = (await page.$$(".pn-day .pn-row")).length;
  await page.click('.pn-more button:has-text("Show older changes")');
  await page.waitForFunction((n) => document.querySelectorAll(".pn-day .pn-row").length > n, before, { timeout: 30000 }).catch(() => {});
  const after = (await page.$$(".pn-day .pn-row")).length;
  check("Show older changes loads the next page", after > before, `${before} -> ${after}`);

  await page.click('.board-tab:has-text("Tasks")');
  const stale = await page.$(`${tab} .board-tab-count`);
  check("after a visit the tab no longer counts anything as new", stale === null);

  check("no console errors", errors.length === 0, errors.join(" | "));
  await ctx.close();
}

async function phonePass(browser, dataDir) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  await page.request.post(`http://127.0.0.1:${PORT}/api/login`, { data: { password: authPassword() } });
  await page.goto(`http://127.0.0.1:${PORT}/`, { timeout: 60000 });
  await page.waitForSelector(".accounts .acct", { state: "attached", timeout: 60000 });
  await page.selectOption('.mobile-nav select[aria-label="All areas"]', "patchnotes");
  await page.waitForSelector(".pn-view", { state: "visible", timeout: 15000 });
  await waitForRows(page);
  const layout = await page.evaluate(() => {
    const row = document.querySelector(".pn-day .pn-row");
    const r = row.getBoundingClientRect();
    return { scrollW: document.documentElement.scrollWidth, innerW: window.innerWidth, rowRight: r.right, rowLeft: r.left };
  });
  check("a phone reaches Patch notes from the All-areas picker", true);
  check("the phone layout never scrolls sideways", layout.scrollW <= layout.innerW && layout.rowRight <= layout.innerW && layout.rowLeft >= 0, JSON.stringify(layout));
  await page.screenshot({ path: path.join(shotDir(dataDir), "patch-notes-phone.png") });
  await ctx.close();
}

/** The browser's local date for epoch ms, keyed like the view's `localDay` (the lab browser shares this
 *  machine's timezone). */
function localDay(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** The first page's commits grouped by local day, newest first, each with its operator-facing shas. */
function daysOf(count) {
  const commits = git("log", "--no-merges", `--max-count=${count}`, "--format=%H%x1f%ct%x1f%s")
    .split("\n")
    .map((line) => {
      const [sha, seconds, subject] = line.split("\x1f");
      const m = /^([a-z]+)(?:\([^)]*\))?!?:/i.exec(subject);
      return { sha, day: localDay(Number(seconds) * 1000), internal: !!m && INTERNAL.has(m[1].toLowerCase()) };
    });
  const days = [];
  for (const c of commits) {
    if (days.at(-1)?.day !== c.day) days.push({ day: c.day, facing: [] });
    if (!c.internal) days.at(-1).facing.push(c.sha);
  }
  return days.map((d) => ({ ...d, busy: d.facing.length >= 5 }));
}

/** The client extends the first page through its last local day. */
function initialCount() {
  const times = git("log", "--no-merges", "--format=%ct").split("\n").map((s) => Number(s) * 1000);
  let count = Math.min(150, times.length);
  while (count < times.length && localDay(times[count]) === localDay(times[count - 1])) count++;
  return count;
}

/** Busy days that have ended, including the automatically completed page boundary. */
function busyPastDays(count) {
  const today = localDay(Date.now());
  return daysOf(count)
    .filter((d) => d.busy && d.day < today);
}

const sortedKey = (shas) => [...shas].sort().join(",");

/** The group headed `label`: how many rows it shows and its digest text, if any. */
async function groupNamed(page, label) {
  return page.$$eval(
    ".pn-day",
    (els, wanted) => {
      const el = els.find((d) => d.querySelector(".pn-day-head")?.textContent?.trim() === wanted);
      return { rows: el ? el.querySelectorAll(".pn-row").length : 0, digest: el?.querySelector(".pn-digest")?.textContent?.trim() ?? null };
    },
    label,
  );
}

/** The digest endpoint is stubbed: the lab proves what the view asks for and how it shows the answer, not
 *  what Haiku writes (test:patch-notes proves the server side against a fixture repo). The first ask is
 *  held to see the loading line; the second fails, and its day must fall back to plain bullets. */
async function digestPass(browser, dataDir) {
  const busy = busyPastDays(initialCount());
  const todayDay = daysOf(initialCount()).find((d) => d.day === localDay(Date.now()));
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  const asked = [];
  let release;
  const held = new Promise((r) => (release = r));
  await page.route("**/api/patch-notes/digest", async (route) => {
    const ask = route.request().postDataJSON();
    asked.push(ask);
    const ordinal = asked.length;
    if (ordinal === 1) await held;
    if (ordinal === 2) return route.fulfill({ status: 502, json: { error: "the summary model gave no usable answer" } });
    await route.fulfill({ json: { summary: `Lab digest of ${ask.shas.length} changes.` } });
  });
  await page.request.post(`http://127.0.0.1:${PORT}/api/login`, { data: { password: authPassword() } });
  await page.goto(`http://127.0.0.1:${PORT}/`, { timeout: 60000 });
  await page.waitForSelector(".accounts .acct", { state: "attached", timeout: 60000 });
  await page.click('.board-tab:has-text("Patch notes")');
  await waitForRows(page);
  if (busy.length < 2) {
    check("busy-day digests need two ended busy days in the loaded history to exercise", false, `${busy.length} busy days`);
    release();
    await ctx.close();
    return;
  }
  const loading = await page.waitForSelector(".pn-digest.loading", { timeout: 10000 }).catch(() => null);
  check("a busy day shows that its digest is being written", !!loading && /Summarizing \d+ changes/.test((await loading.textContent()) ?? ""));
  release();
  await page.waitForFunction((n) => document.querySelectorAll(".pn-digest:not(.loading)").length >= n, busy.length - 1, { timeout: 15000 }).catch(() => {});

  const expected = new Map(busy.map((d) => [sortedKey(d.facing), d.day]));
  const timeZone = await page.evaluate(() => Intl.DateTimeFormat().resolvedOptions().timeZone);
  check(
    "the view asks once per ended busy day, naming the day and timezone, with exactly that day's operator-facing shas",
    asked.length === busy.length && asked.every((a) => expected.get(sortedKey(a.shas)) === a.day && a.timeZone === timeZone),
    `${asked.length} asks for ${busy.length} busy days: ${JSON.stringify(asked.map((a) => [a.day, a.timeZone, a.shas.length]))}`,
  );
  const shown = await page.$$eval(".pn-day", (els) => els.map((el) => el.querySelector(".pn-digest")?.textContent?.trim() ?? null));
  const withDigest = shown.filter(Boolean);
  check(
    "every ended busy day opens with its digest except the failed one; quiet days have none",
    withDigest.length === busy.length - 1 && withDigest.every((t) => /^Lab digest of \d+ changes\.$/.test(t)),
    JSON.stringify(shown.slice(0, 8)),
  );
  const todayGroup = await groupNamed(page, "Today");
  check(
    `today${todayDay ? ` (${todayDay.facing.length} operator-facing changes)` : ""} shows its bullets with no digest and is never asked about`,
    (!todayDay || todayDay.facing.length === 0 || todayGroup.rows > 0) && !todayGroup.digest && !asked.some((a) => a.day === todayDay?.day),
    JSON.stringify(todayGroup),
  );
  const first = await page.$(".pn-day:has(.pn-digest)");
  if (first) await first.screenshot({ path: path.join(shotDir(dataDir), "patch-notes-digest.png") });

  await page.click('.pn-filter:has-text("Fixed")');
  check("a filtered view drops the digest, which covers every kind", (await page.$$(".pn-digest")).length === 0);
  await page.click('.pn-filter:has-text("Everything")');
  const asksBefore = asked.length;
  await page.click('.board-tab:has-text("Tasks")');
  await page.click('.board-tab:has-text("Patch notes")');
  await waitForRows(page);
  check("reopening the area does not ask again", asked.length === asksBefore, `${asked.length} vs ${asksBefore}`);
  await page.unrouteAll({ behavior: "ignoreErrors" });
  await ctx.close();
}

/** Reproduce a busy Sunday split across several API pages without clicking Show older changes. */
async function boundaryPass(browser) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, timezoneId: "Europe/Copenhagen" });
  const page = await ctx.newPage();
  await page.clock.install({ time: new Date("2026-10-04T12:00:00Z") });
  const template = { short: "abcdef0", kind: "fix", type: "fix", scope: null, breaking: false, body: "" };
  const notes = Array.from({ length: 7 }, (_, i) => ({ ...template, sha: String(i + 1).padStart(40, "0"), summary: `Boundary change ${i + 1}`, at: Date.parse(i < 6 ? "2026-10-04T12:00:00Z" : "2026-10-03T12:00:00Z") }));
  const reads = [];
  const asked = [];
  await page.route("**/api/patch-notes?*", (route) => {
    const skip = Number(new URL(route.request().url()).searchParams.get("skip"));
    reads.push(skip);
    const entries = notes.slice(skip, skip + 2);
    return route.fulfill({ json: { head: notes[0].sha, running: notes[0].sha, pending: [], upcoming: [], entries, hasMore: skip + entries.length < notes.length, error: null } });
  });
  await page.route("**/api/patch-notes/digest", (route) => {
    asked.push(route.request().postDataJSON());
    return route.fulfill({ json: { summary: "Sunday's complete summary." } });
  });
  await page.request.post(`http://127.0.0.1:${PORT}/api/login`, { data: { password: authPassword() } });
  await page.goto(`http://127.0.0.1:${PORT}/`, { timeout: 60000 });
  await page.waitForSelector(".accounts .acct", { state: "attached", timeout: 60000 });
  await page.click('.board-tab:has-text("Patch notes")');
  await page.waitForFunction(() => document.querySelectorAll(".pn-day .pn-row").length === 6);
  check("a completed page of today's changes remains unsummarized", asked.length === 0 && await page.locator(".pn-digest").count() === 0);
  await page.clock.fastForward(48 * 60 * 60 * 1000);
  await page.waitForSelector(".pn-digest:not(.loading)", { timeout: 15000 });
  const overview = page.locator(".pn-digest:not(.loading)");
  await overview.scrollIntoViewIfNeeded();
  const box = await overview.boundingBox();
  check("Sunday's restored overview is visible in the browser viewport", box && box.height > 0 && box.y >= 0 && box.y + box.height <= 900);
  check("a Sunday split over multiple pages shows its complete summary automatically", asked.length === 1 && asked[0].day === "2026-10-04" && sortedKey(asked[0].shas) === sortedKey(notes.slice(0, 6).map((n) => n.sha)) && await page.locator(".pn-day .pn-row").count() === 6, JSON.stringify({ reads, asked }));
  check("automatic completion stops at Sunday's boundary and keeps older changes available", reads.includes(2) && reads.includes(4) && reads.includes(6) && await page.locator(".pn-more button").isVisible());
  await page.click(".pn-more button");
  await page.waitForFunction(() => document.querySelectorAll(".pn-day .pn-row").length === 7);
  check("manual older paging resumes at the completed day without duplicates or omissions", await page.locator(".pn-day .pn-row").count() === 7 && await page.locator(".pn-more button").count() === 0);
  await ctx.close();
}

/** The console left open past midnight: today's group turns into "Yesterday" and is summarized then,
 *  with no reload. The browser's clock is faked so the lab need not wait for a real midnight. */
async function rolloverPass(browser, dataDir) {
  const today = daysOf(initialCount()).find((d) => d.day === localDay(Date.now()));
  if (!today?.busy) {
    console.log(`  (rollover pass skipped: today has ${today?.facing.length ?? 0} operator-facing changes, a digest needs 5)`);
    return;
  }
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  await page.clock.install({ time: Date.now() });
  const asked = [];
  await page.route("**/api/patch-notes/digest", async (route) => {
    const ask = route.request().postDataJSON();
    asked.push(ask);
    await route.fulfill({ json: { summary: `Lab digest of ${ask.day}.` } });
  });
  await page.request.post(`http://127.0.0.1:${PORT}/api/login`, { data: { password: authPassword() } });
  await page.goto(`http://127.0.0.1:${PORT}/`, { timeout: 60000 });
  await page.waitForSelector(".accounts .acct", { state: "attached", timeout: 60000 });
  await page.click('.board-tab:has-text("Patch notes")');
  await waitForRows(page);
  const before = await groupNamed(page, "Today");
  check("before midnight today's busy group has no digest", before.rows > 0 && !before.digest && !asked.some((a) => a.day === today.day), JSON.stringify(before));

  const untilMidnight = await page.evaluate(() => {
    const d = new Date();
    return new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime() - d.getTime();
  });
  await page.clock.fastForward(untilMidnight + 2000);
  await page
    .waitForFunction(() => [...document.querySelectorAll(".pn-day")].some((g) => g.querySelector(".pn-day-head")?.textContent?.trim() === "Yesterday" && g.querySelector(".pn-digest:not(.loading)")), null, { timeout: 15000 })
    .catch(() => {});
  const asks = asked.filter((a) => a.day === today.day);
  check("after midnight the same page asks once for the day that just ended, with all its changes", asks.length === 1 && sortedKey(asks[0].shas) === sortedKey(today.facing), JSON.stringify(asked.map((a) => [a.day, a.shas.length])));
  const after = await groupNamed(page, "Yesterday");
  check("...and that day, now headed Yesterday, opens with its digest", after.digest === `Lab digest of ${today.day}.`, JSON.stringify(after));
  await page.screenshot({ path: path.join(shotDir(dataDir), "patch-notes-after-midnight.png") });
  await page.unrouteAll({ behavior: "ignoreErrors" });
  await ctx.close();
}

/** The next-update section, with the upstream's commits injected into the response: this checkout is
 *  usually level with its upstream, and a lab must never make the real repo fall behind to see it. Its
 *  Update button is deliberately NOT clicked — on this instance it would pull the real checkout. */
async function upcomingPass(browser, dataDir) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  const now = Date.now();
  let pendingSummary = null;
  const note = (sha, kind, type, summary) => ({ sha: sha.repeat(40).slice(0, 40), short: sha.repeat(7).slice(0, 7), at: now, kind, type, scope: "web", breaking: false, summary, body: "" });
  await page.route("**/api/patch-notes?skip=0", async (route) => {
    const res = await route.fetch();
    const json = await res.json();
    json.upcoming = [note("a", "feature", "feat", "Upstream feature for the lab"), note("b", "internal", "docs", "Upstream docs for the lab")];
    // "Not live yet" is whatever the server lists as pending — never inferred from row order in the view.
    const target = json.entries.find((e) => e.kind !== "internal");
    pendingSummary = target?.summary ?? null;
    json.pending = target ? [target.sha] : [];
    await route.fulfill({ response: res, json });
  });
  await page.request.post(`http://127.0.0.1:${PORT}/api/login`, { data: { password: authPassword() } });
  await page.goto(`http://127.0.0.1:${PORT}/`, { timeout: 60000 });
  await page.waitForSelector(".accounts .acct", { state: "attached", timeout: 60000 });
  await page.click('.board-tab:has-text("Patch notes")');
  const section = await page.waitForSelector(".pn-upcoming", { timeout: 15000 }).catch(() => null);
  check("upstream commits render as the next update", !!section);
  if (section) {
    const summaries = await page.$$eval(".pn-upcoming .pn-summary", (els) => els.map((e) => e.textContent.trim()));
    check("...listing its operator-facing changes only", summaries.length === 1 && summaries[0] === "Upstream feature for the lab", JSON.stringify(summaries));
    const sub = (await page.textContent(".pn-upcoming-head .pn-upcoming-sub")) ?? "";
    check("...and saying how many commits and how many internal ones it left out", /2 commits upstream/.test(sub) && /1 internal not listed/.test(sub), sub);
    check("...with the update action one click away", await page.isVisible('.pn-upcoming button:has-text("Update now")'));
    await section.screenshot({ path: path.join(shotDir(dataDir), "patch-notes-upcoming.png") });
  }
  await waitForRows(page);
  const flagged = await page.$$eval(".pn-day .pn-row:has(.pn-flag.pending) .pn-summary", (els) => els.map((e) => e.textContent.trim()));
  check("\"Not live yet\" marks exactly the commits the server lists as pending", flagged.length === 1 && flagged[0] === pendingSummary, JSON.stringify(flagged));
  // A refresh can still be inside route.fetch when the context closes; unhandled, that rejection kills the lab.
  await page.unrouteAll({ behavior: "ignoreErrors" });
  await ctx.close();
}

(async () => {
  requireBuild();
  const local = history(initialCount());
  // Mark the 8th-newest commit as last seen, so the seven above it are "new" in the ways that count.
  const seenIdx = Math.min(7, local.length - 1);
  const expectedNew = local.slice(0, seenIdx).filter((c) => !c.internal).length;
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "patch-notes-lab-"));
  killInstance(PORT);
  const child = await boot({ dataDir, port: PORT });
  let code = 1;
  try {
    const browser = await loadChromium().launch();
    await desktopPass(browser, dataDir, expectedNew, local[seenIdx].sha, local);
    await upcomingPass(browser, dataDir);
    await digestPass(browser, dataDir);
    await boundaryPass(browser);
    await rolloverPass(browser, dataDir);
    await phonePass(browser, dataDir);
    await browser.close();
    console.log(`\nscreenshots: ${shotDir(dataDir)}`);
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
