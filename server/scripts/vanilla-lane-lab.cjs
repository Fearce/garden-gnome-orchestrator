#!/usr/bin/env node
/**
 * vanilla-lane-lab — drives Default mode's console surfaces in a real (headless) browser.
 *
 * `test:vanilla-lane` (server/src/tests/vanillaLane.itest.ts) proves the pipeline logic against a
 * stubbed agent spawn; it never touches a browser. This drives the OTHER half against its own
 * throwaway instance on alt ports with an empty temp DB (never prod — see project memory
 * `browser-test-throwaway-instance`): the composer's Default mode button + its always-on model/effort
 * pickers, the Settings toggle round-trip, and the board's "Default" badge on a paused vanilla task.
 *
 *   npm run vanilla-lane-lab --prefix server
 */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { SERVER_ROOT, loadChromium, authPassword, requireBuild, boot, waitForSettingsReloadSafe, killInstance, createChecks } = require("./lab-harness.cjs");

const PORT = 4347;
const BASE = `http://127.0.0.1:${PORT}`;
const DATA_DIR = path.join(os.tmpdir(), "gg-vanilla-lab");
const FIXTURE_WORKSPACE = "fixture/repo";

async function waitForServerHello(page) {
  await page.waitForSelector(".accounts .acct", { timeout: 30_000 });
}

/** Seed a paused vanilla-lane task directly against the throwaway DB — no agent ever runs. */
function seed() {
  const Database = require(path.join(SERVER_ROOT, "node_modules", "better-sqlite3"));
  const db = new Database(path.join(DATA_DIR, "orchestrator.sqlite"));
  const now = Date.now();
  db.prepare(
    `INSERT INTO threads(id, title, state, workspace, brief, raw_prompt, lane, created_at, updated_at)
     VALUES(@id, @title, @state, @workspace, @brief, @raw, @lane, @at, @at)`,
  ).run({ id: "t-vanilla", title: "A vanilla default-mode task", state: "paused", workspace: FIXTURE_WORKSPACE, brief: "just answer 2+2", raw: "just answer 2+2", lane: "vanilla", at: now });
  db.prepare(
    `INSERT INTO threads(id, title, state, workspace, brief, raw_prompt, lane, created_at, updated_at)
     VALUES(@id, @title, @state, @workspace, @brief, @raw, @lane, @at, @at)`,
  ).run({ id: "t-plain", title: "An ordinary task", state: "implementing", workspace: FIXTURE_WORKSPACE, brief: "lab", raw: "lab", lane: null, at: now });
  db.close();
}

async function main() {
  requireBuild();
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
  fs.mkdirSync(DATA_DIR, { recursive: true });
  killInstance(PORT);

  const check = createChecks();
  let child;
  let browser;
  try {
    console.log(`booting a throwaway instance on ${PORT} (empty DB at ${DATA_DIR})…`);
    child = await boot({ dataDir: DATA_DIR, port: PORT });
    seed();

    const chromium = loadChromium();
    browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
    const errors = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    // Browser-emitted "Failed to load resource" console errors carry no URL, so they can't be
    // filtered against the known /api/voice/settings noise below — only the network-level events can.
    page.on("console", (m) => m.type() === "error" && !/failed to load resource/i.test(m.text()) && errors.push(m.text()));
    page.on("response", (r) => {
      if (r.status() >= 400) errors.push(`http ${r.status()}: ${r.url()}`);
    });

    await page.request.post(`${BASE}/api/login`, { data: { password: authPassword() } });
    await page.goto(`${BASE}/`, { timeout: 45_000 }).catch(() => page.goto(`${BASE}/`, { timeout: 45_000 }));
    await page.waitForSelector(".topbar", { timeout: 45_000 });
    await waitForServerHello(page);
    await page.waitForSelector(".card", { timeout: 45_000 });

    // ---- the board: the Default badge on a paused vanilla task, and nowhere else -----------------
    const badge = await page.$eval('[data-thread-id="t-vanilla"] .read-badge', (e) => e.textContent.trim()).catch(() => null);
    check("a vanilla-lane task shows the 'Default' badge", badge === "Default", String(badge));
    const plainBadges = await page.$$eval('[data-thread-id="t-plain"] .read-badge', (els) => els.length);
    check("an ordinary task grows no badge", plainBadges === 0, String(plainBadges));

    // ---- the composer: Default mode button, takeover from Skip director, always-on pickers ---------
    const defaultBtn = await page.$('button.mode-toggle:has-text("Default mode")');
    check("the composer shows a Default mode button", !!defaultBtn);
    check("it starts OFF", !(await page.$eval('button.mode-toggle:has-text("Default mode")', (e) => e.className.includes("on"))));
    check("model/effort pickers are NOT shown while off", !(await page.$('[aria-label="Default-mode model and effort"]')));

    await page.click('button.mode-toggle:has-text("Default mode")');
    await page.waitForTimeout(500); // round-trips through settings.set → server → broadcast, like task-mode-lab
    check("clicking it turns it ON", await page.$eval('button.mode-toggle:has-text("Default mode")', (e) => e.className.includes("on")));
    check("the vanilla hint replaces the skip-director hint", (await page.$eval(".composer-mode", (e) => e.textContent)).includes("vanilla → stays warm"));
    check(
      "the model/effort pickers appear once it's on (always, not gated by 'show pickers')",
      !!(await page.$('[aria-label="Default-mode model and effort"]')),
    );
    check("the model picker offers Auto by default", (await page.$eval('select[aria-label="Default-mode effort"]', (e) => e.value)) === "auto");
    check(
      "the composer placeholder explains default mode",
      (await page.$eval("textarea", (e) => e.placeholder)).toLowerCase().includes("default mode"),
    );

    // ---- the effort picker actually writes the setting (round-trips like the task-mode select) ------
    await page.selectOption('select[aria-label="Default-mode effort"]', "high");
    const storedEffort = await waitForSettingsReloadSafe(DATA_DIR, "setting_default_mode_effort", "high");
    check("the effort selection reaches the server before reload", storedEffort === "high", String(storedEffort));
    await page.reload({ timeout: 45_000 });
    await page.waitForSelector(".topbar", { timeout: 45_000 });
    await waitForServerHello(page);
    await page
      .waitForFunction(
        () => [...document.querySelectorAll("button.mode-toggle")].some((b) => b.textContent?.includes("Default mode") && b.className.includes("on")),
        { timeout: 15_000 },
      )
      .catch(() => {});
    check(
      "default mode is still ON after reload (server-persisted)",
      await page.$eval('button.mode-toggle:has-text("Default mode")', (e) => e.className.includes("on")),
    );
    await page.waitForSelector('select[aria-label="Default-mode effort"]', { timeout: 15_000 });
    const effortAfterReload = await page.$eval('select[aria-label="Default-mode effort"]', (e) => e.value);
    check("the effort pick survived a reload (server-persisted)", effortAfterReload === "high", effortAfterReload);

    // ---- Settings panel: the toggle exists, documents itself, and drives the same setting -----------
    await page.click('[aria-label="Open settings"]');
    await page.waitForSelector('[role="dialog"][aria-label="Settings"]', { timeout: 15_000 });
    await page.click('[data-settings-category="interface"]');
    const settingsRow = page.locator(".settings-row:has(.settings-row-label:text-is('Default mode'))");
    check("Settings → Interface has a Default mode toggle", await settingsRow.count() > 0);
    const settingsHint = await settingsRow.locator(".settings-row-hint").innerText().catch(() => "");
    check("...documenting the stock-session behavior", settingsHint.includes("stock implementor session"), settingsHint.slice(0, 160));
    const settingsToggleOn = await settingsRow.locator("button[role='switch']").getAttribute("aria-checked").catch(() => null);
    check("...already reflecting the ON state set from the composer", settingsToggleOn === "true", String(settingsToggleOn));
    await settingsRow.locator("button[role='switch']").click();
    await page.waitForTimeout(500);
    await page.click('[aria-label="Close settings"]').catch(() => page.keyboard.press("Escape"));
    check(
      "...and toggling it off from Settings turns the composer button off too",
      !(await page.$eval('button.mode-toggle:has-text("Default mode")', (e) => e.className.includes("on"))),
    );

    // /api/voice/settings 502s on any throwaway instance — it's a passthrough to the separate
    // voice-gateway service (CLAUDE.md's voice-mode section), which isn't running here and has nothing
    // to do with default mode. Every lab that opens Settings hits this; filter it, not the feature.
    const realErrors = errors.filter((e) => !e.includes("/api/voice/settings"));
    check("no console errors while driving all of it", realErrors.length === 0, realErrors.join(" | "));

    await page.screenshot({ path: path.join(DATA_DIR, "vanilla-lane-lab.png"), fullPage: false });
    console.log(`\nscreenshot: ${path.join(DATA_DIR, "vanilla-lane-lab.png")}`);
  } finally {
    if (browser) await browser.close().catch(() => {});
    if (child) child.kill();
    killInstance(PORT);
  }
  process.exit(check.summary());
}

main().catch((e) => {
  console.error("lab error:", e);
  killInstance(PORT);
  process.exit(2);
});
