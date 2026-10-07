// token-safety-schedule-lab: the Token safety limit's scheduled hours, driven in a real browser against a
// THROWAWAY instance (never prod).
//
// Run:  npm run token-safety-schedule-lab --prefix server [-- --shots <dir>] [-- --keep]
//
// What it proves, in order:
//   1. The schedule switch appears under the enabled limit and persists through the WebSocket.
//   2. The weekday strip reads M T W T F S S, Monday first, with full names and pressed states, and the
//      default is Monday to Friday 08:00 to 16:00 in the server's zone, with a live on/off status.
//   3. Keyboard: arrows, Home and End move between days; Space toggles one day on its own.
//   4. An overnight window is accepted and says where it ends.
//   5. An empty weekday set and an unknown zone are explained and never saved.
//   6. After a server restart the schedule is still there, and the strip fits a 390px phone screen.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Database = require("better-sqlite3");
const { loadChromium, authPassword, requireBuild, requireFreshWebBuild, boot, killInstance, createChecks, shotDir, waitForPersisted } = require("./lab-harness.cjs");

const PORT = 4339;
const BASE = `http://127.0.0.1:${PORT}`;
const KEY = "setting_token_limit_schedule";
const NAMES = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
const check = createChecks();

function seed(dataDir) {
  const db = new Database(path.join(dataDir, "orchestrator.sqlite"));
  try {
    const put = db.prepare("INSERT INTO kv(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value");
    for (const [key, value] of Object.entries({
      setting_token_limit_enabled: "1",
      setting_token_limit_percent: "80",
      setting_codex_enabled: "0",
      setting_grok_enabled: "0",
      setting_zai_enabled: "0",
    })) {
      put.run(key, value);
    }
  } finally {
    db.close();
  }
}

/** The stored schedule once it matches `want`, or the last value seen. */
async function stored(dataDir, want, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    const raw = await waitForPersisted(dataDir, KEY, undefined, 2_000);
    last = raw ? JSON.parse(raw) : null;
    if (last && want(last)) return last;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return last;
}

async function openUsage(browser, viewport) {
  const context = await browser.newContext(viewport.width < 600 ? { viewport, isMobile: true, hasTouch: true } : { viewport });
  const page = await context.newPage();
  const login = await page.request.post(`${BASE}/api/login`, { data: { password: authPassword() } });
  if (!login.ok()) throw new Error(`login HTTP ${login.status()}`);
  await page.goto(BASE);
  await page.click('[aria-label="Open settings"]');
  await page.waitForFunction(() =>
    [...document.querySelectorAll('[data-settings-category="usage"], .settings-mobile-nav select[aria-label="Settings category"]')].some((el) => el.getBoundingClientRect().width > 0),
  );
  const rail = page.locator('[data-settings-category="usage"]');
  if (await rail.isVisible()) await rail.click();
  else await page.selectOption('.settings-mobile-nav select[aria-label="Settings category"]', "usage");
  return { context, page };
}

const focusedName = (page) => page.evaluate(() => document.activeElement?.getAttribute("aria-label"));
const pressedDays = (page) =>
  page.$$eval(".tss-day", (buttons) => buttons.map((b) => `${b.textContent}${b.getAttribute("aria-pressed") === "true" ? "+" : "-"}`).join(" "));

async function main() {
  requireBuild();
  requireFreshWebBuild();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "token-safety-schedule-lab-"));
  const shots = shotDir(dataDir);
  console.log(`token-safety-schedule-lab on ${BASE} (data ${dataDir})`);
  killInstance(PORT);
  let browser;
  try {
    await boot({ dataDir, port: PORT });
    killInstance(PORT);
    seed(dataDir);
    await boot({ dataDir, port: PORT });
    browser = await loadChromium().launch();

    console.log("\n1. the schedule switch");
    let { context, page } = await openUsage(browser, { width: 1440, height: 900 });
    const toggle = page.getByRole("switch", { name: "Only during set hours", exact: true });
    check("the switch sits under the enabled limit, off by default", (await toggle.getAttribute("aria-checked")) === "false");
    check("no editor while the schedule is off", (await page.locator(".tss").count()) === 0);
    await toggle.click();
    const enabled = await stored(dataDir, (s) => s.enabled === true);
    check("switching it on persists", enabled?.enabled === true, JSON.stringify(enabled));

    console.log("\n2. the weekday strip and its defaults");
    await page.waitForSelector(".tss", { state: "visible" });
    const labels = await page.$$eval(".tss-day", (buttons) => buttons.map((b) => [b.textContent, b.getAttribute("aria-label")]));
    check("seven toggles read M T W T F S S", labels.map(([t]) => t).join(" ") === "M T W T F S S", JSON.stringify(labels));
    check("each carries its full weekday name, Monday first", JSON.stringify(labels.map(([, n]) => n)) === JSON.stringify(NAMES), JSON.stringify(labels));
    check("Monday to Friday are selected by default", (await pressedDays(page)) === "M+ T+ W+ T+ F+ S- S-", await pressedDays(page));
    check("08:00 to 16:00 by default", (await page.inputValue('input[aria-label="Start time"]')) === "08:00" && (await page.inputValue('input[aria-label="End time"]')) === "16:00");
    const zone = await page.inputValue('input[aria-label="Time zone"]');
    check("the zone is explicit and the stored one", !!zone && zone === enabled?.timeZone, `${zone} vs ${enabled?.timeZone}`);
    const status = await page.locator(".tss-status").innerText();
    check("the live status says on or off and when it next changes", /^(Applies now\. Lifts|Suspended now\. Applies again) \w{3} /.test(status), status);
    const strip = await page.locator(".tss-days").boundingBox();
    const times = await page.locator(".tss-times").boundingBox();
    check("the times sit beside the day strip on desktop", !!strip && !!times && Math.abs(strip.y - times.y) < 12 && times.x > strip.x + strip.width, JSON.stringify({ strip, times }));
    const selectedLook = await page.$$eval(".tss-day", (buttons) => [getComputedStyle(buttons[0]).backgroundColor, getComputedStyle(buttons[6]).backgroundColor]);
    check("selected days look different from unselected ones", selectedLook[0] !== selectedLook[1], JSON.stringify(selectedLook));
    await page.locator(".tss").screenshot({ path: path.join(shots, "schedule-desktop.png") });

    console.log("\n3. keyboard");
    await page.getByRole("button", { name: "Monday", exact: true }).focus();
    await page.keyboard.press("ArrowRight");
    check("ArrowRight moves to Tuesday", (await focusedName(page)) === "Tuesday");
    await page.keyboard.press("ArrowLeft");
    await page.keyboard.press("ArrowLeft");
    check("ArrowLeft wraps from Monday to Sunday", (await focusedName(page)) === "Sunday");
    await page.keyboard.press("Home");
    check("Home goes to Monday", (await focusedName(page)) === "Monday");
    await page.keyboard.press("End");
    await page.keyboard.press("Space");
    const withSunday = await stored(dataDir, (s) => s.days.includes(0));
    check("Space selects Sunday alone, leaving the others as they were", JSON.stringify(withSunday?.days) === "[0,1,2,3,4,5]", JSON.stringify(withSunday?.days));
    await page.keyboard.press("Enter");
    const withoutSunday = await stored(dataDir, (s) => !s.days.includes(0));
    check("Enter deselects it again", JSON.stringify(withoutSunday?.days) === "[1,2,3,4,5]", JSON.stringify(withoutSunday?.days));

    console.log("\n4. an overnight window");
    await page.fill('input[aria-label="Start time"]', "22:00");
    await page.fill('input[aria-label="End time"]', "06:00");
    const overnight = await stored(dataDir, (s) => s.start === "22:00" && s.end === "06:00");
    check("an end before the start is saved", overnight?.start === "22:00" && overnight?.end === "06:00", JSON.stringify(overnight));
    check("and the editor says it runs overnight", /Runs overnight, ending at 06:00 the next day\./.test(await page.locator(".tss-status").innerText()));
    await page.locator(".tss").screenshot({ path: path.join(shots, "schedule-overnight.png") });
    await page.fill('input[aria-label="Start time"]', "08:00");
    await page.fill('input[aria-label="End time"]', "16:00");
    await stored(dataDir, (s) => s.start === "08:00" && s.end === "16:00");

    console.log("\n5. unusable input is explained, not saved");
    for (const name of NAMES.slice(0, 5)) await page.getByRole("button", { name, exact: true }).click();
    check("no weekday shows the reason", /Pick at least one weekday\./.test(await page.locator('.tss-status[role="alert"]').innerText()));
    const keptDays = await stored(dataDir, () => true);
    check("and keeps the last valid weekdays", JSON.stringify(keptDays?.days) === "[5]", JSON.stringify(keptDays?.days));
    await page.locator(".tss").screenshot({ path: path.join(shots, "schedule-no-days.png") });
    for (const name of NAMES.slice(0, 4)) await page.getByRole("button", { name, exact: true }).click();
    await page.getByRole("button", { name: "Friday", exact: true }).click();
    const restored = await stored(dataDir, (s) => JSON.stringify(s.days) === "[1,2,3,4,5]");
    check("re-selecting Monday to Friday saves again", JSON.stringify(restored?.days) === "[1,2,3,4,5]", JSON.stringify(restored?.days));
    await page.fill('input[aria-label="Time zone"]', "Mars/Olympus");
    await page.keyboard.press("Enter");
    check("an unknown zone shows the reason", /not a time zone/.test(await page.locator('.tss-status[role="alert"]').innerText().catch(() => "")));
    check("and is not stored", (await stored(dataDir, () => true))?.timeZone === zone);
    await page.fill('input[aria-label="Time zone"]', zone);
    await page.keyboard.press("Enter");
    check("the original zone clears the warning", (await page.locator('.tss-status[role="alert"]').count()) === 0);
    await context.close();

    console.log("\n6. restart, then a phone-width screen");
    killInstance(PORT);
    await boot({ dataDir, port: PORT });
    ({ context, page } = await openUsage(browser, { width: 390, height: 844 }));
    await page.waitForSelector(".tss", { state: "visible", timeout: 15_000 });
    check("the schedule survives a restart", (await pressedDays(page)) === "M+ T+ W+ T+ F+ S- S-" && (await page.inputValue('input[aria-label="Start time"]')) === "08:00");
    const fit = await page.evaluate(() => {
      const box = (sel) => document.querySelector(sel)?.getBoundingClientRect();
      const tss = box(".tss");
      const days = box(".tss-days");
      const times = box(".tss-times");
      return { width: innerWidth, tssRight: tss?.right, daysRight: days?.right, timesRight: times?.right, dayWidth: box(".tss-day")?.width };
    });
    check("the strip and the times fit the phone width", fit.daysRight <= fit.width && fit.timesRight <= fit.width && fit.tssRight <= fit.width, JSON.stringify(fit));
    check("each day stays a comfortable tap target", fit.dayWidth >= 30, JSON.stringify(fit));
    await page.locator(".tss").screenshot({ path: path.join(shots, "schedule-phone.png") });
    await context.close();
  } finally {
    await browser?.close();
    killInstance(PORT);
    if (!process.argv.includes("--keep")) fs.rmSync(dataDir, { recursive: true, force: true });
  }
  console.log(`\nscreenshots: ${shots}`);
  process.exitCode = check.summary();
}

main().catch((error) => {
  console.error(error);
  killInstance(PORT);
  process.exit(1);
});
