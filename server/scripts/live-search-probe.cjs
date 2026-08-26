#!/usr/bin/env node
/**
 * Time one real console search against the running local orchestrator.
 *
 * Unlike search-lab, this intentionally uses the live server and its database. It catches the
 * failure that mattered here: a correct fixture search whose production corpus is too large to
 * return promptly. The probe only authenticates and reads UI state; it never mutates a task.
 *
 * Examples:
 *   node scripts/live-search-probe.cjs --query orchestrator
 *   node scripts/live-search-probe.cjs --query milkshake --max-ms 2000
 *   node scripts/live-search-probe.cjs --query orchestrator --port 4317 --timeout-ms 30000
 */

const { authPassword, loadChromium } = require("./lab-harness.cjs");

function usage(message) {
  if (message) console.error(`error: ${message}\n`);
  console.error("Usage: node scripts/live-search-probe.cjs --query <text> [--port <1-65535>] [--timeout-ms <positive>] [--max-ms <positive>]");
  process.exit(message ? 2 : 0);
}

function positiveInt(raw, flag, max) {
  if (!/^\d+$/.test(raw ?? "")) usage(`${flag} must be a positive integer`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1 || (max && value > max)) usage(`${flag} is out of range`);
  return value;
}

function options(argv) {
  const parsed = { port: 4317, timeoutMs: 30_000, maxMs: null, query: null };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === "--help" || flag === "-h") usage();
    const value = argv[++i];
    if (value === undefined) usage(`${flag} needs a value`);
    if (flag === "--query") parsed.query = value.trim();
    else if (flag === "--port") parsed.port = positiveInt(value, flag, 65_535);
    else if (flag === "--timeout-ms") parsed.timeoutMs = positiveInt(value, flag);
    else if (flag === "--max-ms") parsed.maxMs = positiveInt(value, flag);
    else usage(`unknown option ${flag}`);
  }
  if (!parsed.query) usage("--query must not be blank");
  return parsed;
}

async function main() {
  const { port, query, timeoutMs, maxMs } = options(process.argv.slice(2));
  const baseUrl = `http://127.0.0.1:${port}`;
  const browser = await loadChromium().launch();
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    const login = await page.request.post(`${baseUrl}/api/login`, { data: { password: authPassword() } });
    if (!login.ok()) throw new Error(`login failed: HTTP ${login.status()}`);

    await page.goto(`${baseUrl}/`, { waitUntil: "domcontentloaded", timeout: timeoutMs });
    await page.waitForSelector(".rail-search-input", { timeout: timeoutMs });

    const started = performance.now();
    await page.fill(".rail-search-input", query);
    await page.waitForFunction(
      (expected) => {
        const input = document.querySelector(".rail-search-input");
        const status = document.querySelector(".ds-status")?.textContent ?? "";
        return input?.value === expected && status.includes(expected) && !status.includes("Searching");
      },
      query,
      { timeout: timeoutMs },
    );
    const elapsedMs = Math.round(performance.now() - started);
    const result = {
      query,
      elapsedMs,
      status: (await page.textContent(".ds-status"))?.trim() ?? "",
      taskCards: await page.locator(".ds-task").count(),
      directorHits: await page.locator(".ds-result").count(),
    };
    console.log(JSON.stringify(result));
    if (maxMs !== null && elapsedMs > maxMs) {
      throw new Error(`search took ${elapsedMs}ms, above the requested ${maxMs}ms ceiling`);
    }
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
