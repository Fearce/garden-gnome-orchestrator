// Browser regression for the shared banked-reset badge and early weekly-reset tooltip.
// Run: npm run claude-reset-lab --prefix server
// Run against isolated builds: GGO_LAB_ENTRY and GGO_LAB_WEB_DIST use lab-harness conventions.
// Fixtures replace only usage frames; the real console, WebSocket and shared badge still render.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const H = require("./lab-harness.cjs");
const PORT = 4531;
const BASE = `http://127.0.0.1:${PORT}`;

async function main() {
  H.requireBuild();
  const check = H.createChecks();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-reset-lab-"));
  const password = "isolated-reset-lab";
  let browser;
  let child;
  try {
    child = await H.boot({ dataDir, port: PORT, env: {
      AUTH_PASSWORD: password, ORCH_SUPERVISED: "0", SCRIPT_HUB_URL: "http://127.0.0.1:59999",
      ACCOUNT_1_PROFILE_TOKEN: "lab-profile", ACCOUNT_2_PROFILE_TOKEN: "lab-profile",
      PROFILE_USAGE_URL: "http://127.0.0.1:59999/usage", CODEX_WAKE: "off",
    } });
    browser = await H.loadChromium().launch();
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const at = Date.now();
    const usage = { fiveHour: 34, sevenDay: 6, fiveHourReset: at + 2 * 3_600_000, sevenDayReset: at + 6 * 86_400_000, updatedAt: at };
    const credit = { available: 1, pending: 0, expiresAt: at + 14 * 86_400_000, title: "Full reset", readAt: at, redeemId: "grant_fixture" };
    const accounts = [{ id: "fixture", label: "personal", ...usage, active: true, enabled: true,
      weeklySafetyPct: 100, rateLimited: false, stale: false, resetCredits: credit,
      weeklyReset: { at: at - 2 * 3_600_000, early: true, fromPct: 84 } }];
    await context.routeWebSocket(/\/ws(\?|$)/, (socket) => {
      const server = socket.connectToServer();
      socket.onMessage(() => {});
      server.onMessage((raw) => {
        const message = JSON.parse(String(raw));
        if (message.type !== "hello") return;
        socket.send(JSON.stringify({ ...message, accounts,
          codexUsage: { ...usage, sevenDay: 32, resetCredits: credit },
          settings: { ...message.settings, codexEnabled: true, codexChatgptLogin: true } }));
      });
    });
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const login = await page.request.post(`${BASE}/api/login`, { data: { password } });
    if (!login.ok()) throw new Error(`login HTTP ${login.status()}`);
    await page.goto(BASE, { timeout: 45_000 });
    await page.locator(".accounts .acct").first().waitFor();
    const badges = await page.locator(".board-usage button.reset-credit").evaluateAll((elements) => elements.map((element) => {
      const style = getComputedStyle(element), rect = element.getBoundingClientRect();
      return { text: element.textContent, label: element.getAttribute("aria-label"),
        font: style.fontSize, color: style.color, background: style.backgroundColor,
        height: rect.height, visible: rect.width > 0 && rect.height > 0 && rect.top >= 0 && rect.bottom <= innerHeight };
    }));
    const claude = badges.find((badge) => /personal/.test(badge.label));
    const codex = badges.find((badge) => /Codex/.test(badge.label));
    check("Claude shows its banked reset as ↻1", !!claude && claude.visible && claude.text === "↻1");
    check("Codex shows its banked reset as ↻1", !!codex && codex.visible && codex.text === "↻1");
    check("both badges share computed styling", !!claude && !!codex &&
      claude.font === codex.font && claude.color === codex.color &&
      claude.background === codex.background && claude.height === codex.height);
    const title = await page.locator(".accounts .acct").first().getAttribute("title");
    check("the Claude chip names the early weekly reset", /weekly reset early 2h\s*\d*m? ago \(was 84%\)/.test(title || ""));
    check("no page errors", errors.length === 0, errors.join("; "));
    await page.screenshot({ path: path.join(H.shotDir("data/claude-reset-lab-shots"), "claude-reset-lab.png") });
    return check.summary();
  } finally {
    await browser?.close();
    // This child owns only the lab's port and temp database.
    child?.kill();
    await H.killInstance(PORT);
  }
}
main().then((code) => { process.exitCode = code; }).catch((error) => { console.error(error); process.exitCode = 2; });
