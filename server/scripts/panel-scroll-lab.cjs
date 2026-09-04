// Drive the task detail panel's SCROLLING against a throwaway instance, at the widths the panel is
// actually used at. That is the state behind "I can't scroll, this is unusable": a task with a work
// memo, deliverables and a long transcript, opened in a narrow window.
//
//   npm run panel-scroll-lab --prefix server
//   npm run panel-scroll-lab --prefix server -- --width 580
//   npm run panel-scroll-lab --prefix server -- --shot C:\tmp\after     (2 PNGs per width)
//   npm run panel-scroll-lab --prefix server -- --keep
//
// Why it exists next to `layout-lab`, which already measures this panel: layout-lab is HORIZONTAL. It
// asks whether the workbench's grid tracks fit, and a panel whose every pane sits inside its container
// passes it while being completely unreadable, because the failure here is on the other axis and one
// layer in. `.detail` is `overflow: hidden`, so its non-scrolling chrome (header, work memo, filter
// chips, deliverables) cannot push anything into a scrollbar: it takes the height it wants and the
// transcript keeps whatever is left. At 580x740 that remainder was about one line, with 500 entries
// and the whole memo/deliverable block unreachable. Nothing overflowed, nothing scrolled, and nothing
// was clipped in the way a layout check looks for.
//
// So the invariants here are the two the owner can see, and they are deliberately about REACHABILITY,
// not geometry:
//   1. The panel's scrollport is a usable size at every width, and scrolling it to the end actually
//      brings the last transcript entry into view while the inject bar stays pinned and on screen.
//   2. Nothing in the transcript scrolls SIDEWAYS. Agent output is full of 200-char command lines and
//      fenced code, and a flex item's automatic minimum size is its content's min-content width, so
//      one long line silently widens the column and hands the feed a horizontal scrollbar. When that
//      fails, the check names the widest offending element instead of just reporting a number.
// Plus the cosmetic one the same report asked for: scrollbars are themed rather than native-light.
//
// Safe against prod for the reasons every lab is: temp DATA_DIR, bogus account tokens, its own port,
// killed by port owner. See lab-harness.cjs's header for the traps that buys you.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Database = require("better-sqlite3");
const { SERVER_ROOT, loadChromium, authPassword, requireBuild, boot, killInstance, createChecks } = require("./lab-harness.cjs");

const PORT = 4353;
const BASE = `http://127.0.0.1:${PORT}`;
const TASK_ID = "panel-scroll-lab-task-00";

/** Sub-pixel slack. `getBoundingClientRect` reports fractional layout, so an exact fit routinely
 *  lands a rounding step outside its container. */
const SLACK = 1;

/** The smallest transcript viewport that is still a transcript. Below this the panel is the reported
 *  bug ("a sliver"), whether or not anything technically overflowed. Two `.fi` rows plus their gap. */
const MIN_SCROLLPORT = 150;

/** Each band is a different rule, so each gets a width. 580 is the reported one (compact single-pane,
 *  `.detail` is a fixed full-screen overlay); 900 is the first desktop width; 1440x620 is the case
 *  people forget, a laptop whose window is SHORT, where the chrome starves the feed on desktop too. */
const VIEWPORTS = [
  { width: 580, height: 740, why: "the reported narrow window" },
  { width: 760, height: 820, why: "large phone / small tablet" },
  { width: 900, height: 900, why: "the first desktop band" },
  { width: 1280, height: 900, why: "laptop desktop" },
  { width: 1440, height: 620, why: "desktop, but a SHORT window" },
];

/** The header is collapsible, and its two states are a ~200px swing in how much of the panel the
 *  chrome takes. Both are real: `expanded` is the desktop default and the state the bug was reported
 *  in (the preference persists in localStorage, so a narrow window inherits whatever was set on a
 *  wide one), `collapsed` is what a compact viewport opens with. Drive both at every width. */
const HEAD_STATES = [
  { key: "expanded", collapsed: false },
  { key: "collapsed", collapsed: true },
];

const LONG_CODE_LINE =
  "npm run probe:task-runs --prefix server -- 36fbdcc8-0000-4000-8000-000000000000 --with-cost --with-turns --format json | jq '.runs[] | select(.role==\"implementor\")'";
const LONG_URL = "https://github.com/Fearce/garden-gnome-orchestrator/blob/master/server/src/orchestrator/threadManager.ts#L1420-L1487";

/** One realistic body per index, cycling the shapes agent output actually takes. The wide ones are the
 *  point: a fenced block, a very long unbroken URL, and a table are the three things that have handed
 *  a feed a horizontal scrollbar. */
function bodyFor(i) {
  switch (i % 6) {
    case 0:
      return `Round ${i}: read the run trail and confirmed the cutoff was benign.\n\n\`\`\`bash\n${LONG_CODE_LINE}\n\`\`\``;
    case 1:
      return `Checked the reference at ${LONG_URL} and the resume path still keys on the durable marker.`;
    case 2:
      return `| role | model | turns | cost |\n| --- | --- | --- | --- |\n| implementor | claude-opus-5 (high effort) | 416 | $36.29 |\n| qa | claude-sonnet-5 (medium effort) | 100 | $4.11 |`;
    case 3:
      return `Now the fix. First the JSX wrapper:\n\n\`\`\`tsx\n<div className="detail-body" ref={scrollRef} onScroll={onFeedScroll}>\n  {/* memo, filter, deliverables and the feed all scroll together, ${"x".repeat(90)} */}\n</div>\n\`\`\``;
    case 4:
      return `Entry ${i}. A plain paragraph of prose, which is what most of the transcript is, long enough to wrap onto a second line at any of the widths this lab drives.`;
    default:
      return `Entry ${i}: **done**, see \`web/src/styles.css\` and \`web/src/components/ThreadDetail.tsx\`.`;
  }
}

/** A task shaped like the one in the bug report: parked in `review` (so nothing can spawn an agent),
 *  three roles' worth of filter chips, a pinned work memo, three deliverables, and a transcript long
 *  enough that the scroll is real rather than incidental. */
function seed(dataDir) {
  const db = new Database(path.join(dataDir, "orchestrator.sqlite"));
  const now = Date.now();
  db.prepare(
    "INSERT INTO threads (id, title, state, workspace, brief, raw_prompt, created_at, updated_at) VALUES (?, ?, 'review', ?, ?, ?, ?, ?)",
  ).run(
    TASK_ID,
    "Add hover card explanations in the replay viewer so every badge says what it means",
    SERVER_ROOT,
    "a seeded task",
    "a seeded task",
    now - 3_600_000,
    now,
  );

  const run = db.prepare(
    "INSERT INTO agent_runs (id, thread_id, role, model, account, effort, session_id, state, cost_usd, num_turns, started_at, ended_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'done', ?, ?, ?, ?)",
  );
  run.run("psl-run-director", TASK_ID, "director", "claude-opus-5", "logged-in", null, "psl-s0", 0.4, 3, now - 3_600_000, now - 3_590_000);
  run.run("psl-run-impl", TASK_ID, "implementor", "claude-opus-5", "logged-in", "high", "psl-s1", 36.29, 416, now - 3_500_000, now - 700_000);
  run.run("psl-run-qa", TASK_ID, "qa", "claude-sonnet-5", "logged-in", "medium", "psl-s2", 4.11, 100, now - 690_000, now - 60_000);

  const msg = db.prepare(
    "INSERT INTO messages (id, thread_id, run_id, role, kind, content, attachments, created_at) VALUES (?, ?, ?, ?, ?, ?, '[]', ?)",
  );
  const insertFeed = db.transaction(() => {
    msg.run("psl-m-0", TASK_ID, null, "user", "text", "Add hover card explanations in the replay viewer.", now - 3_600_000);
    for (let i = 1; i <= 500; i++) {
      const impl = i % 5 !== 0;
      msg.run(
        `psl-m-${i}`,
        TASK_ID,
        impl ? "psl-run-impl" : "psl-run-qa",
        impl ? "implementor" : "qa",
        i % 11 === 0 ? "tool" : "text",
        i % 11 === 0 ? JSON.stringify({ name: "Bash", input: { command: LONG_CODE_LINE } }) : bodyFor(i),
        now - 3_500_000 + i * 5_000,
      );
    }
  });
  insertFeed();

  const finding = db.prepare(
    "INSERT INTO findings (id, thread_id, from_run_id, from_role, kind, summary, detail, path, label, severity, routed, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)",
  );
  for (let i = 1; i <= 3; i++) {
    finding.run(
      `psl-d-${i}`,
      TASK_ID,
      "psl-run-impl",
      "implementor",
      "deliverable",
      `Replay viewer hover card ${i}`,
      "Rendered from the seeded lab fixture.",
      path.join(SERVER_ROOT, "package.json"),
      `Replay viewer hover card ${i}`,
      "info",
      now - 800_000 + i,
    );
  }
  finding.run(
    "psl-f-1",
    TASK_ID,
    "psl-run-impl",
    "implementor",
    "finding",
    "The panel's chrome is not scrollable, so the transcript keeps only the remainder.",
    `Reproduced at 580x740. See ${LONG_URL}`,
    null,
    null,
    "warning",
    now - 700_000,
  );

  db.prepare(
    `INSERT INTO implementation_memos
       (id, thread_id, run_id, work_revision, revision, outcome, handoff, report, diagnostic, model, account, deliverables, source, started_at, completed_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'completed', 'done', ?, NULL, 'claude-opus-5', 'logged-in', '[]', 'backfill', ?, ?, ?, ?)`,
  ).run(
    "psl-memo-1",
    TASK_ID,
    "psl-run-impl",
    "rev-2",
    2,
    "Every badge in the replay viewer now carries a hover card, the gates are green and both repos are in sync with their remotes.",
    now - 3_500_000,
    now - 700_000,
    now - 700_000,
    now - 700_000,
  );
  db.close();
}

/** Everything the two invariants need, in ONE evaluate: which element actually scrolls, how big its
 *  scrollport is, where the last transcript row and the inject bar sit, and (when the feed is wider
 *  than its column) which descendant is doing it. Read from live geometry and `getComputedStyle`,
 *  never from the rule we wrote: styles.css is not the only sheet in the bundle. */
function readPanel(page) {
  return page.evaluate(() => {
    const detail = document.querySelector(".detail");
    if (!detail) return null;
    const rect = (el) => {
      if (!el) return null;
      const b = el.getBoundingClientRect();
      return { top: b.top, bottom: b.bottom, left: b.left, right: b.right, width: b.width, height: b.height };
    };
    // The scrollport is whichever of the two candidates actually scrolls the transcript. Asking for it
    // by name would make this check pass on a structure that no longer scrolls at all.
    const candidates = [document.querySelector(".detail-body"), document.querySelector(".feed")].filter(Boolean);
    const scroller = candidates.find((el) => el.scrollHeight > el.clientHeight + 1) ?? candidates[candidates.length - 1] ?? null;
    const feed = document.querySelector(".feed");
    const rows = feed ? feed.querySelectorAll(".fi") : [];
    const last = rows.length ? rows[rows.length - 1] : null;

    // The widest thing sticking out of the feed's own column, named so a failure is actionable.
    const offenders = [];
    if (feed) {
      const limit = feed.getBoundingClientRect().right;
      for (const el of feed.querySelectorAll("*")) {
        const b = el.getBoundingClientRect();
        if (b.width > 0 && b.right > limit + 1) {
          offenders.push({
            tag: el.tagName.toLowerCase(),
            cls: el.className && typeof el.className === "string" ? el.className.slice(0, 60) : "",
            over: Math.round(b.right - limit),
          });
        }
      }
      offenders.sort((a, b) => b.over - a.over);
    }

    // The panel's floor is whichever composer this band actually shows: the full inject bar on
    // desktop, the collapsed "send direction" button on a phone (the bar itself is display:none
    // there, and a zero rect would otherwise satisfy every "inside the panel" assertion vacuously).
    const composer = [document.querySelector(".inject-bar"), document.querySelector(".mobile-inject-toggle")]
      .filter(Boolean)
      .map((el) => ({ el, b: el.getBoundingClientRect() }))
      .find((c) => c.b.height > 0);

    const filter = document.querySelector(".feed-filter");
    const cs = scroller ? getComputedStyle(scroller) : null;
    return {
      detail: { ...rect(detail), scrollHeight: detail.scrollHeight, clientHeight: detail.clientHeight },
      scroller: scroller
        ? {
            cls: typeof scroller.className === "string" ? scroller.className : "",
            clientHeight: scroller.clientHeight,
            scrollHeight: scroller.scrollHeight,
            clientWidth: scroller.clientWidth,
            scrollWidth: scroller.scrollWidth,
            scrollbarColor: cs.scrollbarColor,
            scrollbarWidth: cs.scrollbarWidth,
          }
        : null,
      feed: feed ? { ...rect(feed), clientWidth: feed.clientWidth, scrollWidth: feed.scrollWidth, rows: rows.length } : null,
      lastRow: rect(last),
      composer: composer ? { cls: typeof composer.el.className === "string" ? composer.el.className : "", ...rect(composer.el) } : null,
      filter: filter
        ? {
            ...rect(filter),
            clientWidth: filter.clientWidth,
            scrollWidth: filter.scrollWidth,
            scrollbarWidth: getComputedStyle(filter).scrollbarWidth,
          }
        : null,
      // The Director rail is the same shape as this panel (an overflow:hidden column with a
      // flex:1 transcript between a header and a composer), so it is swept here too. It is hidden
      // in the single-pane bands, hence the null.
      railTranscript: (() => {
        const t = document.querySelector(".transcript");
        return t && t.getBoundingClientRect().height > 0 ? { clientHeight: t.clientHeight, scrollHeight: t.scrollHeight } : null;
      })(),
      memo: rect(document.querySelector(".implementation-memo-pin")),
      deliverables: rect(document.querySelector(".deliverables")),
      offenders: offenders.slice(0, 4),
      // Fenced code is the one thing in a transcript that used to travel sideways legitimately (its
      // own `overflow-x: auto`). On a 290px panel that is a line you can only read by dragging a
      // scrollbar, so it wraps now, and this is what says so.
      sidewaysCode: feed
        ? [...feed.querySelectorAll("pre")].filter((el) => el.scrollWidth > el.clientWidth + 1).length
        : 0,
      colorScheme: getComputedStyle(document.documentElement).colorScheme,
      viewport: { width: window.innerWidth, height: window.innerHeight },
    };
  });
}

/** The same bug class, swept across the WHOLE console rather than the one panel it was reported in.
 *  A "shell" here is any tall flex/grid column that clips its overflow: by construction it cannot
 *  scroll, so if its content is taller than its box, that content is not hidden, it is GONE, with no
 *  scrollbar to say so. `.detail` was one; `.rail`, `.workbench` and `.app` are the same shape, and a
 *  short window is what exposes them. Small clippers are excluded because `overflow: hidden` is also
 *  how this stylesheet does ellipsis and line-clamp, which are deliberate. */
function readShells(page) {
  return page.evaluate(() => {
    const label = (el) => {
      const cls = typeof el.className === "string" && el.className ? `.${el.className.trim().split(/\s+/).join(".")}` : "";
      return `${el.tagName.toLowerCase()}${cls}`.slice(0, 70);
    };
    const sheared = [];
    for (const el of document.querySelectorAll("*")) {
      const cs = getComputedStyle(el);
      const isColumnShell = cs.display === "grid" || (cs.display === "flex" && cs.flexDirection === "column");
      if (!isColumnShell) continue;
      if (cs.overflowY !== "hidden" && cs.overflowY !== "clip") continue;
      const box = el.getBoundingClientRect();
      if (box.height < 200) continue; // an ellipsis/line-clamp box, not a layout shell
      const over = el.scrollHeight - el.clientHeight;
      if (over > 1) sheared.push({ sel: label(el), over: Math.round(over), height: Math.round(box.height) });
    }
    return sheared;
  });
}

/** Scroll the panel to its end and report whether the end of the transcript actually came into view. */
async function scrollToEnd(page) {
  await page.evaluate(() => {
    const candidates = [document.querySelector(".detail-body"), document.querySelector(".feed")].filter(Boolean);
    const el = candidates.find((c) => c.scrollHeight > c.clientHeight + 1) ?? candidates[candidates.length - 1];
    if (el) el.scrollTop = el.scrollHeight;
  });
  await page.waitForTimeout(180);
  return readPanel(page);
}

function assertPanel(check, tag, P) {
  if (!P) return check(`${tag} · detail panel mounted`, false, "no .detail in the DOM");
  const px = (n) => `${Math.round(n)}px`;
  const { detail, scroller, feed, composer } = P;

  // `.detail` is overflow:hidden, so anything past its box is gone rather than scrollable.
  check(
    `${tag} · panel has nothing sheared off the bottom (scroll ${px(detail.scrollHeight)} <= client ${px(detail.clientHeight)})`,
    detail.scrollHeight <= detail.clientHeight + SLACK,
    `${px(detail.scrollHeight - detail.clientHeight)} of the panel is outside its own box`,
  );

  check(
    `${tag} · the transcript has a usable scrollport (${px(scroller ? scroller.clientHeight : 0)} >= ${MIN_SCROLLPORT}px)`,
    !!scroller && scroller.clientHeight >= MIN_SCROLLPORT,
    scroller ? `the scrollport is ${px(scroller.clientHeight)}, the chrome above it took the rest` : "nothing scrolls in the panel",
  );

  check(
    `${tag} · the transcript actually overflows, so this width proves something`,
    !!scroller && scroller.scrollHeight > scroller.clientHeight + SLACK,
    "the seeded 500-entry feed fits without scrolling: the fixture, not the panel, is wrong",
  );

  // The other axis: agent output is full of long command lines, and a flex item's automatic minimum
  // size is content-based, so one of them silently widens the column instead of wrapping.
  check(
    `${tag} · the feed does not scroll sideways (scroll ${px(feed ? feed.scrollWidth : 0)} <= client ${px(feed ? feed.clientWidth : 0)})`,
    !!feed && feed.scrollWidth <= feed.clientWidth + SLACK,
    feed
      ? `${px(feed.scrollWidth - feed.clientWidth)} too wide. widest: ${P.offenders.map((o) => `${o.tag}.${o.cls} (+${o.over}px)`).join(", ") || "none past the edge"}`
      : "no .feed",
  );
  check(
    `${tag} · no code block in the transcript scrolls sideways (${feed ? feed.rows : 0} rows rendered)`,
    P.sidewaysCode === 0,
    `${P.sidewaysCode} fenced block(s) are wider than the column instead of wrapping`,
  );
  check(
    `${tag} · the panel scrollport does not scroll sideways`,
    !!scroller && scroller.scrollWidth <= scroller.clientWidth + SLACK,
    scroller ? `${px(scroller.scrollWidth - scroller.clientWidth)} too wide` : "no scrollport",
  );

  // The composer is the panel's floor: it must stay pinned and wholly inside the panel.
  check(
    `${tag} · the composer is pinned inside the panel (${px(composer ? composer.bottom : 0)} vs panel ${px(detail.bottom)})`,
    !!composer && composer.bottom <= detail.bottom + SLACK && composer.top >= detail.top - SLACK,
    composer ? `the composer sits ${px(composer.bottom - detail.bottom)} below the panel` : "no visible composer in the panel",
  );

  // The filter strip travels sideways by design in the narrow bands. What it must not do is show a
  // scrollbar for it: that bar is the pale line reported across the top of the transcript.
  check(
    `${tag} · the filter strip carries no scrollbar of its own (scrollbar-width: ${P.filter ? P.filter.scrollbarWidth : "?"})`,
    !!P.filter && P.filter.scrollbarWidth === "none",
    P.filter ? `.feed-filter overflows by ${px(P.filter.scrollWidth - P.filter.clientWidth)} with scrollbar-width: ${P.filter.scrollbarWidth}` : "no .feed-filter",
  );

  // Themed scrollbars: the report is that the native light chrome is jarring on the dark theme.
  check(
    `${tag} · the scrollport's scrollbar is themed (width ${scroller ? scroller.scrollbarWidth : "?"}, color ${scroller ? scroller.scrollbarColor : "?"})`,
    !!scroller && scroller.scrollbarWidth === "thin" && scroller.scrollbarColor !== "auto",
    scroller ? `scrollbar-width: ${scroller.scrollbarWidth}, scrollbar-color: ${scroller.scrollbarColor}` : "no scrollport",
  );
  // The sibling panel with the same shape: when this band shows the Director rail, its transcript
  // must be a transcript too, not whatever the composer and header leave behind.
  if (P.railTranscript) {
    check(
      `${tag} · the director rail's transcript is usable too (${px(P.railTranscript.clientHeight)} >= ${MIN_SCROLLPORT}px)`,
      P.railTranscript.clientHeight >= MIN_SCROLLPORT,
      `the rail transcript is ${px(P.railTranscript.clientHeight)}`,
    );
  }
  check(
    `${tag} · the document declares a dark color-scheme (so native chrome matches)`,
    P.colorScheme.includes("dark"),
    `color-scheme is "${P.colorScheme}"`,
  );
}

/** After scrolling to the end: the last transcript row must be visible, and the memo/deliverable block
 *  must be REACHABLE, i.e. it scrolled away rather than permanently occupying the panel. */
function assertScrolledToEnd(check, tag, P) {
  if (!P) return check(`${tag} · panel still mounted after scrolling`, false, "no .detail");
  const px = (n) => `${Math.round(n)}px`;
  const { scroller, lastRow, composer, detail } = P;
  const floor = composer ? composer.top : detail.bottom;
  check(
    `${tag} · scrolling reaches the end of the transcript`,
    !!scroller && !!lastRow && lastRow.bottom <= floor + SLACK && lastRow.top < floor,
    lastRow ? `the last entry ends at ${px(lastRow.bottom)}, past the ${px(floor)} floor` : "no feed rows rendered",
  );
  check(
    `${tag} · the composer is still on screen at the end of the scroll`,
    !!composer && composer.bottom <= detail.bottom + SLACK,
    composer ? `the composer ends at ${px(composer.bottom)} against a panel floor of ${px(detail.bottom)}` : "no visible composer",
  );
}

async function openPanel(browser, viewport, head) {
  const page = await browser.newPage({ viewport: { width: viewport.width, height: viewport.height } });
  await page.request.post(`${BASE}/api/login`, { data: { password: authPassword() } });
  // addInitScript, not an evaluate after goto: the collapse preference is read once, in the
  // component's initial state, so a value written after that runs is simply never seen.
  await page.addInitScript((collapsed) => localStorage.setItem("orch-head-collapsed", collapsed ? "1" : "0"), head.collapsed);
  // Not `networkidle`: the selected task pulls attachments and the app polls /api/voice/status, so idle
  // is data-dependent and has blown a 30s budget on a busy box (nightly-quality-sweep.md step 6).
  await page.goto(`${BASE}/`, { timeout: 45_000 });
  // 45s, matching the navigation budget: the board card arrives with the socket's first frame, and on
  // a box already running agents (or another lab) that has been measured in the tens of seconds. A 20s
  // wait here reds a run for load, which says nothing about the layout this lab is measuring.
  await page.waitForSelector(".workbench", { timeout: 45_000 });
  await page.click(".card", { timeout: 45_000 });
  // Wait on the panel, then on rows ATTACHED rather than visible: at the widths this lab exists for,
  // the broken panel renders its rows into a scrollport with no room, and Playwright's "visible" is
  // then indistinguishable from "the feed never loaded" (a red that says nothing about the bug).
  await page.waitForSelector(".detail", { timeout: 20_000 });
  await page.waitForSelector(".detail .fi", { state: "attached", timeout: 20_000 });
  await page.waitForTimeout(500); // one settle after the feed's render window fills
  return page;
}

function parseArgs(argv) {
  const args = { shot: null, keep: false, viewports: VIEWPORTS };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--shot") args.shot = argv[++i];
    else if (argv[i] === "--keep") args.keep = true;
    else if (argv[i] === "--width") {
      const w = Number(argv[++i]);
      args.viewports = VIEWPORTS.filter((v) => v.width === w);
      if (!args.viewports.length) args.viewports = [{ width: w, height: 800, why: "requested width" }];
    }
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  requireBuild();
  if (args.shot) fs.mkdirSync(args.shot, { recursive: true });

  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "panel-scroll-lab-"));
  console.log(`panel-scroll-lab: 500-entry transcript + work memo + 3 deliverables on ${BASE}`);
  const check = createChecks();
  try {
    await boot({ dataDir, port: PORT });
    killInstance(PORT); // the first boot only creates the schema; seed, then boot against the seeded DB
    seed(dataDir);
    await boot({ dataDir, port: PORT });

    const browser = await loadChromium().launch();
    try {
      for (const vp of args.viewports) {
        for (const head of HEAD_STATES) {
          const tag = `${vp.width}x${vp.height} ${head.key}-head`;
          const page = await openPanel(browser, vp, head);
          const top = await readPanel(page);
          console.log(
            `\n  ${tag} (${vp.why}): scrollport ${Math.round(top?.scroller?.clientHeight ?? 0)}px of ${Math.round(top?.detail?.height ?? 0)}px panel, ` +
              `feed ${Math.round(top?.feed?.scrollWidth ?? 0)}/${Math.round(top?.feed?.clientWidth ?? 0)}px wide`,
          );
          assertPanel(check, tag, top);
          const sheared = await readShells(page);
          check(
            `${tag} · no clipping shell in the console is taller than its own box`,
            sheared.length === 0,
            sheared.map((s) => `${s.sel} overflows its ${s.height}px box by ${s.over}px`).join("; "),
          );
          if (args.shot) await page.screenshot({ path: path.join(args.shot, `${vp.width}x${vp.height}-${head.key}-top.png`) });

          const end = await scrollToEnd(page);
          assertScrolledToEnd(check, tag, end);
          if (args.shot) await page.screenshot({ path: path.join(args.shot, `${vp.width}x${vp.height}-${head.key}-scrolled.png`) });
          await page.close();
        }
      }
    } finally {
      await browser.close();
    }
  } finally {
    killInstance(PORT);
    if (args.keep) console.log(`  kept ${dataDir}`);
    else fs.rmSync(dataDir, { recursive: true, force: true });
  }
  if (args.shot) console.log(`\n  screenshots: ${args.shot}`);
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
