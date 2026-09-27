// Drive the DIRECTOR pane at phone size — a real headless browser in a touch context, against a
// throwaway instance, without touching prod.
//
//   npm run director-phone-lab --prefix server
//   npm run director-phone-lab --prefix server -- --shots data/director-phone-shots
//   npm run director-phone-lab --prefix server -- --keep
//
// Why it exists (2026-09-27): the owner reported the Director tab on a Galaxy S21 (360×800 CSS px,
// DPR 3) as "very hard to see most of the things". The desktop rail was simply stacked into the
// phone pane: a two-row header of toggles, a repo-chip row, two mode switches, a task-mode row and
// the composer's six-control row all sat between the conversation and the keyboard, leaving the
// transcript a sliver. `phone-lab` only proves each board VIEW is reachable; nothing measured what
// the Director pane leaves for the conversation itself, nor whether its controls take a fingertip.
//
// It asserts, at every width in the phone band:
//   • the transcript keeps most of the pane — the conversation is the point of the tab;
//   • nothing in the pane scrolls sideways;
//   • every visible control in the header and the composer takes a 44px fingertip (WCAG 2.5.8);
//   • the composer's options live in a sheet that opens, shows every control, and closes again;
//   • the pane still sends: typing a prompt and tapping Send lands it in the transcript.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Database = require("better-sqlite3");
const { SERVER_ROOT, loadChromium, authPassword, requireBuild, requireFreshWebBuild, boot, killInstance, createChecks, shotDir } = require("./lab-harness.cjs");

// Clear of every sibling lab's port and its `port + 2` HTTPS listener.
const PORT = 4521;
const BASE = `http://127.0.0.1:${PORT}`;
const DEFAULT_WIDTHS = [320, 360, 390, 430];
const HEIGHT = 800;
const TAP_MIN = 44;
// Share of the pane (between top bar and bottom nav) the conversation must keep with the composer idle.
const TRANSCRIPT_SHARE = 0.55;

const check = createChecks();

async function openWhenMigrated(dataDir) {
  const file = path.join(dataDir, "orchestrator.sqlite");
  for (let i = 0; i < 40; i++) {
    try {
      const db = new Database(file);
      if (db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='director_messages'").get()) return db;
      db.close();
    } catch {
      /* not created yet */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`${file} never gained a schema — is something else on :${PORT}?`);
}

/** A realistic conversation: short asks, long markdown replies with a code block and a table, and tool
 *  rows — the shapes that overflow a narrow bubble. Plus five recent repos, which wrap on a phone. */
async function seed(dataDir) {
  const db = await openWhenMigrated(dataDir);
  const t0 = Date.now() - 3_600_000;
  const insert = db.prepare("INSERT INTO director_messages(id, role, kind, content, created_at) VALUES(?, ?, ?, ?, ?)");
  const rows = [
    ["user", "text", "The phone layout of the board is cramped, can you look at it?"],
    ["director", "tool", "search_memories · phone layout board"],
    ["director", "text", "Sure. I found two earlier notes about the board on phones:\n\n- the tab strip overflowed below 500px\n- the sort menu covered the last tab\n\nI'll dispatch a task with the repo path `web/src/components/Board.tsx` so it starts in the right place."],
    ["director", "tool", "dispatch_task · Fix phone board layout"],
    ["user", "text", "Also show me the current routing table please"],
    ["director", "text", "| Route | Planner | QA |\n|---|---|---|\n| narrow | no | no |\n| contained | no | yes |\n| broad | yes | yes |\n\n```ts\nconst route = selectRoute({ scope: \"broad\", risk: \"medium\", planner: true, qa: true });\n```\n\nThat's the table the router reads today."],
    ["user", "text", "ok thanks. Now start the nightly sweep"],
    ["director", "tool", "dispatch_task · Nightly quality sweep"],
    ["director", "text", "Dispatched the nightly sweep. It'll read the sweep rule first, run the gate suite, and report back on the board."],
  ];
  rows.forEach(([role, kind, content], i) => insert.run(`dpl-${i}`, role, kind, content, t0 + i * 60_000));
  const kv = db.prepare("INSERT INTO kv(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value");
  kv.run("setting_recent_repos", JSON.stringify(["/work/claude-orchestrator", "/work/graphql-api", "/work/summon-overlay", "/work/defend-your-castle", "/work/automation/script-hub"]));
  db.close();
}

// ---- in-page measurements ----------------------------------------------------------------------

function measurePane() {
  const r = (el) => (el ? el.getBoundingClientRect() : null);
  const rail = document.querySelector(".rail");
  const transcript = document.querySelector(".rail .transcript");
  const nav = document.querySelector(".mobile-nav");
  const railBox = r(rail);
  const navBox = r(nav);
  const paneBottom = navBox && navBox.height > 0 ? Math.min(railBox.bottom, navBox.top) : railBox.bottom;
  const sideways = [...rail.querySelectorAll("*")]
    .filter((el) => {
      const b = el.getBoundingClientRect();
      if (!b.width || !b.height) return false;
      // Anything inside a horizontal scroller is allowed to extend past the edge.
      for (let p = el.parentElement; p && p !== rail; p = p.parentElement) {
        const ox = getComputedStyle(p).overflowX;
        if (ox === "auto" || ox === "scroll" || ox === "hidden") return false;
      }
      return b.right > window.innerWidth + 1 || b.left < -1;
    })
    .slice(0, 5)
    .map((el) => `${el.tagName.toLowerCase()}.${[...el.classList].join(".")} [${Math.round(el.getBoundingClientRect().left)}..${Math.round(el.getBoundingClientRect().right)}]`);
  return {
    pane: Math.round(paneBottom - railBox.top),
    transcript: transcript ? Math.round(r(transcript).height) : 0,
    railScrollsX: rail.scrollWidth > rail.clientWidth + 1,
    docScrollsX: document.documentElement.scrollWidth > window.innerWidth + 1,
    sideways,
  };
}

/** Every visible, enabled control in the given root that is smaller than a fingertip. */
function smallTargets({ selector, min }) {
  const root = document.querySelector(selector);
  if (!root) return ["<root missing: " + selector + ">"];
  return [...root.querySelectorAll("button, select, input, textarea, [role=switch], a[href]")]
    .filter((el) => {
      const b = el.getBoundingClientRect();
      if (!b.width || !b.height) return false;
      const cs = getComputedStyle(el);
      if (cs.visibility === "hidden" || cs.display === "none") return false;
      // A <select> overlaid transparently on a labelled button is hit through that button's box.
      const hit = el.closest("label") ?? el;
      const hb = hit.getBoundingClientRect();
      return Math.min(hb.width, hb.height) < min - 0.5;
    })
    .map((el) => {
      const b = el.getBoundingClientRect();
      return `${el.tagName.toLowerCase()}${el.getAttribute("aria-label") ? `[${el.getAttribute("aria-label")}]` : "." + [...el.classList].join(".")} ${Math.round(b.width)}×${Math.round(b.height)}`;
    });
}

// ---- the drive -----------------------------------------------------------------------------------

async function openDirector(page) {
  await page.goto(BASE + "/");
  await page.waitForSelector(".accounts .acct", { state: "attached", timeout: 60_000 }).catch(() => {});
  await page.tap(".mobile-nav .mnav-btn:has-text('Director')");
  await page.waitForSelector(".rail .transcript .msg", { state: "visible", timeout: 15_000 });
  await page.waitForTimeout(300);
}

async function drivePass(page, width, shots) {
  console.log(`\n════ ${width}×${HEIGHT}`);
  await page.setViewportSize({ width, height: HEIGHT });
  await openDirector(page);
  await page.screenshot({ path: path.join(shots, `director-${width}-idle.png`) });

  const m = await page.evaluate(measurePane);
  check(`${width}: the conversation keeps ≥${Math.round(TRANSCRIPT_SHARE * 100)}% of the pane`, m.transcript >= m.pane * TRANSCRIPT_SHARE, `transcript ${m.transcript}px of a ${m.pane}px pane`);
  check(`${width}: nothing in the pane scrolls sideways`, !m.railScrollsX && !m.docScrollsX && m.sideways.length === 0, JSON.stringify(m));

  const headSmall = await page.evaluate(smallTargets, { selector: ".rail .rail-head", min: TAP_MIN });
  check(`${width}: every header control takes a fingertip`, headSmall.length === 0, headSmall.join(", "));
  const composerSmall = await page.evaluate(smallTargets, { selector: ".rail .composer", min: TAP_MIN });
  check(`${width}: every composer control takes a fingertip`, composerSmall.length === 0, composerSmall.join(", "));

  const field = await page.$eval(".rail .composer textarea", (t) => Math.round(t.getBoundingClientRect().height));
  check(`${width}: the empty message field is one line tall`, field <= TAP_MIN + 4, `${field}px`);

  await drivePipelineMenu(page, width, shots);
  await driveSearch(page, width);
  await driveOptionsSheet(page, width, shots);
  await driveSend(page, width, shots);
}

async function drivePipelineMenu(page, width, shots) {
  const toggle = page.locator(".rail .pipeline-menu-toggle");
  check(`${width}: the header folds the gates into one pipeline button`, (await toggle.count()) === 1 && (await page.locator(".rail .rail-head .agent-toggles").count()) === 0);
  if (!(await toggle.count())) return;
  await toggle.tap();
  const pop = await page.evaluate(() => {
    const el = document.querySelector(".rail .pipeline-menu-pop");
    if (!el) return null;
    const b = el.getBoundingClientRect();
    return { onScreen: b.left >= 0 && b.right <= window.innerWidth && b.top >= 0 && b.bottom <= window.innerHeight, gates: el.querySelectorAll(".agent-toggle").length };
  });
  check(`${width}: the pipeline menu opens fully on screen with three gates`, !!pop && pop.onScreen && pop.gates === 3, JSON.stringify(pop));
  await page.screenshot({ path: path.join(shots, `director-${width}-pipeline.png`) });
  const popSmall = await page.evaluate(smallTargets, { selector: ".rail .pipeline-menu-pop", min: TAP_MIN });
  check(`${width}: every pipeline gate takes a fingertip`, popSmall.length === 0, popSmall.join(", "));
  const qa = page.locator(".rail .pipeline-menu-pop .agent-toggle", { hasText: "QA" });
  const before = await qa.getAttribute("aria-pressed");
  await qa.tap();
  const flipped = await page.locator(".rail .pipeline-menu-pop .agent-toggle", { hasText: "QA" }).getAttribute("aria-pressed");
  const dotFlipped = await page.$$eval(".rail .pipeline-menu-toggle .pipeline-dot", (d) => d[2]?.classList.contains("on"));
  check(`${width}: tapping a gate flips it, and the header dot follows`, before !== flipped && String(dotFlipped) === flipped, `before=${before} after=${flipped} dot=${dotFlipped}`);
  await qa.tap();
  const clear = await page.$eval(".rail .transcript", (t) => { const b = t.getBoundingClientRect(); return { x: b.left + 16, y: b.bottom - 16 }; });
  await page.touchscreen.tap(clear.x, clear.y);
  check(`${width}: a tap outside closes the pipeline menu`, (await page.$(".rail .pipeline-menu-pop")) === null);
}

async function driveSearch(page, width) {
  check(`${width}: the closed search costs no row of its own`, (await page.$(".rail > .rail-search")) === null);
  await page.tap(".rail .rail-head .rail-search-toggle");
  const focused = await page
    .waitForFunction(() => document.activeElement?.classList.contains("rail-search-input"), null, { timeout: 3000 })
    .then(() => true)
    .catch(() => false);
  check(`${width}: the header search icon opens a focused search field`, focused);
  await page.tap(".rail .rail-search-collapse");
  check(`${width}: collapsing search hands the row back`, (await page.$(".rail > .rail-search")) === null && (await page.$(".rail .rail-head .rail-search-toggle")) !== null);
}

async function driveOptionsSheet(page, width, shots) {
  const toggle = page.locator(".rail .composer-options-toggle");
  check(`${width}: the composer offers an options button`, (await toggle.count()) === 1);
  if (!(await toggle.count())) return;
  await toggle.tap();
  const sheet = page.locator(".rail .composer-options");
  await sheet.waitFor({ state: "visible", timeout: 5000 }).catch(() => {});
  await page.screenshot({ path: path.join(shots, `director-${width}-options.png`) });
  const inside = await page.evaluate(() => {
    const sheet = document.querySelector(".rail .composer-options");
    if (!sheet) return { visible: false };
    const b = sheet.getBoundingClientRect();
    const labels = ["Skip director", "Default mode", "Recent repositories"].map((name) => {
      const el = [...sheet.querySelectorAll("button, [role=group]")].find((e) => (e.getAttribute("aria-label") || e.textContent || "").includes(name));
      if (!el) return { name, ok: false };
      const eb = el.getBoundingClientRect();
      return { name, ok: eb.width > 0 && eb.top >= 0 && eb.bottom <= window.innerHeight };
    });
    return { visible: b.height > 0, top: b.top, bottom: b.bottom, labels };
  });
  check(`${width}: tapping options opens the sheet`, inside.visible, JSON.stringify(inside));
  for (const l of inside.labels ?? []) check(`${width}: "${l.name}" is on screen in the sheet`, l.ok);
  const sheetSmall = await page.evaluate(smallTargets, { selector: ".rail .composer-options", min: TAP_MIN });
  check(`${width}: every sheet control takes a fingertip`, sheetSmall.length === 0, sheetSmall.join(", "));
  await toggle.tap();
  const closed = await page.evaluate(() => {
    const el = document.querySelector(".rail .composer-options");
    return !el || el.getBoundingClientRect().height === 0;
  });
  check(`${width}: tapping options again closes the sheet`, closed);
}

async function driveSend(page, width, shots) {
  const prompt = `lab prompt at ${width}px`;
  await page.tap(".rail .composer textarea");
  await page.fill(".rail .composer textarea", prompt);
  await page.tap(".rail .composer .composer-send");
  const landed = await page
    .waitForFunction((p) => [...document.querySelectorAll(".rail .transcript .msg.user .bubble")].some((b) => b.textContent.includes(p)), prompt, { timeout: 10_000 })
    .then(() => true)
    .catch(() => false);
  check(`${width}: Send lands the prompt in the transcript`, landed);
  const visible = await page.evaluate((p) => {
    const b = [...document.querySelectorAll(".rail .transcript .msg.user .bubble")].find((x) => x.textContent.includes(p));
    const t = document.querySelector(".rail .transcript").getBoundingClientRect();
    if (!b) return false;
    const bb = b.getBoundingClientRect();
    return bb.bottom <= t.bottom + 1 && bb.top >= t.top - 1;
  }, prompt);
  check(`${width}: the sent prompt is scrolled into view`, visible);
  await page.screenshot({ path: path.join(shots, `director-${width}-sent.png`) });
}

async function rmWithRetry(dir) {
  for (let i = 0; ; i++) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      return;
    } catch (e) {
      if (i === 19) return void console.log(`\n  (temp dir left behind — ${e.code}: ${dir})`);
      await new Promise((r) => setTimeout(r, 250));
    }
  }
}

function parseWidths() {
  const i = process.argv.indexOf("--widths");
  if (i < 0) return DEFAULT_WIDTHS;
  const list = (process.argv[i + 1] || "").split(",").map((s) => parseInt(s.trim(), 10)).filter((n) => n > 0);
  return list.length ? list : DEFAULT_WIDTHS;
}

(async () => {
  const keep = process.argv.includes("--keep");
  requireBuild();
  requireFreshWebBuild();
  killInstance(PORT);
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "director-phone-lab-"));
  const shots = shotDir(dataDir);
  let browser;
  try {
    await boot({ dataDir, port: PORT });
    await seed(dataDir);
    killInstance(PORT);
    await boot({ dataDir, port: PORT });

    browser = await loadChromium().launch();
    const ctx = await browser.newContext({ viewport: { width: 360, height: HEIGHT }, hasTouch: true, isMobile: true, deviceScaleFactor: 3 });
    try {
      const page = await ctx.newPage();
      await page.request.post(`${BASE}/api/login`, { data: { password: authPassword() } });
      for (const w of parseWidths()) await drivePass(page, w, shots);
    } finally {
      await ctx.close();
    }
  } finally {
    if (browser) await browser.close().catch(() => {});
    if (!keep) {
      killInstance(PORT);
      await rmWithRetry(dataDir);
    } else {
      console.log(`\n  instance: ${BASE}  (data: ${dataDir})`);
    }
  }
  console.log(`\n  screenshots: ${shots}`);
  process.exit(check.summary());
})().catch((e) => {
  console.error(e);
  killInstance(PORT);
  process.exit(1);
});
