/**
 * Headless check: every top-bar account chip (incl. Grok SuperGrok meters) is
 * reachable at common desktop widths. Catches the "usage works in WS but chip
 * is clipped under .app overflow:hidden" class of bugs.
 *
 * Each width is measured twice: as the bar happens to look, and again with every elastic sibling at
 * its widest ("reconnecting…" in place of "live"). The second pass is the one that catches a wrap
 * breakpoint set at the measured minimum.
 *
 * Usage (repo root or web/):
 *   node web/scripts/check-accounts-visible.cjs
 *   node web/scripts/check-accounts-visible.cjs --explain   # print the fit arithmetic per width
 *   ORCH_URL=http://127.0.0.1:4317 ORCH_PASSWORD=<your-pw> node web/scripts/check-accounts-visible.cjs
 *
 * The login password defaults to AUTH_PASSWORD from server/.env; override with ORCH_PASSWORD.
 * Playwright is resolved from a local/global install (or PLAYWRIGHT_PATH).
 *
 * Exit 0 = pass; non-zero = print failing geometry and exit 1.
 */
const fs = require("fs");
const path = require("path");

function loadChromium() {
  const candidates = [process.env.PLAYWRIGHT_PATH, "playwright", "playwright-core"].filter(Boolean);
  for (const mod of candidates) {
    try {
      return require(mod).chromium;
    } catch {
      /* try next */
    }
  }
  try {
    const root = require("child_process").execSync("npm root -g", { windowsHide: true }).toString().trim();
    return require(path.join(root, "playwright")).chromium;
  } catch {
    throw new Error(
      "Playwright not found. Install it (`npm i -g playwright`) or set PLAYWRIGHT_PATH to its module dir.",
    );
  }
}

function resolvePassword() {
  if (process.env.ORCH_PASSWORD) return process.env.ORCH_PASSWORD;
  try {
    const envPath = path.resolve(__dirname, "../../server/.env");
    const line = fs
      .readFileSync(envPath, "utf8")
      .split(/\r?\n/)
      .find((l) => /^AUTH_PASSWORD=/.test(l));
    if (line) return line.slice("AUTH_PASSWORD=".length).trim();
  } catch {
    /* no .env — leave blank, the login will simply fail with a clear HTTP code */
  }
  return "";
}

const chromium = loadChromium();
const BASE = process.env.ORCH_URL || "http://127.0.0.1:4317";
const PASSWORD = resolvePassword();
const EXPLAIN = process.argv.includes("--explain");
// 1750 is the last wrapped width and 1800 the first inline one (the styles.css bound), so the pair
// straddles the breakpoint — the widths that catch a chip added since the bound was last measured.
// 1920 is the common wide monitor, where the office lane has room to grow gnomes beside the chips.
const WIDTHS = (process.env.ORCH_WIDTHS || "1280,1440,1600,1750,1800,1920")
  .split(",")
  .map((s) => parseInt(s.trim(), 10))
  .filter((n) => n > 0);
// Playwright's default is 30s, which this box loses: with agent runs live the machine sits near
// 100% CPU and a cold navigation has measured 28s while the server answered /api/health in 1ms.
// console-smoke.cjs already allows 45s for the same reason.
const NAV_TIMEOUT_MS = 45_000;
// Below this the compact layout takes over and DELIBERATELY makes the strip a full-width,
// horizontally-scrolling row — a scrollable strip there is the design, not the clipping this
// checks for. Tracks the compact bound in styles.css (raised 768 → 900 so a portrait tablet
// reaches it); the touch layout below it is what `npm run tablet-lab --prefix server` covers.
const DESKTOP_MIN = 900;

async function measure(page) {
  return page.evaluate((desktopMin) => {
    const vw = window.innerWidth;
    const accounts = document.querySelector(".accounts");
    if (!accounts) return { ok: false, reason: "no .accounts strip (no chips configured?)" };

    const chips = [...accounts.querySelectorAll(".acct")].map((el) => {
      const r = el.getBoundingClientRect();
      return {
        label: (el.querySelector(".acct-label")?.textContent || el.innerText.slice(0, 24)).trim(),
        text: el.innerText.replace(/\s+/g, " ").trim(),
        left: r.left,
        right: r.right,
        width: r.width,
      };
    });

    // Scroll the strip fully right so the last chip (usually Grok) is in the scroller.
    accounts.scrollLeft = accounts.scrollWidth;
    const after = [...accounts.querySelectorAll(".acct")].map((el) => {
      const r = el.getBoundingClientRect();
      const ar = accounts.getBoundingClientRect();
      const inScroller = r.left >= ar.left - 1 && r.right <= ar.right + 1;
      const inViewport = r.left >= -1 && r.right <= vw + 1;
      return {
        label: (el.querySelector(".acct-label")?.textContent || "").trim(),
        left: r.left,
        right: r.right,
        inScroller,
        inViewport,
        fullyVisible: inScroller && inViewport,
        text: el.innerText.replace(/\s+/g, " ").trim(),
      };
    });

    const grok = after.find((c) => /grok/i.test(c.label) || /grok/i.test(c.text));
    const canScroll = accounts.scrollWidth > accounts.clientWidth + 2;
    const failures = [];
    if (chips.length === 0) failures.push("zero chips rendered");
    // Nothing in the bar may be pushed off-screen either. When the chips stop shrinking, an
    // over-full row spends the overflow on whatever sits last instead — the live indicator.
    const bar = document.querySelector(".topbar");
    for (const el of bar ? [...bar.children] : []) {
      const r = el.getBoundingClientRect();
      if (r.width > 0 && r.right > vw + 1) {
        const cls = el.className.toString().split(" ")[0] || el.tagName.toLowerCase();
        failures.push(`.${cls} pushed off-screen (right=${Math.round(r.right)} vw=${vw})`);
      }
    }
    // On desktop every chip must be readable WITHOUT scrolling — a scrollable strip means the bar is
    // hiding usage until the operator drags it, which is the clipping this check exists to catch.
    if (canScroll && vw >= desktopMin) {
      failures.push(`strip is clipped: ${accounts.scrollWidth}px of chips in a ${accounts.clientWidth}px box (widen the wrap breakpoint)`);
    }
    for (const c of after) {
      if (!c.fullyVisible) {
        failures.push(
          `chip "${c.label}" not fully visible after scroll (left=${Math.round(c.left)} right=${Math.round(c.right)} vw=${vw})`,
        );
      }
    }
    if (grok && !/7d|mo|SUPERGROK|polling usage/i.test(grok.text)) {
      failures.push(`Grok chip lacks usage affordance: ${grok.text.slice(0, 120)}`);
    }

    // What the single-row layout costs, so the next bound is derived instead of bisected. An item
    // that GROWS (`.office`, flex-grow > 0) is measured at its content, not its rendered box — it
    // has already swallowed the leftover space, and it yields all of it again under pressure. So
    // `required` is the row's hard floor (elastic items at zero) and `wants` is it uncompressed.
    const barStyle = bar ? getComputedStyle(bar) : null;
    const items = bar
      ? [...bar.children].map((el) => {
          const grows = parseFloat(getComputedStyle(el).flexGrow) > 0;
          const content = Math.max(el.scrollWidth, ...[...el.children].map((c) => c.scrollWidth), 0);
          return {
            cls: el.className.toString().split(" ")[0] || el.tagName.toLowerCase(),
            w: Math.round(el.getBoundingClientRect().width),
            grows,
            content: Math.round(content),
          };
        })
      : [];
    const gap = barStyle ? Math.round(parseFloat(barStyle.columnGap) || 0) : 0;
    const pad = barStyle
      ? Math.round((parseFloat(barStyle.paddingLeft) || 0) + (parseFloat(barStyle.paddingRight) || 0))
      : 0;
    // Wrapped = the strip sits below the brand rather than beside it. Comparing row tops directly
    // is a false signal: children of one row have different tops because they are centre-aligned.
    const brandBottom = document.querySelector(".brand")?.getBoundingClientRect().bottom ?? 0;
    const rows = accounts.getBoundingClientRect().top >= brandBottom - 1 ? 2 : 1;
    const chipsW = accounts.scrollWidth;
    const others = items.filter((i) => i.cls !== "accounts");
    const fixedW = others.filter((i) => !i.grows).reduce((s, i) => s + i.w, 0);
    const elasticW = others.filter((i) => i.grows).reduce((s, i) => s + i.content, 0);
    const chrome = chipsW + gap * Math.max(items.length - 1, 0) + pad;
    const required = fixedW + chrome;
    const wants = required + elasticW;

    return {
      ok: failures.length === 0,
      reason: failures.join("; ") || null,
      vw,
      chipCount: chips.length,
      canScroll,
      accountsW: accounts.clientWidth,
      contentW: accounts.scrollWidth,
      after,
      fit: {
        items, gap, pad, chipsW, fixedW, elasticW, required, wants,
        slack: vw - required,
        wrapped: rows > 1,
        wrapAllowed: barStyle ? barStyle.flexWrap !== "nowrap" : false,
      },
    };
  }, DESKTOP_MIN);
}

/**
 * Log in, load the console, and wait for the chips — the sequence both checks need.
 *
 * Retries once on a fresh page, because a lost navigation race is not a chip verdict. This probe
 * runs against prod on a box that is often saturated (live agent runs, a web auto-build), and a
 * timeout there reports as a failing width while saying nothing about geometry — the same "red step
 * that says nothing about chips" the networkidle fix removed. A second failure still fails: a
 * console that cannot load twice in a row is a real problem, not a busy machine.
 *
 * Resolves `{ page }` on success, or `{ page: null, reason }` with the page already closed.
 */
async function openConsole(browser, viewport, tag) {
  const ATTEMPTS = 2;
  let lastError = null;
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    const page = await browser.newPage({ viewport });
    try {
      const login = await page.request.post(`${BASE}/api/login`, { data: { password: PASSWORD } });
      if (!login.ok()) {
        await page.close();
        return { page: null, reason: `login HTTP ${login.status()}` };
      }
      // Not networkidle: the selected thread pulls a burst of multi-MB /api/attachment images and the
      // app polls /api/voice/status, so idle is data-dependent and can outlast any budget. The chips
      // themselves are the ready signal this check needs.
      await page.goto(`${BASE}/?${tag}=${Date.now()}`, {
        waitUntil: "domcontentloaded",
        timeout: NAV_TIMEOUT_MS,
      });
      await page.waitForSelector(".accounts .acct", { timeout: 20_000 });
      await page.waitForTimeout(2500); // let usage land over the WS before measuring
      return { page, retried: attempt > 1 };
    } catch (e) {
      lastError = String(e.message || e).split("\n")[0];
      await page.close();
    }
  }
  return { page: null, reason: `${lastError} (${ATTEMPTS} attempts)` };
}

/**
 * The invariant behind every width in the list, and the one sampling can't guarantee: where the bar
 * can no longer WRAP, one row must still fit the bar at its widest. Sampling alone misses this —
 * move the bound and the sample widths move with it, away from the range the old bound got wrong.
 *
 * Bisect for where wrapping is switched off (`flex-wrap: nowrap`, whatever media query produces it)
 * rather than for where the strip happens to be inline: below the bound wrapping is the escape
 * valve, so "inline" there is always floor-plus-a-pixel by construction and says nothing.
 */
async function checkBound(browser) {
  const { page, reason: openFailed } = await openConsole(browser, { width: 2560, height: 800 }, "checkBound");
  if (!page) return { ok: false, reason: `could not measure the bound: ${openFailed}` };
  try {
    await widenChrome(page);

    const at = async (w) => {
      await page.setViewportSize({ width: w, height: 800 });
      await page.waitForTimeout(120);
      return measure(page);
    };
    const LO = DESKTOP_MIN;
    const HI = 2560;
    if (!(await at(LO)).fit?.wrapAllowed) {
      return { ok: true, note: `the bar cannot wrap even at ${LO}px — the strip has no escape valve at all` };
    }
    if ((await at(HI)).fit?.wrapAllowed) {
      return { ok: true, note: `wrapping stays enabled up to ${HI}px — no locked single-row regime to check` };
    }
    let lo = LO; // wrapping allowed here
    let hi = HI; // wrapping switched off here
    while (hi - lo > 1) {
      const mid = Math.floor((lo + hi) / 2);
      if ((await at(mid)).fit?.wrapAllowed) lo = mid;
      else hi = mid;
    }
    const floor = (await at(hi)).fit.required;
    const margin = hi - floor;
    return {
      ok: margin >= 0,
      bound: hi,
      floor,
      margin,
      reason:
        margin >= 0
          ? null
          : `wrapping switches off at ${hi}px, but one row needs ${floor}px there with the socket` +
            ` dropped — ${-margin}px short, so a reconnect clips the chips (or pushes the bar off-screen)`,
      thin: margin >= 0 && margin < 25,
    };
  } catch (e) {
    return { ok: false, reason: `could not measure the bound: ${String(e.message || e).split("\n")[0]}` };
  } finally {
    await page.close();
  }
}

/** The widest text each elastic sibling can render — the state a bound has to survive, not the
 *  one that happens to be on screen. The socket label alone swings 41px → 100px. */
async function widenChrome(page) {
  return page.evaluate(() => {
    const conn = document.querySelector(".conn");
    if (conn && conn.lastChild) conn.lastChild.textContent = "reconnecting…";
    return true;
  });
}

async function checkWidth(browser, w) {
  const { page, reason: openFailed, retried } = await openConsole(
    browser,
    { width: w, height: 800 },
    "checkAccounts",
  );
  if (!page) return { w, ok: false, reason: `could not measure: ${openFailed}` };
  try {
    const live = await measure(page);
    // Then again with every elastic sibling at its widest. A bound measured only against the state
    // that happened to be on screen holds until the socket drops: that is exactly how the chips
    // shipped one pixel from clipping and hid their meters on every reconnect (2026-08-13).
    await widenChrome(page);
    const worst = await measure(page);
    return { w, ...live, worst, retried };
  } catch (e) {
    // First line only — Playwright appends a multi-line call log that would bury the other widths.
    return { w, ok: false, reason: `could not measure: ${String(e.message || e).split("\n")[0]}` };
  } finally {
    await page.close();
  }
}

async function main() {
  const browser = await chromium.launch({ headless: true });
  const results = [];
  let bound;
  try {
    // One bad width reports itself and the rest still run — a partial answer beats a bare stack.
    for (const w of WIDTHS) results.push(await checkWidth(browser, w));
    bound = await checkBound(browser);
  } finally {
    await browser.close();
  }

  let failed = false;
  for (const r of results) {
    const worstBad = r.worst && !r.worst.ok;
    const tag = r.ok && !worstBad ? "PASS" : "FAIL";
    if (tag === "FAIL") failed = true;
    console.log(
      `[${tag}] ${r.w}px chips=${r.chipCount ?? "?"} scroll=${r.canScroll ? "yes" : "no"} ` +
        `accounts=${r.accountsW ?? "?"}/${r.contentW ?? "?"}${r.retried ? " (nav retried — busy box)" : ""} ` +
        `${r.reason ? "— " + r.reason : ""}`,
    );
    if (worstBad) {
      console.log(`         !! with the socket dropped ("reconnecting…"): ${r.worst.reason}`);
    }
    if (r.after) {
      for (const c of r.after) {
        console.log(
          `         ${c.fullyVisible ? "ok" : "!!"} ${c.label}: ${c.text.slice(0, 100)}`,
        );
      }
    }
    if (EXPLAIN) explainFit(r);
  }

  if (bound) {
    if (!bound.ok) failed = true;
    const detail = bound.note
      ? bound.note
      : `wrapping switches off at ${bound.bound}px, single-row floor is ${bound.floor}px ` +
        `(margin ${bound.margin}px)` +
        (bound.thin ? " — thin; the next chip or a longer label will break it" : "");
    console.log(`[${bound.ok ? "PASS" : "FAIL"}] bound — ${bound.reason || detail}`);
  }
  process.exit(failed ? 1 : 0);
}

/** `--explain`: the arithmetic behind a bound, so the next one is derived rather than bisected. */
function explainFit(r) {
  for (const [state, m] of [["live", r], ["worst-chrome", r.worst]]) {
    if (!m || !m.fit) continue;
    const f = m.fit;
    console.log(
      `         [${state}] ${f.wrapped ? "strip on its own row" : "single row"} — chips ${f.chipsW}` +
        ` + fixed ${f.fixedW} + gaps ${f.gap * Math.max(f.items.length - 1, 0)} + padding ${f.pad}` +
        ` = ${f.required} floor, ${r.w} available (slack ${f.slack})`,
    );
    console.log(
      `         [${state}] one row fits from ~${f.required}px (elastic items at zero), ~${f.wants}px` +
        ` uncompressed — put the wrap bound above the second number, not the first`,
    );
    console.log(
      `         [${state}] ` + f.items.map((i) => `${i.cls}:${i.w}${i.grows ? `(elastic, wants ${i.content})` : ""}`).join(" "),
    );
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
