// Lab for the Home tab's cleaning schedule (`node scripts/home-schedule-lab.cjs` from server/): a throwaway
// instance whose Home config points at a fake Home Assistant in this process, driven in a real browser.
// It proves what `homeSchedule.test.ts` cannot: the card renders the schedule, its switch turns an
// automation off through the proxy and worker, and the Edit dialog's save lands in Home Assistant's config API.
// The owner's real Home Assistant is never contacted.
//
// Needs an isolated build:
//   from server/: npx tsc -p tsconfig.json --outDir .modules-lab-dist
//   from web/:    npx vite build --outDir ../server/.lab-web-dist-modules --emptyOutDir
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { loadChromium, authPassword, requireBuild, boot, killInstance, createChecks, shotDir } = require("./lab-harness.cjs");

process.env.GGO_LAB_ENTRY ||= ".modules-lab-dist/index.js";
process.env.GGO_LAB_WEB_DIST ||= ".lab-web-dist-modules";

const PORT = 4427;
const BASE = `http://127.0.0.1:${PORT}`;
const VACUUM = "vacuum.sample_vacuum";
const BATTERY = "sensor.sample_vacuum_battery_level";
const DOCK = "button.sample_vacuum_start_charge";
const check = createChecks();

const automations = new Map([
  ["sample_auto_start", { entityId: "automation.sample_auto_start", on: true, last: new Date(Date.now() - 3 * 86_400_000).toISOString(), config: {
    id: "sample_auto_start", alias: "Vacuum auto-start",
    triggers: [{ trigger: "numeric_state", entity_id: BATTERY, above: 98.9 }, { trigger: "time", at: "09:00:00" }, { trigger: "time_pattern", minutes: "/30" }],
    conditions: [{ condition: "numeric_state", entity_id: BATTERY, above: 98.9 }, { condition: "time", after: "09:00:00", before: "22:00:00" }, { condition: "state", entity_id: VACUUM, state: "docked" }],
    actions: [{ action: "vacuum.start", target: { entity_id: VACUUM } }], mode: "single",
  } }],
  ["sample_quiet_guard", { entityId: "automation.sample_quiet_guard", on: true, last: null, config: {
    id: "sample_quiet_guard", alias: "Vacuum quiet hours",
    triggers: [{ trigger: "state", entity_id: VACUUM, to: "cleaning" }, { trigger: "time", at: "22:00:00" }, { trigger: "homeassistant", event: "start" }, { trigger: "time_pattern", minutes: "/5" }],
    conditions: [{ condition: "state", entity_id: VACUUM, state: "cleaning" }, { condition: "time", after: "22:00:00", before: "09:00:00" }],
    actions: [{ action: "vacuum.stop", target: { entity_id: VACUUM } }, { delay: { seconds: 5 } }, { action: "button.press", target: { entity_id: DOCK } }], mode: "single",
  } }],
]);
const writes = [];

function fakeHomeAssistant() {
  return http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      const json = (value, status = 200) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(value)); };
      if (req.url === "/api/") return json({ message: "Unauthorized" }, 401);
      if (req.url === "/auth/token") return json({ access_token: "sample-access-token", expires_in: 1800 });
      if (req.url === "/api/states") {
        return json([
          { entity_id: VACUUM, state: "docked", attributes: { battery_level: 100, friendly_name: "Sample vacuum" } },
          ...[...automations].map(([id, a]) => ({ entity_id: a.entityId, state: a.on ? "on" : "off", attributes: { id, friendly_name: a.config.alias, last_triggered: a.last } })),
        ]);
      }
      const config = /^\/api\/config\/automation\/config\/([^/]+)$/.exec(req.url);
      if (config) {
        const id = decodeURIComponent(config[1]);
        if (req.method === "GET") return automations.has(id) ? json(automations.get(id).config) : json({ message: "Resource not found" }, 404);
        writes.push({ id, config: JSON.parse(body) });
        automations.set(id, { ...(automations.get(id) ?? { entityId: `automation.${id}`, on: true, last: null }), config: JSON.parse(body) });
        return json({ result: "ok" });
      }
      const service = /^\/api\/services\/automation\/(turn_on|turn_off)$/.exec(req.url);
      if (service) {
        const entityId = JSON.parse(body).entity_id;
        for (const a of automations.values()) if (a.entityId === entityId) a.on = service[1] === "turn_on";
        return json([]);
      }
      json({ message: "not faked" }, 404);
    });
  });
}

function seedHomeConfig(dataDir, haUrl) {
  const haDir = path.join(dataDir, "ha-config");
  fs.mkdirSync(path.join(haDir, ".storage"), { recursive: true });
  fs.writeFileSync(path.join(haDir, ".storage", "auth"), JSON.stringify({ data: { users: [{ id: "owner", is_owner: true }], refresh_tokens: [{ token: "sample-refresh", user_id: "owner", token_type: "normal" }] } }));
  fs.writeFileSync(path.join(haDir, ".storage", "core.entity_registry"), JSON.stringify({ data: { entities: [VACUUM, BATTERY, DOCK].map((entity_id) => ({ entity_id, device_id: "sample-device" })) } }));
  const homeDir = path.join(dataDir, "modules", "home");
  fs.mkdirSync(homeDir, { recursive: true });
  const device = { id: "vac-sample", name: "Hall vacuum", platform: "home-assistant", model: "mijia.vacuum.v2", homeAssistantEntityId: VACUUM, refreshMs: 0 };
  fs.writeFileSync(path.join(homeDir, "config.json"), JSON.stringify({ version: 1, origin: "new", importedAt: null, value: { homeAssistant: { url: haUrl, configDir: haDir }, pythonPath: "python", devices: [device] } }));
}

(async () => {
  requireBuild();
  const ha = fakeHomeAssistant();
  await new Promise((resolve) => ha.listen(0, "127.0.0.1", resolve));
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "home-schedule-lab-"));
  const shots = shotDir(dataDir);
  seedHomeConfig(dataDir, `http://127.0.0.1:${ha.address().port}`);
  killInstance(PORT);
  const child = await boot({ dataDir, port: PORT });
  let browser = null;
  let page = null;
  try {
    browser = await loadChromium().launch();
    page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
    const pageErrors = [];
    page.on("pageerror", (e) => pageErrors.push(e.message));
    await page.request.post(`${BASE}/api/login`, { data: { password: authPassword() } });
    await page.goto(`${BASE}/`, { timeout: 60_000 });
    await page.waitForSelector(".accounts .acct", { state: "attached", timeout: 60_000 });
    await page.click('[aria-label="Open settings"]');
    await page.click('[data-settings-category="interface"]');
    await page.locator('[role="switch"][aria-label="Home tab"]').click();
    await page.click('[aria-label="Close settings"]');
    await page.click(".board-tabs .board-tab.bt-home");

    await page.waitForSelector(".home-rules .home-rule", { timeout: 90_000 });
    const rows = await page.locator(".home-rule .home-rule-text").allTextContents();
    check("the card lists the auto-start with its window and battery", /At 99% battery while docked · 09:00–22:00 · every day/.test(rows[0] ?? ""), rows[0]);
    check("...and the quiet-hours guard", /Docks it if it cleans between 22:00 and 09:00/.test(rows[1] ?? ""), rows[1]);
    check("...with when each last ran", /ran 3 d ago/.test((await page.locator(".home-rule-last").first().textContent()) ?? ""));
    await page.screenshot({ path: path.join(shots, "home-schedule-card.png") });

    const autoSwitch = page.locator('.home-rule [role="switch"]').first();
    await autoSwitch.click();
    await page.waitForFunction(() => document.querySelector('.home-rule [role="switch"]')?.getAttribute("aria-checked") === "false", null, { timeout: 15_000 });
    check("the switch turns the auto-start off in Home Assistant", automations.get("sample_auto_start").on === false);
    check("...without rewriting its config", writes.length === 0);
    await autoSwitch.click();
    await page.waitForFunction(() => document.querySelector('.home-rule [role="switch"]')?.getAttribute("aria-checked") === "true", null, { timeout: 15_000 });

    await page.click(".home-schedule-head button:has-text('Edit')");
    await page.waitForSelector('[role="dialog"]:has-text("Cleaning schedule")');
    await page.fill('[role="dialog"] input[type="time"] >> nth=0', "08:30");
    await page.fill('[role="dialog"] input[type="time"] >> nth=1', "21:00");
    await page.fill('[role="dialog"] input[type="number"]', "95");
    for (const day of ["Sat", "Sun"]) await page.click(`[role="dialog"] .sv-day:has-text("${day}")`);
    check("the quiet-hours text follows the edited window", /between 21:00 and 08:30/.test((await page.locator('[role="dialog"] .home-check-wrap').textContent()) ?? ""));
    await page.screenshot({ path: path.join(shots, "home-schedule-dialog.png") });
    await page.click('[role="dialog"] button:has-text("Save to Home Assistant")');
    await page.waitForSelector('[role="dialog"]:has-text("Cleaning schedule")', { state: "detached", timeout: 30_000 });
    const start = automations.get("sample_auto_start").config;
    const guard = automations.get("sample_quiet_guard").config;
    check("saving rewrites the auto-start's window, days and battery", JSON.stringify(start.conditions[1]) === JSON.stringify({ condition: "time", after: "08:30:00", before: "21:00:00", weekday: ["mon", "tue", "wed", "thu", "fri"] }) && start.triggers[0].above === 94.9, JSON.stringify(start.conditions[1]));
    check("...and the guard's quiet hours, keeping its dock button", guard.conditions[1].after === "21:00:00" && guard.conditions[1].before === "08:30:00" && guard.actions.some((a) => a.target?.entity_id === DOCK), JSON.stringify(guard.conditions[1]));
    await page.waitForFunction(() => /08:30–21:00 · weekdays/.test(document.querySelector(".home-rule .home-rule-text")?.textContent ?? ""), null, { timeout: 15_000 });
    check("the card shows the saved schedule", true);
    await page.screenshot({ path: path.join(shots, "home-schedule-saved.png") });
    check("no page errors", pageErrors.length === 0, pageErrors.join(" | "));
  } finally {
    // The worker is a detached process; stop it before the instance, or it outlives the lab.
    await page?.request.post(`${BASE}/api/modules/home/service/stop`, { data: { force: true } }).catch(() => undefined);
    await browser?.close();
    killInstance(PORT);
    child.kill();
    ha.close();
  }
  console.log(`screenshots: ${shots}`);
  process.exit(check.summary());
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
