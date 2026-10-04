// Lab for the task detail HEADER with long titles (`npm run task-header-lab --prefix server`).
//
//   npm run task-header-lab --prefix server
//   npm run task-header-lab --prefix server -- --shots data/task-header-shots/after
//   npm run task-header-lab --prefix server -- --only narrow-desk
//
// The report it exists for: a goal-step title ("<goal> · step 1: <step>") opened in a narrow detail pane
// sat in a ~150px column beside the elapsed/effort/state badges and wrapped to sixteen lines, pushing the
// filters and transcript off the bottom while the strip to its right stayed empty. Nothing overflowed
// and nothing overlapped, so no existing geometry check saw it: the failure is that the title gets too
// LITTLE width and too MUCH height. So the invariants here are:
//   1. The title gets most of the header's width (TITLE_SHARE), at every width.
//   2. A long title is clamped to --title-lines, and a "Show full title" button lifts the clamp by
//      pointer, touch and keyboard (Enter), and puts it back.
//   3. The chevron and ✕ stay inside the header, uncovered, at least 28px (44px on touch), and no two
//      of title / status / chevron / ✕ overlap; nothing in the header scrolls sideways.
//   4. The filter chips and a usable transcript are still on screen with the header expanded, and the
//      transcript still scrolls to its last row.
//   5. A short title shows no reveal button, and on a wide pane keeps its badges on the title's row.
// Plus the board card holding the same title must not scroll sideways.
//
// Text scaling is covered the way a browser does it: 150% and 200% zoom are the 1440x900 desktop with
// a proportionally smaller CSS viewport at a matching deviceScaleFactor, which is exactly what page zoom
// and OS text scaling hand the layout. Every check is read from live geometry, never from the CSS.
//
// Safe against prod for the reasons every lab is (lab-harness.cjs): temp DATA_DIR, bogus tokens, its
// own port, killed by port owner. To test uncommitted work, build isolated bundles and point
// GGO_LAB_ENTRY / GGO_LAB_WEB_DIST at them (see the harness header).

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Database = require("better-sqlite3");
const { SERVER_ROOT, loadChromium, authPassword, requireBuild, boot, killInstance, createChecks, shotDir } = require("./lab-harness.cjs");

const PORT = 4461;
const BASE = `http://127.0.0.1:${PORT}`;
const SLACK = 1;

/** The smallest share of the header's content width a long title may be left. The reported layout
 *  gave it 0.47; a title row that only spares the chevron and ✕ gives it 0.75 or more. */
const TITLE_SHARE = 0.6;

/** The transcript the expanded header must leave: two `.fi` rows, as in panel-scroll-lab. */
const MIN_SCROLLPORT = 120;

const TASKS = [
  {
    id: "thl-long-0000-4000-8000-000000000001",
    key: "goal-step",
    title:
      "Build autonomous route-first progression for one account · step 1: Build and verify autonomous single-account route-first progression through Route Controls",
    state: "review",
    effort: "medium",
    pin: { requested: "GPT-6 Astra", provider: "codex", model: "gpt-6-astra", strict: true },
    worktree: "ggo/autonomous-route-first-progression-single-account-1a2b3c4d",
    long: true,
  },
  {
    id: "thl-word-0000-4000-8000-000000000002",
    key: "long-word",
    title:
      "Investigate TermWrapSourceAndSetupAcknowledgementIR7db2bce5f9294954ad092af4020b6591RiskAssessmentForZeroDeathHardcoreRuns before installing anything",
    state: "failed",
    effort: "xhigh",
    pin: { requested: "an-unresolvable-model-name-that-the-owner-typed-in-full", provider: null, model: null, strict: true },
    long: true,
  },
  {
    id: "thl-short-000-4000-8000-000000000003",
    key: "short",
    title: "Fix login redirect",
    state: "done",
    effort: "low",
    long: false,
  },
];

const VIEWPORTS = [
  { key: "narrow-desk", width: 1440, height: 900, scale: 1.75, detailWidth: 377, why: "the reported pane: desktop, detail dragged to ~377px, 175% display scale" },
  { key: "default-desk", width: 1440, height: 900, detailWidth: 480, why: "desktop, default 480px pane" },
  { key: "wide-desk", width: 1600, height: 900, detailWidth: 760, why: "desktop, wide pane" },
  { key: "tablet", width: 1024, height: 768, touch: true, why: "tablet band: the detail is a sheet beside the rail" },
  { key: "zoom150", width: 960, height: 600, scale: 1.5, detailWidth: 480, why: "1440x900 desktop at 150% zoom / text scale" },
  { key: "zoom200", width: 720, height: 450, scale: 2, why: "1440x900 desktop at 200% zoom: the phone band" },
  { key: "shot-proportion", width: 660, height: 934, touch: true, why: "the screenshot's own 660x934 as a viewport" },
  { key: "phone", width: 390, height: 844, touch: true, why: "a phone" },
  { key: "small-phone", width: 320, height: 640, touch: true, why: "the narrowest phone" },
];

const HEAD_STATES = [
  { key: "expanded", collapsed: false },
  { key: "collapsed", collapsed: true },
];

function seed(dataDir) {
  const db = new Database(path.join(dataDir, "orchestrator.sqlite"));
  const now = Date.now();
  const thread = db.prepare(
    "INSERT INTO threads (id, title, state, workspace, brief, raw_prompt, model_request, worktrees, created_at, updated_at) VALUES (?, ?, ?, ?, 'a seeded task', 'a seeded task', ?, ?, ?, ?)",
  );
  const run = db.prepare(
    "INSERT INTO agent_runs (id, thread_id, role, model, account, effort, session_id, state, cost_usd, num_turns, started_at, ended_at) VALUES (?, ?, ?, ?, 'logged-in', ?, ?, 'done', 1.5, 12, ?, ?)",
  );
  const msg = db.prepare(
    "INSERT INTO messages (id, thread_id, run_id, role, kind, content, attachments, created_at) VALUES (?, ?, ?, ?, 'text', ?, '[]', ?)",
  );
  TASKS.forEach((t, n) => {
    const worktrees = t.worktree
      ? JSON.stringify([
          {
            repo: SERVER_ROOT,
            path: path.join(SERVER_ROOT, "..", "..", "lab.worktrees", "autonomous-route-first-progression"),
            branch: t.worktree,
            base: "master",
            baseSha: "0123456789abcdef0123456789abcdef01234567",
            links: [],
            createdAt: now - 1_500_000,
          },
        ])
      : null;
    thread.run(t.id, t.title, t.state, SERVER_ROOT, t.pin ? JSON.stringify(t.pin) : null, worktrees, now - 1_505_000 - n, now - n * 1000);
    run.run(`${t.id}-dir`, t.id, "director", "claude-opus-5-5", null, `${t.id}-s0`, now - 1_500_000, now - 1_490_000);
    run.run(`${t.id}-impl`, t.id, "implementor", "gpt-6-astra", t.effort, `${t.id}-s1`, now - 1_480_000, now - 60_000);
    for (let i = 0; i < 60; i++) {
      msg.run(
        `${t.id}-m${i}`,
        t.id,
        `${t.id}-impl`,
        "implementor",
        `Entry ${i}. My assessment: reasonable to investigate for offline testing, but too unverified to rely on for zero-death Hardcore runs. Nothing has been installed.`,
        now - 1_400_000 + i * 10_000,
      );
    }
  });
  db.close();
}

/** Every number the invariants need, in one evaluate, from live geometry. */
function readHeader(page) {
  return page.evaluate(() => {
    const q = (s) => document.querySelector(s);
    const rect = (el) => {
      if (!el) return null;
      const b = el.getBoundingClientRect();
      if (b.width === 0 && b.height === 0) return null;
      return { top: b.top, bottom: b.bottom, left: b.left, right: b.right, width: b.width, height: b.height };
    };
    const head = q(".detail-head");
    const text = q(".detail-head .editable-title-text");
    const cs = head ? getComputedStyle(head) : null;
    const covered = (el) => {
      const b = el?.getBoundingClientRect();
      if (!b || b.width === 0) return true;
      const hit = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2);
      return !(hit && (hit === el || el.contains(hit)));
    };
    const toggle = q(".detail-head .head-toggle");
    const close = q(".detail-head .task-close");
    const body = q(".detail-body");
    const reveal = q(".detail-head .title-reveal");
    // The width the title's first line may use: from its left edge to the first control on that line,
    // or the title row's content edge. Not the text's own width, which shrink-wraps to its longest line.
    const titleRoom = (() => {
      const top = q(".detail-head .top");
      if (!text || !top) return 0;
      const t = text.getBoundingClientRect();
      const line = parseFloat(getComputedStyle(text).lineHeight) || 20;
      let right = top.getBoundingClientRect().right - parseFloat(getComputedStyle(top).paddingRight);
      for (const el of [toggle, close, q(".detail-head .badge"), q(".detail-head .effort-badge"), q(".detail-head .task-elapsed")]) {
        const b = el?.getBoundingClientRect();
        if (b && b.width > 0 && b.left >= t.left && b.top < t.top + line && b.bottom > t.top) right = Math.min(right, b.left);
      }
      return right - t.left;
    })();
    return {
      titleRoom,
      head: rect(head),
      headInner: head ? head.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight) : 0,
      headSideways: head ? head.scrollWidth - head.clientWidth : 0,
      collapsed: !!head?.classList.contains("collapsed"),
      lines: cs ? Number(cs.getPropertyValue("--title-lines")) : 0,
      lineHeight: text ? parseFloat(getComputedStyle(text).lineHeight) : 0,
      text: text ? { ...rect(text), scrollHeight: text.scrollHeight, clientHeight: text.clientHeight } : null,
      title: rect(q(".detail-head .editable-title")),
      reveal: reveal ? { ...rect(reveal), label: reveal.textContent, expanded: reveal.getAttribute("aria-expanded") } : null,
      status: rect(q(".detail-head .badge")),
      effort: rect(q(".detail-head .effort-badge")),
      elapsed: rect(q(".detail-head .task-elapsed")),
      toggle: rect(toggle),
      close: rect(close),
      toggleCovered: covered(toggle),
      closeCovered: covered(close),
      pin: rect(q(".detail-head .model-pin-badge, .detail-head .model-request-status")),
      branch: rect(q(".detail-head .task-branch")),
      detail: rect(q(".detail")),
      filter: rect(q(".feed-filter-roles")),
      scrollport: body ? body.clientHeight : 0,
      coarse: matchMedia("(pointer: coarse)").matches,
    };
  });
}

const overlaps = (a, b) => !!a && !!b && a.left < b.right - SLACK && b.left < a.right - SLACK && a.top < b.bottom - SLACK && b.top < a.bottom - SLACK;
const inside = (a, box) => !!a && !!box && a.left >= box.left - SLACK && a.right <= box.right + SLACK;
const fmt = (r) => (r ? `${Math.round(r.left)},${Math.round(r.top)} ${Math.round(r.width)}x${Math.round(r.height)}` : "none");

function assertHeader(check, tag, task, h) {
  check(`${tag} · header renders`, !!h.head && !!h.text, "no .detail-head / title");
  if (!h.head || !h.text) return;
  check(`${tag} · nothing in the header scrolls sideways`, h.headSideways <= SLACK, `${h.headSideways}px`);
  for (const [name, r] of [["chevron", h.toggle], ["close", h.close], ["state badge", h.status], ["title", h.title]]) {
    check(`${tag} · ${name} inside the header`, inside(r, h.head), `${fmt(r)} vs head ${fmt(h.head)}`);
  }
  const min = h.coarse ? 44 : 28;
  for (const [name, r] of [["chevron", h.toggle], ["close", h.close]]) {
    check(`${tag} · ${name} is a ${min}px target`, !!r && r.width >= min - SLACK && r.height >= min - SLACK, fmt(r));
  }
  check(`${tag} · chevron and close are not covered`, !h.toggleCovered && !h.closeCovered, `toggle ${h.toggleCovered} close ${h.closeCovered}`);
  const pairs = [
    ["title", h.title, "chevron", h.toggle],
    ["title", h.title, "close", h.close],
    ["title", h.title, "state badge", h.status],
    ["title", h.title, "effort", h.effort],
    ["state badge", h.status, "chevron", h.toggle],
    ["state badge", h.status, "close", h.close],
    ["chevron", h.toggle, "close", h.close],
  ];
  for (const [an, a, bn, b] of pairs) check(`${tag} · ${an} clear of ${bn}`, !overlaps(a, b), `${fmt(a)} / ${fmt(b)}`);
  check(`${tag} · the title is not overlapped by the pin or branch`, !overlaps(h.title, h.pin) && !overlaps(h.title, h.branch), `pin ${fmt(h.pin)} branch ${fmt(h.branch)}`);

  const share = h.titleRoom / h.headInner;
  check(`${tag} · the title gets ${Math.round(TITLE_SHARE * 100)}%+ of the header width`, share >= TITLE_SHARE, `${Math.round(share * 100)}% (${Math.round(h.titleRoom)}/${Math.round(h.headInner)}px)`);
  if (task.long) {
    const capped = h.lines > 0 && h.text.height <= h.lines * h.lineHeight + 2;
    check(`${tag} · the title is clamped to ${h.lines} lines`, capped, `${Math.round(h.text.height)}px for ${h.lines} x ${h.lineHeight}px`);
    // A pane wide enough to fit the whole title inside the clamp owes no button; one that cuts it does.
    const cut = h.text.scrollHeight > h.text.clientHeight + SLACK;
    if (cut) {
      check(`${tag} · a clamped title offers "Show full title"`, h.reveal?.label === "Show full title" && h.reveal.expanded === "false", JSON.stringify(h.reveal));
      check(`${tag} · the reveal button sits inside the header`, inside(h.reveal, h.head), fmt(h.reveal));
    } else {
      check(`${tag} · a title that fits shows no reveal button`, !h.reveal, JSON.stringify(h.reveal));
    }
  } else {
    check(`${tag} · a short title shows no reveal button`, !h.reveal, JSON.stringify(h.reveal));
    check(`${tag} · a short title is one line`, h.text.height <= h.lineHeight + 2, `${Math.round(h.text.height)}px`);
  }
}

/** Reveal by pointer/touch, then hide again by keyboard: the two routes the brief requires besides hover. */
async function assertReveal(check, tag, page, touch) {
  const button = page.locator(".detail-head .title-reveal");
  if (!(await button.count())) return check(`${tag} · the full title can be revealed`, false, "no .title-reveal button");
  if (touch) await button.tap();
  else await button.click();
  await page.waitForFunction(() => document.querySelector(".detail-head .title-reveal")?.getAttribute("aria-expanded") === "true", null, { timeout: 5_000 }).catch(() => {});
  const open = await readHeader(page);
  check(
    `${tag} · ${touch ? "tap" : "click"} reveals the whole title`,
    open.reveal?.expanded === "true" && open.reveal?.label === "Show less" && open.text && open.text.scrollHeight <= open.text.clientHeight + SLACK,
    JSON.stringify({ reveal: open.reveal, scroll: open.text?.scrollHeight, client: open.text?.clientHeight }),
  );
  check(`${tag} · revealed, nothing scrolls sideways`, open.headSideways <= SLACK, `${open.headSideways}px`);
  check(`${tag} · revealed, chevron and close stay clear`, !overlaps(open.title, open.toggle) && !overlaps(open.title, open.close) && !open.closeCovered, `${fmt(open.title)} / ${fmt(open.close)}`);
  await button.focus();
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => document.querySelector(".detail-head .title-reveal")?.getAttribute("aria-expanded") === "false", null, { timeout: 5_000 }).catch(() => {});
  const shut = await readHeader(page);
  check(`${tag} · Enter on "Show less" clamps it again`, shut.reveal?.expanded === "false" && shut.text.height <= shut.lines * shut.lineHeight + 2, JSON.stringify(shut.reveal));
}

async function assertFeed(check, tag, page, h, viewport) {
  check(`${tag} · filter chips on screen`, !!h.filter && !!h.detail && h.filter.top >= h.detail.top - SLACK && h.filter.bottom <= h.detail.bottom + SLACK, `${fmt(h.filter)} in ${fmt(h.detail)}`);
  const floor = Math.min(MIN_SCROLLPORT, Math.floor(viewport.height / 6));
  check(`${tag} · the transcript keeps ${floor}px+`, h.scrollport >= floor, `${h.scrollport}px`);
  const last = await page.evaluate(() => {
    const body = document.querySelector(".detail-body");
    if (!body) return null;
    body.scrollTop = body.scrollHeight;
    const rows = body.querySelectorAll(".fi");
    const row = rows[rows.length - 1];
    if (!row) return null;
    const b = row.getBoundingClientRect();
    const port = body.getBoundingClientRect();
    return { visible: b.bottom > port.top && b.top < port.bottom };
  });
  await page.waitForTimeout(150);
  check(`${tag} · the transcript scrolls to its last row`, !!last?.visible, JSON.stringify(last));
}

async function openTask(page, task, shots) {
  try {
    await page.locator(`.card:has-text("${task.title.slice(0, 40)}")`).first().click({ position: { x: 14, y: 10 }, timeout: 30_000 }); // a corner: the card's middle holds the folder chip, which opens the folder rather than the task
    await page.waitForSelector(".detail .editable-title-text", { state: "attached", timeout: 20_000 });
    await page.waitForSelector(".detail .fi", { state: "attached", timeout: 20_000 });
    await page.waitForTimeout(300);
  } catch (e) {
    await page.screenshot({ path: path.join(shots, `open-failed-${task.key}.png`) });
    throw e;
  }
}

async function closeTask(check, tag, page, touch) {
  const close = page.locator(".detail-head .task-close");
  if (touch) await close.tap();
  else await close.click();
  const gone = await page.waitForSelector(".detail-head", { state: "detached", timeout: 5_000 }).then(() => true, () => false);
  check(`${tag} · Close closes the task`, gone);
}

async function assertCollapseToggle(check, tag, page, touch) {
  const before = await readHeader(page);
  const toggle = page.locator(".detail-head .head-toggle");
  if (touch) await toggle.tap();
  else await toggle.click();
  await page.waitForTimeout(200);
  const after = await readHeader(page);
  check(`${tag} · the chevron toggles the header`, after.collapsed !== before.collapsed, `${before.collapsed} -> ${after.collapsed}`);
  if (touch) await toggle.tap();
  else await toggle.click();
  await page.waitForTimeout(200);
}

async function assertBoardCard(check, tag, page) {
  const card = await page.evaluate((title) => {
    const el = [...document.querySelectorAll(".card")].find((c) => c.textContent.includes(title));
    if (!el) return null;
    const b = el.getBoundingClientRect();
    return { sideways: el.scrollWidth - el.clientWidth, visible: b.width > 0 };
  }, TASKS[0].title.slice(0, 40));
  if (!card?.visible) return; // the board sits under the phone overlay; the card is measured where it shows
  check(`${tag} · the board card with the long title does not scroll sideways`, card.sideways <= SLACK, `${card.sideways}px`);
}

async function main() {
  const only = (() => {
    const at = process.argv.indexOf("--only");
    return at >= 0 ? process.argv[at + 1] : null;
  })();
  requireBuild();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "task-header-lab-"));
  const shots = shotDir(dataDir);
  const wantShots = process.argv.includes("--shots") || process.argv.includes("--shot");
  console.log(`task-header-lab on ${BASE}`);
  const check = createChecks();
  try {
    await boot({ dataDir, port: PORT });
    killInstance(PORT); // the first boot only creates the schema; seed, then boot against the seeded DB
    seed(dataDir);
    await boot({ dataDir, port: PORT });

    const browser = await loadChromium().launch();
    try {
      for (const vp of VIEWPORTS.filter((v) => !only || v.key === only)) {
        for (const head of HEAD_STATES) {
          const touch = !!vp.touch;
          const context = await browser.newContext({
            viewport: { width: vp.width, height: vp.height },
            deviceScaleFactor: vp.scale ?? 1,
            hasTouch: touch,
            isMobile: touch && vp.width < 900,
          });
          try {
            const page = await context.newPage();
            await page.request.post(`${BASE}/api/login`, { data: { password: authPassword() } });
            await page.addInitScript(({ collapsed, detailWidth }) => {
              localStorage.setItem("orch-head-collapsed", collapsed ? "1" : "0");
              if (detailWidth) localStorage.setItem("orch-detail-w", String(detailWidth));
            }, { collapsed: head.collapsed, detailWidth: vp.detailWidth });
            await page.goto(`${BASE}/`, { timeout: 45_000 });
            await page.waitForSelector(".accounts .acct", { state: "attached", timeout: 45_000 });
            console.log(`\n  ${vp.key} ${vp.width}x${vp.height}${vp.scale ? ` @${vp.scale}x` : ""} ${head.key} (${vp.why})`);
            await assertBoardCard(check, `${vp.key} ${head.key}`, page);
            for (const task of TASKS) {
              const tag = `${vp.key} ${head.key} ${task.key}`;
              await openTask(page, task, shots);
              const h = await readHeader(page);
              assertHeader(check, tag, task, h);
              if (wantShots && task.key !== "short") await page.screenshot({ path: path.join(shots, `${vp.key}-${head.key}-${task.key}.png`) });
              if (task.long && h.text && h.text.scrollHeight > h.text.clientHeight + SLACK) {
                await assertReveal(check, tag, page, touch);
                if (wantShots && task.key === "goal-step" && head.key === "expanded" && (await page.locator(".detail-head .title-reveal").count())) {
                  await page.locator(".detail-head .title-reveal").click();
                  await page.waitForTimeout(150);
                  await page.screenshot({ path: path.join(shots, `${vp.key}-${head.key}-${task.key}-revealed.png`) });
                  await page.locator(".detail-head .title-reveal").click();
                }
              }
              if (!head.collapsed) await assertFeed(check, tag, page, h, vp);
              if (task.key === "goal-step") await assertCollapseToggle(check, tag, page, touch);
              await closeTask(check, tag, page, touch);
            }
          } finally {
            await context.close();
          }
        }
      }
    } finally {
      await browser.close();
    }
  } finally {
    killInstance(PORT);
    if (process.argv.includes("--keep")) console.log(`  kept ${dataDir}`);
    else fs.rmSync(dataDir, { recursive: true, force: true });
  }
  if (wantShots) console.log(`\n  screenshots: ${shots}`);
  return check.summary();
}

main().then(
  (code) => process.exit(code),
  (e) => {
    console.error(e);
    killInstance(PORT);
    process.exit(1);
  },
);
