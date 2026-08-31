// Drive the SUPERVISOR pane the way a phone does — a real headless browser in a touch context at the
// portrait widths Kevin actually holds — against a throwaway instance, without touching prod.
//
//   npm run supervisor-lab --prefix server
//   npm run supervisor-lab --prefix server -- --keep     (leave the instance up to poke at)
//   npm run supervisor-lab --prefix server -- --shot <dir>   (save a screenshot per width)
//
// Why this exists beside `tablet-lab`: the tablet lab's narrowest pass is 800px, which is inside the
// same compact band but wide enough that every row it measures still fits. A 360px phone is where the
// band's rows actually run out of width — the board's tab row and the Supervisor toolbar overflow there
// and nowhere else. The Supervisor tab shipped reachable from the bottom nav (c4f503b) onto a board
// whose tab strip painted OUTSIDE its header, gave the whole board a horizontal scrollbar, and let
// `.board-head-right` swallow the taps aimed at the Supervisor tab.
//
// The two things it proves, at every width:
//   1. LAYOUT — nothing is wider than the screen, every primary control is inside the viewport, and
//      every one of them wins its own hit test (a control that is *painted* on screen but covered by an
//      overlapping sibling is the exact defect above, and geometry alone cannot see it).
//   2. THE MANUAL SWEEP, end to end over the real WS API — with today's automated check-in budget
//      deliberately seeded as spent, "Run now" must still examine every eligible task instead of
//      skipping them, and the console must say so.
//
// Scope: this lab owns the SUPERVISOR surface. `phone-lab.cjs` is the sibling that sweeps every board
// view for reachability at the same widths; the one board-tab hit test kept below is the direct symptom
// of the overflow this lab's CSS fix removes, not a second copy of that sweep.
//
// Why it can't disturb anything: temp DATA_DIR (prod's sqlite is never opened, and its thread rows are
// parked in `review`, so the on-boot auto-resume has nothing to revive), bogus account tokens (the boot
// ping can neither burn quota nor start a real 5h window), alt port, killed by port owner.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Database = require("better-sqlite3");
const { SERVER_ROOT, loadChromium, authPassword, requireBuild, boot, killInstance, createChecks } = require("./lab-harness.cjs");

// 4361 (+4363 for the HTTPS listener boot() also binds) — clear of every other lab's port. A collision
// is not a loud failure: boot() resolves against the OTHER instance's /api/me, and the seed then writes
// to a database nothing is serving, which surfaces as an empty board rather than as a port clash.
const PORT = 4361;
const BASE = `http://127.0.0.1:${PORT}`;

// A fingertip is ~9mm. 44px is the WCAG 2.5.8 / Android floor, and --tap in styles.css.
const TAP_MIN = 44;
// One manual run can perform several sequential provider-backed checks. In the lab those fail through
// bogus credentials, but each failure can still spend backend startup/failover time before it reports.
const MANUAL_SWEEP_TIMEOUT_MS = 180_000;

/** The portrait CSS viewports this lab measures. 360×800 is Kevin's own screenshot (a 1080×2400 Android
 *  panel at dpr 3, minus browser chrome); the rest are the other common Android/iOS portrait widths, and
 *  320 is the narrowest viewport the web still gets asked to render. */
const WIDTHS = [
  { name: "320 (smallest phone)", width: 320, height: 720 },
  { name: "360 (Kevin's screenshot)", width: 360, height: 740 },
  { name: "390 (iPhone class)", width: 390, height: 844 },
  { name: "412 (large Android)", width: 412, height: 915 },
  { name: "430 (Pro Max class)", width: 430, height: 932 },
];

const ACCOUNT_ENV = {
  ACCOUNT_1_ID: "acct1",
  ACCOUNT_1_LABEL: "personal",
  ACCOUNT_2_ID: "acct2",
  ACCOUNT_2_LABEL: "vota",
};

/** The board tabs, by the label the switcher renders. Every one of them has to be reachable with a
 *  finger — the Supervisor tab was not, and Scheduled Tasks was one sort-menu pixel from the same fate. */
const BOARD_TABS = ["Tasks", "Notes", "Scheduled Tasks", "Supervisor"];

const DAY_START = (() => {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
})();

/** Two tasks parked in `review` long enough to be genuinely eligible for a supervisor check-in, an
 *  exhausted daily check-in budget, and enough audit rows for the panel to have a real list to lay out.
 *  The budget is the point: "Run now" must still inspect the tasks, while model-backed check-ins remain
 *  budgeted and the result names that limitation. */
function seed(dataDir) {
  const db = new Database(path.join(dataDir, "orchestrator.sqlite"));
  const now = Date.now();
  const kv = db.prepare("INSERT INTO kv(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value");
  for (const [id, fiveHour] of [["acct1", 1], ["acct2", 0]]) {
    kv.run(
      `account_usage_${id}`,
      JSON.stringify({
        holdUntil: null, extWakeAt: null, fiveHour, sevenDay: 89,
        fiveHourReset: now + 2.5 * 3_600_000, sevenDayReset: now + 4 * 86_400_000, usageAt: now - 60_000,
      }),
    );
  }
  kv.run("setting_director_supervisor_enabled", "1");

  // Long, realistic titles: a two-word title wraps to one line and hides every layout problem the
  // Supervisor list actually has on a phone (the same lesson tablet-lab's fixture records).
  const tasks = [
    ["supervisor-lab-task-1", "Continue implementation from previous developer"],
    ["supervisor-lab-task-2", "Fix incorrect menu for restaurant in Klaksvig"],
    ["supervisor-lab-task-3", "Improve BGs engine accuracy to 8k+ MMR"],
  ];
  const insertThread = db.prepare(
    "INSERT INTO threads (id, title, state, workspace, brief, raw_prompt, created_at, updated_at) VALUES (?, ?, 'review', ?, ?, ?, ?, ?)",
  );
  // 74h old, so `assess` calls each one a forgotten park (>6h) and the manual sweep has real candidates.
  const parked = now - 74 * 3_600_000;
  for (const [id, title] of tasks) insertThread.run(id, title, SERVER_ROOT, "a seeded task", "a seeded task", parked, parked);
  db.prepare(
    "INSERT INTO threads (id, title, state, workspace, brief, raw_prompt, created_at, updated_at) VALUES (?, ?, 'done', ?, ?, ?, ?, ?)",
  ).run("supervisor-lab-budget-source", "Supervisor budget prefill", SERVER_ROOT, "budget fixture", "budget fixture", parked, parked);

  const event = db.prepare(
    `INSERT INTO supervisor_events (id, thread_id, thread_title, workspace, trigger, kind, action, summary, detail, used_agent, cost_usd, total_tokens, model, notified_discord, created_at)
     VALUES (?, ?, ?, ?, ?, ?, NULL, ?, NULL, ?, ?, ?, ?, 0, ?)`,
  );
  // 25 agent-backed rows carrying the full token allowance: `supervisorBudgetToday` sums exactly these,
  // so the console boots into the budget-reached state the screenshot was taken in. Keep the fixture
  // audit rows off the candidate task ids; otherwise Run now would be testing per-task cooldown instead
  // of the spent-budget path.
  for (let i = 0; i < 25; i++) {
    const [, title] = tasks[i % tasks.length];
    event.run(
      `supervisor-lab-ev-agent-${i}`, null, title, SERVER_ROOT, "stall_sweep", "check",
      `routine check-in on a task sitting in review`, 1, 0, 19_300, "claude-sonnet-5", DAY_START + i * 60_000,
    );
  }
  for (let i = 0; i < 6; i++) {
    const [, title] = tasks[i % tasks.length];
    event.run(
      `supervisor-lab-ev-det-${i}`, null, title, SERVER_ROOT, "stall_sweep", "skip",
      `daily check-in budget reached (25 check-ins, $0.00, 482500 tokens) — deterministic signal: sitting in review for 74h with no follow-up`,
      0, null, null, null, now - (6 - i) * 60_000,
    );
  }

  // Real conversation shapes for both layout bands: a successful task action, an owner decision, and
  // a failure. The ids/titles are snapshots exactly as production stores them, so the browser verifies
  // that history remains useful even without opening each task feed.
  const chat = db.prepare(
    `INSERT INTO supervisor_chat_turns
      (id, content, targets, status, response, action_results, used_agent, cost_usd, total_tokens, model, provider, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const firstTarget = [{ threadId: tasks[0][0], title: tasks[0][1], state: "review" }];
  chat.run(
    "supervisor-lab-chat-success",
    "Have the reviewer verify this handoff and keep the mobile acceptance checks in scope.",
    JSON.stringify(firstTarget),
    "succeeded",
    "The task is in a normal review park, so I delegated it through the existing reviewer path.",
    JSON.stringify([{ threadId: tasks[0][0], threadTitle: tasks[0][1], action: "start_auto_review", ok: true, message: "Started the existing auto-reviewer.", state: "reviewing" }]),
    1, 0.012, 842, "claude-sonnet-5", "claude", now - 22 * 60_000, now - 21 * 60_000,
  );
  chat.run(
    "supervisor-lab-chat-question",
    "Escalate whichever menu task I meant earlier.",
    "[]",
    "needs_input",
    "There are two plausible menu tasks. Which task should I escalate? Select it above so I do not flag the wrong one.",
    "[]",
    1, 0.004, 390, "claude-sonnet-5", "claude", now - 14 * 60_000, now - 13 * 60_000,
  );
  chat.run(
    "supervisor-lab-chat-failure",
    "Pause the task that no longer exists.",
    JSON.stringify([{ threadId: "deleted-task-1234", title: "Removed historical task", state: null }]),
    "failed",
    "I couldn't find the selected task. No task action was taken.",
    "[]",
    0, null, null, null, null, now - 6 * 60_000, now - 6 * 60_000,
  );
  db.close();
}

// ---- the measurements -------------------------------------------------------------------------

/** Anything wider than the screen. `.app` is overflow:hidden, so a spill is not a scrollbar you can
 *  chase — it is content that simply cannot be reached. `.board` is the one that went wrong: it is
 *  `overflow-y: auto`, which CSS promotes to `overflow-x: auto`, so its tab strip's spill became the
 *  horizontal scrollbar sitting above the bottom nav in Kevin's screenshot. */
const collectOverflow = () => {
  const out = [];
  const doc = document.documentElement;
  if (doc.scrollWidth > doc.clientWidth + 1) out.push(`document scrolls ${doc.scrollWidth} in ${doc.clientWidth}`);
  for (const sel of [".app", ".workbench", ".board", ".mobile-nav", ".topbar"]) {
    const el = document.querySelector(sel);
    if (el && el.scrollWidth > el.clientWidth + 1) out.push(`${sel} scrolls ${el.scrollWidth} in ${el.clientWidth}`);
  }
  return out;
};

/** Every element under `rootSel` painting past the right edge of the screen, ignoring anything inside a
 *  deliberate horizontal scroller (the accounts strip is scrolled, not spilled). This is what catches a
 *  child that overflows a parent whose own `overflow` hides the evidence. */
const collectSpill = (rootSel) => {
  const vw = document.documentElement.clientWidth;
  const root = document.querySelector(rootSel);
  if (!root) return [`${rootSel} is not rendered`];
  const inScroller = (el) => {
    for (let p = el.parentElement; p; p = p.parentElement) {
      const ox = getComputedStyle(p).overflowX;
      if (ox === "auto" || ox === "scroll") return true;
    }
    return false;
  };
  const out = [];
  for (const el of root.querySelectorAll("*")) {
    const cs = getComputedStyle(el);
    if (cs.display === "none" || cs.visibility === "hidden" || cs.position === "fixed" || inScroller(el)) continue;
    const r = el.getBoundingClientRect();
    if (r.width > 0 && (r.right > vw + 1 || r.left < -1)) {
      out.push(`.${(el.className.toString() || el.tagName).split(" ")[0]} at ${Math.round(r.left)}…${Math.round(r.right)} of ${vw}`);
    }
  }
  return out.slice(0, 6);
};

/** Geometry says a control is on screen; this says a FINGER lands on it. `.board-head-right` painted
 *  over the overflowing tab strip and won every tap aimed at the Supervisor tab while the tab itself
 *  measured perfectly in-viewport — no box check can see that, only the hit test can. */
const hitTest = ({ sel, text }) => {
  const el = [...document.querySelectorAll(sel)].find((n) => !text || n.textContent.trim().startsWith(text));
  if (!el) return { found: false };
  const r = el.getBoundingClientRect();
  const hit = document.elementFromPoint(Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2));
  return {
    found: true,
    w: Math.round(r.width),
    h: Math.round(r.height),
    inView: r.left >= -1 && r.top >= -1 && r.right <= document.documentElement.clientWidth + 1,
    ownsTap: !!hit && (hit === el || el.contains(hit) || hit.contains(el)),
    blockedBy: hit ? `${hit.tagName.toLowerCase()}.${hit.className.toString().split(" ")[0]}` : "nothing",
  };
};

const check = createChecks();

async function drivePass(page, { name, width, height }, shotDir) {
  console.log(`\n════ ${name} — ${width}×${height}, portrait, touch`);
  const errors = [];
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  page.on("pageerror", (e) => errors.push(String(e)));

  await page.request.post(`${BASE}/api/login`, { data: { password: authPassword() } });
  await page.goto(`${BASE}/`, { timeout: 45_000 });
  await page.waitForSelector(".topbar", { timeout: 20_000 });
  // Everything server-authoritative renders neutral defaults until the WS hello lands; the account
  // chips are hello-only, so they are the signal that the bar being measured is the real one.
  await page.waitForSelector(".accounts .acct", { timeout: 20_000 });
  await page.waitForSelector(".card", { timeout: 20_000 });

  // Fenced-behind guard: every rule below lives in a coarse-pointer / compact-width block, so a pass
  // that isn't actually reporting those media queries is measuring the desktop treatment.
  const media = await page.evaluate(() => ({
    coarse: matchMedia("(pointer: coarse)").matches,
    noHover: matchMedia("(hover: none)").matches,
    compact: matchMedia("(max-width: 899.98px)").matches,
  }));
  check(`${width}: the context really is a coarse, hoverless, compact phone`, media.coarse && media.noHover && media.compact, JSON.stringify(media));

  console.log("\n  LAYOUT — nothing wider than the screen");
  const overflow = await page.evaluate(collectOverflow);
  check(`${width}: no horizontal overflow on the task board`, overflow.length === 0, overflow.join(" | "));
  const spill = await page.evaluate(collectSpill, ".board");
  check(`${width}: nothing in the board paints off the screen`, spill.length === 0, spill.join(" | "));

  console.log("\n  BOARD TABS — all four reachable with a finger");
  for (const label of BOARD_TABS) {
    // The ACTIVE tab renders as an <h2>, the rest as buttons — check whichever this view produced.
    const hit = await page.evaluate(hitTest, { sel: ".board-tabs > *", text: label });
    check(`${width}: the ${label} tab is on screen and owns its own tap`, hit.found && hit.inView && hit.ownsTap, JSON.stringify(hit));
  }

  console.log("\n  BOTTOM NAV — the three panes, at a real tap size");
  const nav = await page.$$eval(".mnav-btn", (els) =>
    els.map((el) => {
      const r = el.getBoundingClientRect();
      const hit = document.elementFromPoint(Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2));
      return {
        label: el.textContent.trim(),
        w: Math.round(r.width), h: Math.round(r.height),
        inView: r.right <= document.documentElement.clientWidth + 1 && r.bottom <= window.innerHeight + 1,
        ownsTap: !!hit && (hit === el || el.contains(hit)),
        clipped: el.scrollWidth > el.clientWidth + 1,
      };
    }),
  );
  check(`${width}: the bottom nav has Director · Tasks · Supervisor`, nav.length === 3 && nav.some((b) => /supervisor/i.test(b.label)), JSON.stringify(nav.map((b) => b.label)));
  check(
    `${width}: every bottom-nav button is a full tap target, on screen, unclipped`,
    nav.every((b) => b.h >= TAP_MIN && b.inView && b.ownsTap && !b.clipped),
    JSON.stringify(nav),
  );

  console.log("\n  ACCOUNTS STRIP — a scroller, not a clip");
  const strip = await page.evaluate(() => {
    const el = document.querySelector(".accounts");
    const cs = getComputedStyle(el);
    const first = document.querySelector(".accounts .acct").getBoundingClientRect();
    const r = el.getBoundingClientRect();
    return {
      scrollable: cs.overflowX === "auto" || cs.overflowX === "scroll",
      full: Math.round(r.width) >= document.documentElement.clientWidth - 40,
      firstChipVisible: first.right <= r.right + 1 && first.left >= r.left - 1,
      snap: cs.scrollSnapType,
    };
  });
  check(`${width}: the strip is a full-width horizontal scroller with its first chip whole`, strip.scrollable && strip.full && strip.firstChipVisible, JSON.stringify(strip));

  console.log("\n  SUPERVISOR — the pane the phone could not use");
  await page.click('.mnav-btn:has-text("Supervisor")');
  await page.waitForSelector(".supervisor-view", { timeout: 10_000 });
  await page.waitForSelector(".supervisor-row", { timeout: 10_000 });

  const svSpill = await page.evaluate(collectSpill, ".supervisor-view");
  check(`${width}: nothing in the Supervisor pane paints off the screen`, svSpill.length === 0, svSpill.join(" | "));
  const svOverflow = await page.evaluate(collectOverflow);
  check(`${width}: no horizontal overflow on the Supervisor pane`, svOverflow.length === 0, svOverflow.join(" | "));

  const runNow = await page.evaluate(hitTest, { sel: ".supervisor-run", text: "" });
  check(
    `${width}: Run now is on screen, tap-sized and owns its own tap`,
    runNow.found && runNow.inView && runNow.ownsTap && runNow.h >= TAP_MIN,
    JSON.stringify(runNow),
  );

  // The conversation has its own scroll container. Bring the composer into the phone viewport before
  // hit-testing it; measuring controls several chat turns below the fold says nothing about usability.
  await page.locator(".supervisor-compose-row").evaluate((el) => el.scrollIntoView({ block: "center" }));

  const chatControls = await page.evaluate(() => {
    const measure = (selector) => {
      const el = document.querySelector(selector);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return {
        w: Math.round(r.width), h: Math.round(r.height),
        inView: r.left >= 0 && r.right <= innerWidth + 1,
        ownsTap: !!hit && (hit === el || el.contains(hit)),
      };
    };
    return {
      target: measure(".supervisor-target-trigger"),
      send: measure(".supervisor-send"),
      textarea: measure(".supervisor-compose-row textarea"),
      turns: document.querySelectorAll(".supervisor-turn").length,
      outcomes: [...document.querySelectorAll(".supervisor-turn-status")].map((el) => el.textContent.trim()),
    };
  });
  check(`${width}: persisted task-chat history renders success, decision, and failure states`, chatControls.turns >= 3 && /completed/i.test(chatControls.outcomes.join(" ")) && /needs your answer/i.test(chatControls.outcomes.join(" ")) && /failed/i.test(chatControls.outcomes.join(" ")), JSON.stringify(chatControls));
  check(`${width}: target picker and Send are on-screen tap controls`, chatControls.target?.inView && chatControls.target.ownsTap && chatControls.target.h >= TAP_MIN && chatControls.send?.inView && chatControls.send.ownsTap && chatControls.send.h >= TAP_MIN, JSON.stringify(chatControls));
  check(`${width}: the task instruction textarea remains on-screen and usable`, chatControls.textarea?.inView && chatControls.textarea.ownsTap && chatControls.textarea.h >= TAP_MIN, JSON.stringify(chatControls.textarea));

  await page.click(".supervisor-target-trigger");
  await page.waitForSelector(".supervisor-target-menu");
  const picker = await page.evaluate(() => {
    const menu = document.querySelector(".supervisor-target-menu").getBoundingClientRect();
    const option = document.querySelector(".supervisor-target-option").getBoundingClientRect();
    return {
      menu: { left: Math.round(menu.left), right: Math.round(menu.right), top: Math.round(menu.top), bottom: Math.round(menu.bottom) },
      optionHeight: Math.round(option.height),
      withinScreen: menu.left >= -1 && menu.right <= innerWidth + 1 && menu.top >= -1 && menu.bottom <= innerHeight + 1,
    };
  });
  check(`${width}: the multi-task picker opens wholly on-screen with finger-sized options`, picker.withinScreen && picker.optionHeight >= TAP_MIN, JSON.stringify(picker));
  await page.click(".supervisor-target-option");
  await page.click(".supervisor-target-menu-foot button");
  const chip = (await page.textContent(".supervisor-target-chip")) ?? "";
  check(`${width}: choosing a target shows its title and short task id`, /Continue implementation/.test(chip) && /#supervis/.test(chip), JSON.stringify(chip));

  // The banner must not read as a reason the operator's own sweep won't run — that is the wording the
  // screenshot caught, beside a Run now button that really did downgrade to deterministic-only.
  const note = await page.textContent(".supervisor-budget-note");
  check(`${width}: the budget banner says Run now still sweeps`, /run now/i.test(note ?? ""), JSON.stringify(note));

  const title = await page.evaluate(() => {
    const el = document.querySelector(".supervisor-task");
    return { align: getComputedStyle(el).textAlign, lines: Math.round(el.getBoundingClientRect().height / parseFloat(getComputedStyle(el).lineHeight)) };
  });
  check(`${width}: a wrapped task title reads left-aligned, not centred`, title.align === "left" || title.align === "start", JSON.stringify(title));

  if (shotDir) {
    const file = path.join(shotDir, `phone-${width}.png`);
    await page.screenshot({ path: file, fullPage: false });
    console.log(`    shot: ${file}`);
  }

  check(`${width}: no console errors during the pass`, errors.length === 0, errors.slice(0, 3).join(" | "));
}

async function driveDesktop(page, shotDir) {
  console.log("\n════ DESKTOP — task chat, picker, and audit share the Supervisor pane");
  const errors = [];
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.request.post(`${BASE}/api/login`, { data: { password: authPassword() } });
  await page.goto(`${BASE}/`, { timeout: 45_000 });
  await page.waitForSelector(".accounts .acct", { timeout: 20_000 });
  await page.click(".board-tab.bt-supervisor");
  await page.waitForSelector(".supervisor-chat");

  const layout = await page.evaluate(() => {
    const pane = document.querySelector(".supervisor-view").getBoundingClientRect();
    const chat = document.querySelector(".supervisor-chat").getBoundingClientRect();
    const compose = document.querySelector(".supervisor-compose-row").getBoundingClientRect();
    return {
      pane: { left: Math.round(pane.left), right: Math.round(pane.right), width: Math.round(pane.width) },
      chat: { left: Math.round(chat.left), right: Math.round(chat.right), width: Math.round(chat.width) },
      composeWidth: Math.round(compose.width),
      actionResults: document.querySelectorAll(".supervisor-action-results button").length,
      turns: document.querySelectorAll(".supervisor-turn").length,
      overflow: document.querySelector(".board").scrollWidth > document.querySelector(".board").clientWidth + 1,
    };
  });
  check("desktop: chat uses the board width without horizontal overflow", !layout.overflow && layout.chat.width === layout.pane.width && layout.composeWidth > 400, JSON.stringify(layout));
  check("desktop: persisted conversation and action audit render together", layout.turns >= 3 && layout.actionResults >= 1, JSON.stringify(layout));

  await page.click(".supervisor-target-trigger");
  await page.waitForSelector(".supervisor-target-menu");
  const menu = await page.evaluate(() => {
    const r = document.querySelector(".supervisor-target-menu").getBoundingClientRect();
    return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, inView: r.left >= 0 && r.right <= innerWidth && r.top >= 0 && r.bottom <= innerHeight };
  });
  check("desktop: task picker is anchored and wholly visible", menu.inView, JSON.stringify(menu));
  await page.click(".supervisor-target-menu-foot button");

  if (shotDir) {
    const file = path.join(shotDir, "desktop-1440.png");
    await page.screenshot({ path: file, fullPage: false });
    console.log(`    shot: ${file}`);
  }
  check("desktop: no console errors during the pass", errors.length === 0, errors.slice(0, 3).join(" | "));
}

/** Submit through the real authenticated UI and websocket. One deterministic new-work turn proves the
 * success path without spending provider capacity; one targeted turn uses bogus lab credentials so the
 * pending -> failure lifecycle is visible and no production task can be touched. Reload then proves the
 * conversation is SQLite history, not component-local echo text. */
async function driveChatRoundTrip(page) {
  console.log("\n════ CHAT ROUND TRIP — authenticated submit, target routing, pending/failure, reload");
  await page.request.post(`${BASE}/api/login`, { data: { password: authPassword() } });
  await page.goto(`${BASE}/`, { timeout: 45_000 });
  await page.waitForSelector(".accounts .acct", { timeout: 20_000 });
  await page.click(".board-tab.bt-supervisor");
  await page.waitForSelector(".supervisor-chat");

  const before = await page.$$eval(".supervisor-turn", (els) => els.length);
  await delayNextChatCommand(page, "supervisor.message");
  await page.fill(".supervisor-compose-row textarea", "Create a new task to redesign the seeded billing screen.");
  await page.click(".supervisor-send");
  await page.waitForSelector(".supervisor-turn.delivery-sending");
  const sending = (await page.textContent(".supervisor-turn.delivery-sending")) ?? "";
  check(
    "chat: the owner's Supervisor message appears immediately with a sending receipt",
    /Create a new task/.test(sending) && /Sending/i.test(sending) && /Waiting for the server/i.test(sending),
    JSON.stringify(sending),
  );
  await page.waitForFunction((n) => document.querySelectorAll(".supervisor-turn").length === n + 1, before);
  await page.waitForFunction(() => /completed/i.test(document.querySelector(".supervisor-turn:last-of-type .supervisor-turn-status")?.textContent ?? ""));
  const newWork = (await page.textContent(".supervisor-turn:last-of-type .supervisor-agent-bubble")) ?? "";
  check("chat: a clear new-task request succeeds by routing back to Director, without duplicating work", /Director/i.test(newWork) && /did not create/i.test(newWork), JSON.stringify(newWork));

  await page.click(".supervisor-target-trigger");
  await page.click('.supervisor-target-option:has-text("Fix incorrect menu")');
  await page.click(".supervisor-target-menu-foot button");
  await page.evaluate(() => {
    window.__supervisorSawPending = false;
    const observer = new MutationObserver(() => {
      if (document.querySelector(".supervisor-turn.turn-pending")) window.__supervisorSawPending = true;
    });
    observer.observe(document.querySelector(".supervisor-conversation"), { childList: true, subtree: true, attributes: true, attributeFilter: ["class"] });
    window.__supervisorPendingObserver = observer;
  });
  await page.fill(".supervisor-compose-row textarea", "Check this task's current status. Do not change it.");
  await page.click(".supervisor-send");
  await page.waitForFunction(() => window.__supervisorSawPending === true, null, { timeout: 10_000 });
  await page.waitForFunction(() => !document.querySelector(".supervisor-turn:last-of-type")?.classList.contains("turn-pending"), null, { timeout: 120_000 });
  const targeted = await page.evaluate(() => {
    window.__supervisorPendingObserver?.disconnect();
    const last = document.querySelector(".supervisor-turn:last-of-type");
    return {
      status: last?.querySelector(".supervisor-turn-status")?.textContent.trim(),
      target: last?.querySelector(".supervisor-turn-targets")?.textContent.trim(),
      response: last?.querySelector(".supervisor-agent-bubble")?.textContent.trim(),
    };
  });
  check("chat: a targeted request visibly passes through pending into an honest provider failure", /failed/i.test(targeted.status ?? "") && /no task action/i.test(targeted.response ?? ""), JSON.stringify(targeted));
  check("chat: target routing remains auditable by title and short id", /Fix incorrect menu/.test(targeted.target ?? "") && /#supervis/.test(targeted.target ?? ""), JSON.stringify(targeted.target));

  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForSelector(".accounts .acct", { timeout: 20_000 });
  await page.click(".board-tab.bt-supervisor");
  await page.waitForFunction((n) => document.querySelectorAll(".supervisor-turn").length >= n + 2, before);
  const restored = (await page.textContent(".supervisor-turn:last-of-type")) ?? "";
  check("chat: the failed targeted turn survives a full browser reload", /Check this task's current status/.test(restored) && /Failed/i.test(restored), JSON.stringify(restored));
}

/** Patch the browser's already-live WebSocket prototype once, then delay exactly the next frame of a
 * requested chat command. The store still sees an open socket and must render its optimistic receipt;
 * releasing the real frame later proves that the persisted echo removes that exact placeholder. */
async function delayNextChatCommand(page, type, delayMs = 900) {
  await page.evaluate(({ type, delayMs }) => {
    if (!window.__ggoReceiptSend) {
      window.__ggoReceiptSend = WebSocket.prototype.send;
      WebSocket.prototype.send = function patchedSend(data) {
        let command;
        try { command = JSON.parse(String(data)); } catch { command = null; }
        const delayed = window.__ggoReceiptDelay;
        if (delayed && command?.type === delayed.type) {
          window.__ggoReceiptDelay = null;
          const socket = this;
          setTimeout(() => window.__ggoReceiptSend.call(socket, data), delayed.delayMs);
          return;
        }
        return window.__ggoReceiptSend.call(this, data);
      };
    }
    window.__ggoReceiptDelay = { type, delayMs };
  }, { type, delayMs });
}

/** Kevin's "literally all chats" acceptance pass. Each composer is exercised against the real
 * authenticated websocket while its outgoing frame is held briefly in the browser. */
async function driveAllChatReceipts(page) {
  console.log("\n════ CHAT RECEIPTS — immediate owner bubbles in every conversation surface");
  await page.request.post(`${BASE}/api/login`, { data: { password: authPassword() } });
  await page.goto(`${BASE}/`, { timeout: 45_000 });
  await page.waitForSelector(".accounts .acct", { timeout: 20_000 });

  await delayNextChatCommand(page, "prompt.new");
  await page.fill(".composer textarea", "Receipt check for Director chat.");
  await page.click(".composer .btn.primary");
  await page.waitForSelector(".transcript .msg.user .delivery-receipt.sending");
  const directorSending = (await page.textContent(".transcript .msg.user:last-of-type")) ?? "";
  check("Director: message is visible with Sending before server receipt", /Receipt check/.test(directorSending) && /Sending/i.test(directorSending), JSON.stringify(directorSending));
  await page.waitForFunction(() => ![...document.querySelectorAll(".transcript .msg.user")].at(-1)?.querySelector(".delivery-receipt"));
  check("Director: persisted echo reconciles the optimistic bubble without a duplicate", (await page.$$eval(".transcript .msg.user", (els) => els.filter((el) => /Receipt check for Director chat/.test(el.textContent ?? "")).length)) === 1);
  const stop = page.locator(".director-stop");
  if (await stop.isVisible().catch(() => false)) await stop.click();

  await page.click(".office-director");
  await page.waitForSelector(".office-panel");
  await delayNextChatCommand(page, "chat.post");
  await page.fill(".office-composer textarea", "Receipt check for Office chat.");
  await page.click(".office-composer .btn.primary");
  await page.waitForSelector(".office-msg.delivery-sending .delivery-receipt.sending");
  const officeSending = (await page.textContent(".office-msg.delivery-sending")) ?? "";
  check("Office: message is visible with Sending before server receipt", /Receipt check/.test(officeSending) && /Sending/i.test(officeSending), JSON.stringify(officeSending));
  await page.waitForSelector(".office-msg.delivery-sending", { state: "detached" });
  check("Office: persisted echo reconciles the optimistic bubble without a duplicate", (await page.$$eval(".office-msg", (els) => els.filter((el) => /Receipt check for Office chat/.test(el.textContent ?? "")).length)) === 1);
  await page.click(".office-panel .close-x");

  await page.locator('.card:has-text("Continue implementation")').first().click();
  await page.waitForSelector(".detail .inject-bar textarea");
  await delayNextChatCommand(page, "thread.inject");
  await page.fill(".inject-bar textarea", "Receipt check for task instruction chat.");
  await page.click('.inject-bar button:has-text("Queue")');
  await page.waitForSelector(".fi.system.delivery-sending .delivery-receipt.sending");
  const taskSending = (await page.textContent(".fi.system.delivery-sending")) ?? "";
  check("Task instruction: message is visible with Sending before server receipt", /Receipt check/.test(taskSending) && /Sending/i.test(taskSending), JSON.stringify(taskSending));
  await page.waitForSelector(".fi.system.delivery-sending", { state: "detached" });
  check("Task instruction: persisted feed echo reconciles without a duplicate", (await page.$$eval(".fi.system", (els) => els.filter((el) => /Receipt check for task instruction chat/.test(el.textContent ?? "")).length)) === 1);
}

/** The manual sweep, driven once through the real console at the narrowest width: click Run now with
 *  the day's budget already spent and assert the server examined every eligible task anyway. The
 *  provider call may still fail honestly, but never because the unattended budget was already spent. */
async function driveManualSweep(page) {
  console.log(`\n════ MANUAL SWEEP — budget spent, bounded operator sweep, end to end`);
  await page.request.post(`${BASE}/api/login`, { data: { password: authPassword() } });
  await page.goto(`${BASE}/`, { timeout: 45_000 });
  await page.waitForSelector(".accounts .acct", { timeout: 20_000 });
  await page.click('.mnav-btn:has-text("Supervisor")');
  await page.waitForSelector(".supervisor-view", { timeout: 10_000 });

  const before = await page.$$eval(".supervisor-row", (r) => r.length);
  await page.click(".supervisor-run");

  // The result line is the console's own report of what the sweep did — poll for it rather than for a
  // transient "sweeping" frame, which a fast sweep can pass through between two paints.
  await page.waitForSelector(".supervisor-sweep", { timeout: MANUAL_SWEEP_TIMEOUT_MS });
  await page.waitForFunction(() => /complete|stopped/i.test(document.querySelector(".supervisor-sweep")?.textContent ?? ""), null, { timeout: MANUAL_SWEEP_TIMEOUT_MS });
  const result = (await page.textContent(".supervisor-sweep")) ?? "";
  console.log(`    result line: ${result.trim()}`);

  check("the console reports the manual sweep's own result", /examined/i.test(result), JSON.stringify(result));
  check("…naming the three eligible tasks it swept", /\b3\b/.test(result), JSON.stringify(result));
  check("and the real external limitation, not the daily budget", /capacity/i.test(result) && !/budget/i.test(result), JSON.stringify(result));

  const rows = await page.$$eval(".supervisor-row", (els) =>
    els
      .filter((row) => /manual/.test(row.querySelector(".supervisor-meta")?.textContent ?? ""))
      .map((row) => row.querySelector(".supervisor-text")?.textContent.trim() ?? ""),
  );
  const manual = await page.$$eval(".supervisor-row .supervisor-meta", (els) => els.map((e) => e.textContent).filter((t) => /manual/.test(t)));
  check("the sweep wrote manual-triggered audit rows", manual.length >= 3, `${manual.length} manual rows`);
  check(
    "no task was skipped for the daily check-in budget",
    !rows.some((t) => /daily check-in budget reached/i.test(t)),
    rows.filter((t) => /budget/i.test(t)).join(" | "),
  );
  check("the sweep added rows to the audit trail", (await page.$$eval(".supervisor-row", (r) => r.length)) > before);

  // Idempotency: a second click while the first sweep is still in flight must not start a second one.
  // Once it has finished, a fresh click must genuinely sweep again.
  const disabledWhileRunning = await page.evaluate(async () => {
    const btn = document.querySelector(".supervisor-run");
    btn.click();
    await new Promise((r) => setTimeout(r, 50));
    return { disabled: btn.disabled, label: btn.textContent.trim() };
  });
  await page.waitForFunction(() => document.querySelector(".supervisor-run")?.disabled === false, null, { timeout: MANUAL_SWEEP_TIMEOUT_MS });
  console.log(`    re-run: ${JSON.stringify(disabledWhileRunning)}`);
  check("a second sweep can be requested once the first finished", true);
}

/** requireBuild() only asserts web/dist EXISTS. For a lab whose verdict is CSS, that is the sharpest
 *  way to be green about nothing: an unbuilt edit leaves it measuring the previous bundle. */
function requireFreshWebBuild() {
  const src = path.resolve(SERVER_ROOT, "..", "web", "src");
  const built = fs.statSync(path.resolve(SERVER_ROOT, "..", "web", "dist", "index.html")).mtimeMs;
  let newest = 0;
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else newest = Math.max(newest, fs.statSync(p).mtimeMs);
    }
  };
  walk(src);
  if (newest > built) {
    console.error("web/dist is older than web/src — run `npm run build --prefix web` first, or this lab measures the previous bundle.");
    process.exit(2);
  }
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

(async () => {
  const keep = process.argv.includes("--keep");
  const shotIdx = process.argv.indexOf("--shot");
  const shotDir = shotIdx > -1 ? process.argv[shotIdx + 1] : null;
  if (shotDir) fs.mkdirSync(shotDir, { recursive: true });
  requireBuild();
  requireFreshWebBuild();
  killInstance(PORT);

  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "supervisor-lab-"));
  let browser;
  try {
    // First boot creates the schema; the account snapshots and the supervisor toggle are only read at
    // boot, so seed between two boots.
    await boot({ dataDir, port: PORT, env: ACCOUNT_ENV });
    seed(dataDir);
    killInstance(PORT);
    await boot({ dataDir, port: PORT, env: ACCOUNT_ENV });
    browser = await loadChromium().launch();
    const newPhone = (o) =>
      browser.newContext({ viewport: { width: o.width, height: o.height }, hasTouch: true, isMobile: true, deviceScaleFactor: 3 });

    for (const o of WIDTHS) {
      // hasTouch/isMobile are CONTEXT options — newPage({viewport}) alone leaves Chromium reporting a
      // fine pointer, and every coarse/hover rule would go unmeasured.
      const ctx = await newPhone(o);
      try {
        await drivePass(await ctx.newPage(), o, shotDir);
      } finally {
        await ctx.close();
      }
    }
    const desktop = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
    try {
      await driveDesktop(await desktop.newPage(), shotDir);
    } finally {
      await desktop.close();
    }
    const roundTrip = await browser.newContext({ viewport: { width: 1280, height: 860 }, deviceScaleFactor: 1 });
    try {
      await driveChatRoundTrip(await roundTrip.newPage());
    } catch (e) {
      check("the authenticated Supervisor chat round trip completed", false, String(e).split("\n")[0]);
    } finally {
      await roundTrip.close();
    }
    const receipts = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
    try {
      await driveAllChatReceipts(await receipts.newPage());
    } catch (e) {
      check("the all-chat optimistic receipt pass completed", false, String(e).split("\n")[0]);
    } finally {
      await receipts.close();
    }
    // The sweep mutates supervisor state, so it runs LAST — after every layout pass has measured the
    // seeded budget-reached board.
    const ctx = await newPhone(WIDTHS[1]);
    try {
      await driveManualSweep(await ctx.newPage());
    } catch (e) {
      // A sweep that never reports is a FAILED check, not a crashed lab — the layout verdicts above
      // are still worth printing, and a bare throw would swallow the whole summary.
      check("the manual sweep completed and reported", false, String(e).split("\n")[0]);
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
  process.exit(check.summary());
})().catch((e) => {
  console.error(e);
  killInstance(PORT);
  process.exit(1);
});
