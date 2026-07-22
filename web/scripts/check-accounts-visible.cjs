/**
 * Headless check: every top-bar account chip (incl. Grok SuperGrok meters) is
 * reachable at common desktop widths. Catches the "usage works in WS but chip
 * is clipped under .app overflow:hidden" class of bugs.
 *
 * Usage (repo root or web/):
 *   node web/scripts/check-accounts-visible.cjs
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
    const root = require("child_process").execSync("npm root -g").toString().trim();
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
const WIDTHS = (process.env.ORCH_WIDTHS || "1280,1440,1600")
  .split(",")
  .map((s) => parseInt(s.trim(), 10))
  .filter((n) => n > 0);

async function measure(page) {
  return page.evaluate(() => {
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
    const failures = [];
    if (chips.length === 0) failures.push("zero chips rendered");
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

    return {
      ok: failures.length === 0,
      reason: failures.join("; ") || null,
      vw,
      chipCount: chips.length,
      canScroll: accounts.scrollWidth > accounts.clientWidth + 2,
      accountsW: accounts.clientWidth,
      contentW: accounts.scrollWidth,
      after,
    };
  });
}

async function main() {
  const browser = await chromium.launch({ headless: true });
  const results = [];
  try {
    for (const w of WIDTHS) {
      const page = await browser.newPage({ viewport: { width: w, height: 800 } });
      const login = await page.request.post(`${BASE}/api/login`, {
        data: { password: PASSWORD },
      });
      if (!login.ok()) {
        results.push({ w, ok: false, reason: `login HTTP ${login.status()}` });
        await page.close();
        continue;
      }
      await page.goto(`${BASE}/?checkAccounts=${Date.now()}`, { waitUntil: "networkidle" });
      await page.waitForTimeout(2500);
      const m = await measure(page);
      results.push({ w, ...m });
      await page.close();
    }
  } finally {
    await browser.close();
  }

  let failed = false;
  for (const r of results) {
    const tag = r.ok ? "PASS" : "FAIL";
    if (!r.ok) failed = true;
    console.log(
      `[${tag}] ${r.w}px chips=${r.chipCount ?? "?"} scroll=${r.canScroll ? "yes" : "no"} ` +
        `accounts=${r.accountsW ?? "?"}/${r.contentW ?? "?"} ${r.reason ? "— " + r.reason : ""}`,
    );
    if (r.after) {
      for (const c of r.after) {
        console.log(
          `         ${c.fullyVisible ? "ok" : "!!"} ${c.label}: ${c.text.slice(0, 100)}`,
        );
      }
    }
  }
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
