// Lab for the highlighted-news chip and the Agent CLI updates settings (`npm run news-lab`). What the unit
// gate can't see: whether the chip mounts beside the usage gauge only while news exists, whether the panel
// opens on-screen, whether showing the chip leaves it unseen while opening it dismisses exactly what it
// showed (round-tripping through the socket and STAYING dismissed across a reload), whether a different
// model announced afterwards still brings the chip back, and whether Settings renders the updater's
// status. Boots its own throwaway instance (which, on its own DATA_DIR, stands the updater down — so this
// lab never installs or commits anything) and seeds its own news. Not in GATES: it needs a browser + an instance, like the other labs.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { loadChromium, authPassword, requireBuild, requireFreshWebBuild, boot, waitForPersisted, waitForSettingsReloadSafe, killInstance, createChecks, shotDir, isVoiceBridgeNoise } = require("./lab-harness.cjs");

const PORT = 4391;
const check = createChecks();

const NEWS = [
  { id: "model:claude:claude-opus-6", kind: "model", provider: "claude", model: "claude-opus-6", at: Date.now() - 2 * 3600_000 },
  { id: "model:codex:gpt-6-nova", kind: "model", provider: "codex", model: "gpt-6-nova", at: Date.now() - 20 * 60_000 },
];

async function chipText(page) {
  const chip = await page.$(".news-chip");
  return chip ? ((await chip.textContent()) ?? "").trim() : null;
}

async function waitForHello(page) {
  await page.waitForSelector(".topbar .conn .dot.on", { timeout: 30000 });
}

(async () => {
  requireBuild();
  requireFreshWebBuild();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "news-lab-"));
  killInstance(PORT);
  let child = await boot({ dataDir, port: PORT });
  let code = 1;
  try {
    // Seeded before any client connects, so the first connect snapshot is built from it.
    const Database = require(path.join(__dirname, "..", "node_modules", "better-sqlite3"));
    const db = new Database(path.join(dataDir, "orchestrator.sqlite"));
    db.prepare("INSERT OR REPLACE INTO kv (key, value) VALUES (?, ?)").run("highlight_news", JSON.stringify(NEWS));
    db.close();

    const chromium = loadChromium();
    const browser = await chromium.launch();
    const ctx = await browser.newContext({ viewport: { width: 1600, height: 950 } });
    const page = await ctx.newPage();
    const errors = [];
    page.on("console", (m) => {
      if (m.type() === "error" && !isVoiceBridgeNoise(m)) errors.push(m.text());
    });
    await page.request.post(`http://127.0.0.1:${PORT}/api/login`, { data: { password: authPassword() } });
    await page.goto(`http://127.0.0.1:${PORT}/`, { timeout: 45000 });
    await waitForHello(page);
    await page.waitForSelector(".news-chip", { timeout: 15000 });

    // ---- the chip: present, labelled, and beside the usage gauge ----
    check("the news chip shows with two items", (await chipText(page)) === "2 new models", await chipText(page));
    const order = await page.evaluate(() => {
      const kids = [...document.querySelector(".topbar").children];
      const news = kids.findIndex((el) => el.classList.contains("news"));
      const gauge = kids.findIndex((el) => el.classList.contains("accounts-toggle"));
      return { news, gauge };
    });
    check("it sits immediately before the usage gauge", order.gauge === -1 || order.news === order.gauge - 1, JSON.stringify(order));

    // ---- showing is not seeing: a reload with the chip never opened still has both items ----
    await page.reload({ timeout: 45000 });
    await waitForHello(page);
    await page.waitForSelector(".news-chip", { timeout: 15000 });
    check("merely displaying the chip does not mark it seen", (await chipText(page)) === "2 new models", await chipText(page));

    // ---- the panel: opening it is the dismissal ----
    await page.click(".news-chip");
    await page.waitForSelector(".news-panel", { timeout: 5000 });
    const items = await page.$$eval(".news-item", (els) =>
      els.map((el) => ({ model: el.querySelector(".news-model")?.textContent, id: el.querySelector(".news-id")?.textContent, provider: el.querySelector(".news-provider")?.textContent })),
    );
    check("the panel lists both models with readable names", items.length === 2 && items[0].model === "Opus 6" && items[1].model === "GPT-6 Nova", JSON.stringify(items));
    check("...their raw ids", items[0].id === "claude-opus-6" && items[1].id === "gpt-6-nova", JSON.stringify(items));
    const box = await page.$eval(".news-panel", (el) => {
      const r = el.getBoundingClientRect();
      return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, vw: innerWidth, vh: innerHeight };
    });
    check("the panel is fully on-screen", box.left >= 0 && box.right <= box.vw && box.top >= 0 && box.bottom <= box.vh, JSON.stringify(box));
    // The pickers live in Settings → Subscriptions (opened below); a row naming a section that doesn't exist
    // sends the owner looking for a model where it can't be picked.
    const where = (await page.textContent(".news-item .news-when")) ?? "";
    check("each row points at the Settings section that holds the pickers", /Settings → Subscriptions/.test(where), where);
    const foot = (await page.textContent(".news-foot")) ?? "";
    check("the footer speaks to the CLI auto-update", /auto-update|latest release/i.test(foot), foot);
    await page.screenshot({ path: path.join(shotDir(dataDir), "news-open.png") });

    const stillListed = await waitForSettingsReloadSafe(dataDir, "highlight_news", "[]");
    check("opening dismissed both shown items server-side", stillListed === "[]", String(stillListed));
    check("...while the open panel keeps listing them", (await page.$$(".news-item")).length === 2);
    check("the panel has no dismiss controls left to click", (await page.$(".news-panel button")) === null);
    await page.keyboard.press("Escape");
    check("Escape closes the panel", (await page.$(".news-panel")) === null);
    await page.waitForSelector(".news-chip", { state: "detached", timeout: 10000 });
    check("closing the opened panel takes the chip with it", (await page.$(".news-chip")) === null);
    await page.reload({ timeout: 45000 });
    await waitForHello(page);
    await page.waitForTimeout(1500);
    check("the chip stays gone across a reload (server-authoritative)", (await page.$(".news-chip")) === null);

    // ---- a different model announced later is still news ----
    // The server keeps kv in memory, so the later announcement is seeded across a restart of the instance.
    child.kill();
    killInstance(PORT);
    const later = { id: "model:claude:claude-sonnet-6", kind: "model", provider: "claude", model: "claude-sonnet-6", at: Date.now() };
    const seedDb = new Database(path.join(dataDir, "orchestrator.sqlite"));
    seedDb.prepare("INSERT OR REPLACE INTO kv (key, value) VALUES (?, ?)").run("highlight_news", JSON.stringify([later]));
    seedDb.close();
    child = await boot({ dataDir, port: PORT });
    await page.reload({ timeout: 45000 });
    await waitForHello(page);
    await page.waitForSelector(".news-chip", { timeout: 15000 });
    check("a newly announced model brings the chip back", (await chipText(page)) === "New model", await chipText(page));
    await page.click(".news-chip");
    await page.waitForSelector(".news-panel", { timeout: 5000 });
    const laterItems = await page.$$eval(".news-item .news-id", (els) => els.map((el) => el.textContent));
    check("...listing only the new one", laterItems.length === 1 && laterItems[0] === "claude-sonnet-6", JSON.stringify(laterItems));
    await page.click(".news-chip");
    await page.waitForSelector(".news-chip", { state: "detached", timeout: 10000 });
    check("clicking the open chip again closes it and it is gone", (await page.$(".news-chip")) === null);

    // ---- Settings: the toggle and the status ----
    await page.click(".settings-btn");
    await page.click('.settings-nav-item:has-text("Subscriptions")');
    await page.waitForSelector(".cli-updates", { timeout: 10000 });
    const toggle = await page.$('button[role="switch"][aria-label="Auto-update agent CLIs"]');
    check("Settings has the auto-update toggle, on by default", !!toggle && (await toggle.getAttribute("aria-checked")) === "true");
    const lines = await page.$$eval(".cli-update", (els) => els.map((el) => ({ state: el.querySelector(".cli-update-state")?.textContent, detail: el.querySelector(".cli-update-detail")?.textContent })));
    check("both CLIs have a status line", lines.length === 2, JSON.stringify(lines));
    check("a lab instance says it stands down", lines.every((l) => l.state === "Not managed" && /own data directory/.test(l.detail ?? "")), JSON.stringify(lines));
    check("...and offers no Check now it could not act on", await page.$eval('.cli-updates-foot button:has-text("Check now")', (b) => b.disabled).catch(() => null) === true);
    await page.$eval(".cli-updates", (el) => el.scrollIntoView());
    await page.screenshot({ path: path.join(shotDir(dataDir), "cli-updates.png") });
    await toggle.click();
    await page.waitForFunction(() => document.querySelector('button[aria-label="Auto-update agent CLIs"]')?.getAttribute("aria-checked") === "false", { timeout: 10000 });
    const stored = await waitForPersisted(dataDir, "setting_auto_update_clis", "0");
    check("switching it off persists", stored === "0", String(stored));

    check("no console errors", errors.length === 0, errors.join(" | "));
    console.log(`\nscreenshots: ${shotDir(dataDir)}`);
    await browser.close();
    code = check.summary();
  } finally {
    try {
      child.kill();
    } catch {
      /* already gone */
    }
    killInstance(PORT);
  }
  process.exit(code);
})().catch((e) => {
  console.error(e);
  killInstance(PORT);
  process.exit(2);
});
