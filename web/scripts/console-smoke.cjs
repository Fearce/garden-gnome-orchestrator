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
 *   npm run probe:providers                     report free-provider readiness + bundle freshness
 *   npm run probe:providers -- --expect-provider-ids gemini,groq,kilo --forbid-provider-ids openrouter
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
    const root = require("child_process").execSync("npm root -g", { windowsHide: true }).toString().trim();
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

function csv(value, flag) {
  const values = value.split(",").map((part) => part.trim()).filter(Boolean);
  if (!values.length) throw new Error(`${flag} requires at least one comma-separated provider id`);
  return [...new Set(values)];
}

function parseOptions(argv, env = process.env) {
  const options = {
    base: env.ORCH_URL || "http://127.0.0.1:4317",
    shot: null,
    providers: false,
    expectedProviderIds: null,
    forbiddenProviderIds: [],
    expectedProviderCount: null,
    expectLocalBundle: false,
    help: false,
  };
  const valueAfter = (flag, index) => {
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
    return value;
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--providers") options.providers = true;
    else if (arg === "--expect-local-bundle") options.expectLocalBundle = true;
    else if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg === "--url") options.base = valueAfter(arg, i++);
    else if (arg === "--shot") options.shot = valueAfter(arg, i++);
    else if (arg === "--expect-provider-ids") options.expectedProviderIds = csv(valueAfter(arg, i++), arg);
    else if (arg === "--forbid-provider-ids") options.forbiddenProviderIds = csv(valueAfter(arg, i++), arg);
    else if (arg === "--expect-provider-count") {
      const raw = valueAfter(arg, i++);
      const count = Number(raw);
      if (!Number.isInteger(count) || count < 0) throw new Error(`${arg} must be a non-negative integer`);
      options.expectedProviderCount = count;
    } else throw new Error(`unknown argument: ${arg}`);
  }

  if (options.expectedProviderIds || options.forbiddenProviderIds.length || options.expectedProviderCount != null) {
    options.providers = true;
  }
  return options;
}

function usage() {
  return [
    "Read-only live console probe",
    "",
    "  --url <origin>                 console origin (default: ORCH_URL or http://127.0.0.1:4317)",
    "  --shot <path>                  save a screenshot",
    "  --providers                    report free-provider readiness from the authenticated API",
    "  --expect-provider-ids <csv>    require this exact provider id order",
    "  --forbid-provider-ids <csv>    fail if any listed provider is exposed",
    "  --expect-provider-count <n>    require exactly n providers",
    "  --expect-local-bundle          require the served entry bundle to match local web/dist",
  ].join("\n");
}

function entryBundle(html) {
  const match = String(html).match(/<script\b[^>]*\bsrc=["']([^"']*\/assets\/index-[^"']+\.js)["']/i);
  if (!match) return null;
  try {
    return new URL(match[1], "http://local.invalid").pathname;
  } catch {
    return null;
  }
}

function compareBundles(servedAsset, localHtml, base) {
  const local = entryBundle(localHtml);
  let served = null;
  try {
    if (servedAsset) served = new URL(servedAsset, base).pathname;
  } catch {
    /* reported below */
  }
  const failures = [];
  if (!local) failures.push("local web/dist/index.html has no hashed entry bundle");
  if (!served) failures.push("the served page has no module entry bundle");
  else if (local && served !== local) failures.push(`served bundle differs from local build — served ${served}; local ${local}`);
  return { local, served, failures };
}

function normalizeProviderPayload(body) {
  if (!body || !Array.isArray(body.providers)) throw new Error("/api/free-providers returned no providers array");
  return body.providers.map((provider, index) => {
    if (!provider || typeof provider.id !== "string" || !provider.id.trim()) {
      throw new Error(`/api/free-providers row ${index + 1} has no provider id`);
    }
    return {
      id: provider.id.trim(),
      state: typeof provider.health?.state === "string" ? provider.health.state : "unknown",
      configured: provider.configured === true,
      keySource: typeof provider.keySource === "string" ? provider.keySource : "unknown",
      usage: typeof provider.usage?.displayLabel === "string" ? provider.usage.displayLabel : "",
    };
  });
}

function validateProviders(providers, options) {
  const failures = [];
  const ids = providers.map((provider) => provider.id);
  const duplicates = ids.filter((id, index) => ids.indexOf(id) !== index);
  if (duplicates.length) failures.push(`duplicate provider id(s): ${[...new Set(duplicates)].join(", ")}`);
  if (options.expectedProviderIds && JSON.stringify(ids) !== JSON.stringify(options.expectedProviderIds)) {
    failures.push(`provider ids differ — expected ${options.expectedProviderIds.join(",")}; got ${ids.join(",")}`);
  }
  if (options.expectedProviderCount != null && ids.length !== options.expectedProviderCount) {
    failures.push(`provider count differs — expected ${options.expectedProviderCount}; got ${ids.length}`);
  }
  const exposed = options.forbiddenProviderIds.filter((id) => ids.includes(id));
  if (exposed.length) failures.push(`forbidden provider id(s) still exposed: ${exposed.join(", ")}`);
  return failures;
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
    bundle: document.querySelector('script[type="module"][src]')?.getAttribute("src") || "",
    // A pending owner question. Reported, never dismissed — see the header.
    pendingModal: !!document.querySelector(".scrim .modal:not(.login)"),
  };
}

async function main() {
  const options = parseOptions(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    return 0;
  }
  const chromium = loadChromium();
  const base = options.base.replace(/\/$/, "");
  const consoleErrors = [];
  const failedRequests = [];
  let providers = null;

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
    if (options.providers) {
      const response = await page.request.get(`${base}/api/free-providers`);
      if (!response.ok()) throw new Error(`/api/free-providers failed: HTTP ${response.status()}`);
      providers = normalizeProviderPayload(await response.json());
    }

    // Not networkidle: the selected thread pulls a burst of multi-MB /api/attachment images and the
    // app polls /api/voice/status, so idle is data-dependent and can outlast any budget. The .topbar
    // wait below is the real ready signal, and its absence is reported as a finding rather than a timeout.
    await page.goto(`${base}/`, { waitUntil: "domcontentloaded", timeout: 45_000 });
    await page.waitForSelector(".topbar", { timeout: 20_000 }).catch(() => {});
    await page.waitForTimeout(2500); // let the WS hello land and the board hydrate
    view = await page.evaluate(inspect);
    if (options.shot) await page.screenshot({ path: options.shot });
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
  if (providers) failures.push(...validateProviders(providers, options));

  let bundleCheck = null;
  if (options.expectLocalBundle) {
    try {
      bundleCheck = compareBundles(
        view.bundle,
        fs.readFileSync(path.resolve(__dirname, "../dist/index.html"), "utf8"),
        base,
      );
      failures.push(...bundleCheck.failures);
    } catch (error) {
      failures.push(`could not read local web/dist/index.html: ${error.code || error.message}`);
    }
  }

  console.log(`[${failures.length ? "FAIL" : "PASS"}] ${base} — "${view.title}"`);
  console.log(`         ws=${view.wsLive ? "live" : view.conn || "?"} cards=${view.cards} chips=${view.chips} root=${view.rootChars} chars`);
  console.log(`         console errors=${consoleErrors.length} failed requests=${failedRequests.length}`);
  if (providers) {
    console.log(`         providers=${providers.length} — ${providers.map((provider) => `${provider.id}:${provider.state}`).join(" ")}`);
    for (const provider of providers) {
      const auth = provider.configured ? provider.keySource : "not configured";
      console.log(`         · ${provider.id}: ${provider.state}; auth=${auth}${provider.usage ? `; ${provider.usage}` : ""}`);
    }
  }
  if (options.expectLocalBundle) {
    const matches = bundleCheck?.local && bundleCheck.served === bundleCheck.local;
    console.log(`         bundle=${bundleCheck?.served || "unresolved"} (${matches ? "matches local build" : "mismatch"})`);
  }
  if (view.pendingModal) {
    console.log("         · a modal is open (likely a pending owner question) — NOT touched, and nothing was clicked");
  }
  if (options.shot) console.log(`         screenshot: ${options.shot}`);
  for (const f of failures) console.log(`  ✗ ${f}`);

  return failures.length ? 1 : 0;
}

module.exports = { compareBundles, entryBundle, normalizeProviderPayload, parseOptions, validateProviders };

if (require.main === module) {
  main().then(
    (code) => { process.exitCode = code; },
    (e) => {
      console.error(`[FAIL] ${e.message || e}`);
      process.exitCode = 1;
    },
  );
}
