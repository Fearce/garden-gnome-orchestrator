/**
 * Read-only browser probe for the desktop usage line in the board's existing padding.
 * Checks short bars, zero added height, chip reachability, and header fit while reconnecting.
 * node web/scripts/check-accounts-visible.cjs [--explain]
 * ORCH_URL / ORCH_PASSWORD override the local server and server/.env password.
 */
const fs = require("fs");
const path = require("path");

// Shared with the labs and console-smoke (server/scripts/findPlaywright.cjs): this was a third
// hand-copy of the same lookup, and all three missed the same root.
const { loadChromium } = require("../../server/scripts/findPlaywright.cjs");

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
const WIDTHS = (process.env.ORCH_WIDTHS || "1280,1440,1600,1850,1900,1920")
  .split(",")
  .map((s) => parseInt(s.trim(), 10))
  .filter((n) => n > 0);
// Playwright's default is 30s, which this box loses: with agent runs live the machine sits near
// 100% CPU and a cold navigation has measured 28s while the server answered /api/health in 1ms.
// console-smoke.cjs already allows 45s for the same reason.
const NAV_TIMEOUT_MS = 45_000;
async function measure(page) {
  return page.evaluate(() => {
    const vw = innerWidth;
    const accounts = document.querySelector('.board-usage .accounts');
    if (!accounts) return { ok: false, reason: 'no desktop usage strip (no chips configured?)' };
    const failures = [];
    const rect = accounts.getBoundingClientRect();
    const board = document.querySelector('.board').getBoundingClientRect();
    const tabs = document.querySelector('.board-head').getBoundingClientRect();
    const canScroll = accounts.scrollWidth > accounts.clientWidth + 2;
    // A narrow board (director/detail open) can scroll horizontally; every chip must be reachable.
    const after = [...accounts.querySelectorAll('.acct')].map(el => {
      accounts.scrollLeft = el.offsetLeft - accounts.offsetLeft;
      const r = el.getBoundingClientRect();
      return {
        label: el.querySelector('.acct-label')?.textContent.trim(),
        text: el.innerText.replace(/\s+/g, ' ').trim(),
        fullyVisible: r.left >= rect.left - 1 && r.right <= rect.right + 1 && r.left >= 0 && r.right <= vw + 1,
        height: r.height,
      };
    });
    accounts.scrollLeft = 0;
    if (!after.length) failures.push('zero chips rendered');
    for (const c of after) {
      if (!c.fullyVisible) failures.push(`chip "${c.label}" cannot be fully reached`);
      if (c.height > 16.1) failures.push(`chip "${c.label}" exceeds the existing gap`);
    }
    for (const el of document.querySelector('.topbar')?.children ?? []) {
      const r = el.getBoundingClientRect();
      if (r.width > 0 && (r.left < -1 || r.right > vw + 1)) failures.push(`header ${el.className} pushed off-screen`);
    }
    if (rect.top < board.top || rect.bottom > tabs.top) failures.push('usage sits outside the existing board padding');
    const positions = () => ['.topbar','.workbench','.rail','.board-head','.card'].map(s => document.querySelector(s)?.getBoundingClientRect().top);
    const before = positions();
    const host = document.querySelector('.board-usage');
    host.style.display = 'none';
    const without = positions();
    host.style.display = '';
    if (!before.every((v,i) => v === without[i])) failures.push('usage moves the header, director, tabs or cards');
    const tracks = [...accounts.querySelectorAll('.meter-track')].map(el => el.getBoundingClientRect().width);
    if (tracks.some(w => w < 12 || w > 20)) failures.push('usage tracks must remain short and visible');
    return { ok: !failures.length, reason: failures.join('; ') || null, vw, chipCount: after.length,
      canScroll, accountsW: accounts.clientWidth, contentW: accounts.scrollWidth, after, height: rect.height, tracks };
  });
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
  try {
    // One bad width reports itself and the rest still run — a partial answer beats a bare stack.
    for (const w of WIDTHS) results.push(await checkWidth(browser, w));
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

  process.exit(failed ? 1 : 0);
}

/** --explain shows the actual available panel width, including director/detail pressure. */
function explainFit(r) {
  for (const [state, m] of [["live", r], ["reconnecting", r.worst]]) {
    if (!m || m.accountsW == null) continue;
    console.log(`         [${state}] ${m.height}px in existing padding; ${m.contentW}px of chips / ${m.accountsW}px available; tracks ${m.tracks.join(', ')}px`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
