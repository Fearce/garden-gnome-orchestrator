/**
 * Read-only smoke check: the console actually loads, connects, and renders.
 *
 * A `/api/health` 200 proves the SERVER answers; it says nothing about whether the console
 * boots. A bundle that throws on mount, a WS that never connects, or a store that renders an
 * empty shell all keep health green — so a nightly sweep can report GREEN over a dead UI.
 * This closes that gap and nothing else: chip GEOMETRY belongs to check-accounts-visible.cjs
 * (4 widths, clipping), and a UI *change* belongs on a throwaway instance, never here.
 *
 * SAFE AGAINST LIVE PROD — BY CONSTRUCTION, AND IT MUST STAY THAT WAY.
 * This script never clicks, types, or navigates anywhere but the root. Live prod frequently
 * has a pending director question up as a `.scrim` + `.modal` that swallows pointer events;
 * clicking through it would answer or dismiss a real decision that belongs to the owner
 * (.claude/rules/verify-a-ui-change-shipped.md). A pending modal is REPORTED here, never
 * touched. If you extend this file, do not add an interaction — fork a throwaway instance.
 *
 * Usage:
 *   npm run probe:console                       (repo root)
 *   npm run probe:console -- --shot out.png     save a screenshot (sweep-report evidence)
 *   ORCH_URL=http://127.0.0.1:4317 ORCH_PASSWORD=<pw> node web/scripts/console-smoke.cjs
 *
 * Password defaults to AUTH_PASSWORD from server/.env. Exit 0 = pass, 1 = a real failure.
 */
const fs = require("fs");
const path = require("path");

// Ignorable request noise: absent favicons and the dev-only HMR socket are not console health.
const IGNORABLE_REQUEST = /favicon|\/@vite\/|hot-update/i;

function loadChromium() {
  const candidates = [process.env.PLAYWRIGHT_PATH, "playwright", "playwright-core"].filter(Boolean);
  for (const mod of candidates) {
    try {
      return require(mod).chromium;
    } catch {
      /* try next */
    }
  }
  // NODE_PATH is unset in agent shells, so a bare require misses a global install — resolve it.
  try {
    const root = require("child_process").execSync("npm root -g").toString().trim();
    return require(path.join(root, "playwright")).chromium;
  } catch {
    throw new Error("Playwright not found. Install it (`npm i -g playwright`) or set PLAYWRIGHT_PATH to its module dir.");
  }
}

function resolvePassword() {
  if (process.env.ORCH_PASSWORD) return process.env.ORCH_PASSWORD;
  try {
    const line = fs
      .readFileSync(path.resolve(__dirname, "../../server/.env"), "utf8")
      .split(/\r?\n/)
      .find((l) => /^AUTH_PASSWORD=/.test(l));
    if (line) return line.slice("AUTH_PASSWORD=".length).trim();
  } catch {
    /* no .env — the login below fails with a clear HTTP code */
  }
  return "";
}

function arg(flag) {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : null;
}

/** Everything the page can tell us in one pass — no interaction, just reads. */
function inspect() {
  const text = (sel) => document.querySelector(sel)?.textContent?.trim() || "";
  const conn = text(".conn");
  return {
    title: document.title,
    // The login form lives in a .scrim > .modal.login; if it's up, the session cookie didn't take.
    atLogin: !!document.querySelector(".modal.login"),
    hasTopbar: !!document.querySelector(".topbar"),
    rootChars: (document.querySelector("#root")?.textContent || "").length,
    conn,
    wsLive: /live/i.test(conn) && !/reconnect/i.test(conn),
    cards: document.querySelectorAll(".card").length,
    chips: document.querySelectorAll(".acct").length,
    // A pending owner question. Reported, never dismissed — see the header.
    pendingModal: !!document.querySelector(".scrim .modal:not(.login)"),
  };
}

async function main() {
  const chromium = loadChromium();
  const base = arg("--url") || process.env.ORCH_URL || "http://127.0.0.1:4317";
  const shot = arg("--shot");
  const consoleErrors = [];
  const failedRequests = [];

  const browser = await chromium.launch({ headless: true });
  let page;
  let view;
  try {
    page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    page.on("console", (m) => m.type() === "error" && consoleErrors.push(m.text().slice(0, 300)));
    page.on("pageerror", (e) => consoleErrors.push(`uncaught: ${String(e).slice(0, 300)}`));
    page.on("requestfailed", (r) => {
      if (!IGNORABLE_REQUEST.test(r.url())) failedRequests.push(`${r.url()} — ${r.failure()?.errorText}`);
    });

    const login = await page.request.post(`${base}/api/login`, { data: { password: resolvePassword() } });
    if (!login.ok()) throw new Error(`login failed: HTTP ${login.status()} (check AUTH_PASSWORD in server/.env)`);

    await page.goto(`${base}/`, { waitUntil: "networkidle", timeout: 45_000 });
    await page.waitForSelector(".topbar", { timeout: 20_000 }).catch(() => {});
    await page.waitForTimeout(2500); // let the WS hello land and the board hydrate
    view = await page.evaluate(inspect);
    if (shot) await page.screenshot({ path: shot });
  } finally {
    await browser.close();
  }

  const failures = [];
  if (view.atLogin) failures.push("still at the login gate — the session cookie did not take");
  if (!view.hasTopbar) failures.push("no .topbar rendered — the bundle did not mount");
  if (view.rootChars < 200) failures.push(`#root rendered only ${view.rootChars} chars — empty shell`);
  if (!view.wsLive) failures.push(`websocket not live — .conn reads "${view.conn || "(nothing)"}"`);
  for (const e of consoleErrors) failures.push(`console error: ${e}`);
  for (const r of failedRequests) failures.push(`request failed: ${r}`);

  console.log(`[${failures.length ? "FAIL" : "PASS"}] ${base} — "${view.title}"`);
  console.log(`         ws=${view.wsLive ? "live" : view.conn || "?"} cards=${view.cards} chips=${view.chips} root=${view.rootChars} chars`);
  console.log(`         console errors=${consoleErrors.length} failed requests=${failedRequests.length}`);
  if (view.pendingModal) {
    console.log("         · a modal is open (likely a pending owner question) — NOT touched, and nothing was clicked");
  }
  if (shot) console.log(`         screenshot: ${shot}`);
  for (const f of failures) console.log(`  ✗ ${f}`);

  process.exit(failures.length ? 1 : 0);
}

main().catch((e) => {
  console.error(`[FAIL] ${e.message || e}`);
  process.exit(1);
});
