// Real browser regression with a fake registry and throwaway GGO. Never controls a real script.
// Build server/dist and web/dist in this checkout before running this lab.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const { requireBuild, boot, killInstance, loadChromium, authPassword, createChecks } = require("./lab-harness.cjs");
const { login } = require("./inject-thread.cjs");
const PORT = Number(process.env.SCRIPTHUB_LAB_PORT || 4507);
const BASE = `http://127.0.0.1:${PORT}`;
const check = createChecks();
const scripts = [
  { id: "alpha", owner: "alex", displayName: "Alpha app", category: "tools", tags: ["dashboard"] },
  { id: "beta", owner: "alex", agentManaged: true, keepAlive: true, displayName: "Beta worker", category: "tools", tags: ["maintenance"] },
  { id: "gamma", agentManaged: false, displayName: "Gamma game", category: "games", tags: ["play"] },
].map((script) => ({ ...script, status: { state: script.id === "gamma" ? "running" : "stopped", processes: [], tasks: [] } }));

(async () => {
  requireBuild();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "scripthub-organization-lab-"));
  const registryPath = path.join(dataDir, "registry", "scripts.json");
  fs.mkdirSync(path.dirname(registryPath));
  fs.writeFileSync(registryPath, JSON.stringify({ scripts: [...scripts, { id: "script-hub", agentManaged: true, start: { workingDir: dataDir } }] }));
  const registry = () => JSON.parse(fs.readFileSync(registryPath, "utf8"));
  const hub = http.createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.url === "/api/scripts") return res.end(JSON.stringify(registry()));
    if (req.url === "/api/status") return res.end(JSON.stringify({ generatedAt: new Date().toISOString(), scripts: registry().scripts.filter((script) => script.id !== "script-hub") }));
    res.writeHead(404);
    res.end(JSON.stringify({ error: "not found" }));
  });
  await new Promise((resolve) => hub.listen(0, "127.0.0.1", resolve));
  let child;
  let browser;
  let cookie;
  try {
    killInstance(PORT);
    child = await boot({ dataDir, port: PORT, env: { SCRIPT_HUB_URL: `http://127.0.0.1:${hub.address().port}` } });
    cookie = await login(BASE, authPassword());
    browser = await loadChromium().launch();
    const errors = [];
    for (const phone of [false, true]) {
      const context = await browser.newContext({ viewport: phone ? { width: 390, height: 844 } : { width: 1440, height: 900 }, hasTouch: phone, isMobile: phone });
      const page = await context.newPage();
      page.on("pageerror", (error) => errors.push(error.message));
      await context.addInitScript(() => localStorage.setItem("director_settings", JSON.stringify({ shownModuleTabs: ["scripthub"] })));
      await page.request.post(`${BASE}/api/login`, { data: { password: authPassword() } });
      async function open() {
        await page.waitForSelector(".accounts .acct", { state: "attached", timeout: 60_000 });
        if (phone) await page.selectOption('select[aria-label="All areas"]', "scripthub");
        else await page.click(".board-tab.bt-scripthub");
        await page.waitForSelector('[data-script-id="alpha"]', { timeout: 60_000 });
      }
      if (!phone) await page.route("**/api/modules/scripthub/api/status", async (route) => {
        const response = await route.fetch();
        const data = await response.json();
        data.scripts = data.scripts.map(({ management, tags, ...script }) => script);
        await route.fulfill({ response, json: data });
      });
      await page.goto(BASE);
      await open();
      if (!phone) {
        check("client tolerates an older worker during deployment", errors.length === 0 && await page.locator(".sh-card").count() === 2);
        await page.unroute("**/api/modules/scripthub/api/status");
        await page.reload();
        await open();
      }
      const label = phone ? "phone" : "desktop";
      check(`${label}: explicit agent entry with a person owner is hidden`, await page.locator('[data-script-id="beta"]').count() === 0);
      check(`${label}: explicit personal entry without an owner is visible`, await page.locator('[data-script-id="gamma"]').count() === 1);
      await page.getByLabel("Tag", { exact: true }).selectOption("play");
      check(`${label}: tag filtering shows only matching app`, await page.locator(".sh-card").count() === 1);
      await page.reload();
      if (phone) await page.selectOption('select[aria-label="All areas"]', "scripthub");
      else await page.click(".board-tab.bt-scripthub");
      await page.waitForSelector('[data-script-id="gamma"]');
      check(`${label}: filter survives reload`, await page.getByLabel("Tag", { exact: true }).inputValue() === "play");
      await page.getByRole("button", { name: "Reset filters", exact: true }).click();
      await page.getByLabel("Show agent-managed", { exact: false }).check();
      check(`${label}: categories are absent`, await page.getByLabel("Category", { exact: true }).count() === 0);
      check(`${label}: name sort orders the full list`, JSON.stringify(await page.locator(".sh-card h4").allTextContents()) === JSON.stringify(["Alpha app", "Beta worker", "Gamma game"]));
      await page.getByLabel("Sort scripts").selectOption("urgency");
      check(`${label}: recovery sort prioritizes the recovering worker`, JSON.stringify(await page.locator(".sh-card h4").allTextContents()) === JSON.stringify(["Beta worker", "Gamma game", "Alpha app"]));
      await page.getByRole("button", { name: "Reset filters", exact: true }).click();
      const card = page.locator('[data-script-id="gamma"]');
      await card.getByRole("button", { name: "Edit entry", exact: true }).click();
      const entryEditor = card.getByRole("form", { name: "Edit Gamma game" });
      await entryEditor.getByLabel("Name", { exact: true }).waitFor();
      await entryEditor.getByLabel("Description", { exact: true }).fill(`${label} edited description`);
      await entryEditor.getByLabel("Launch type", { exact: true }).fill("process");
      await entryEditor.getByLabel("Executable", { exact: true }).fill("node");
      await entryEditor.getByLabel("Arguments (JSON array)").fill('["game.js", "--test"]');
      check(`${label}: entry editor fits viewport`, await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
      check(`${label}: entry editor reflects default hidden launch`, await entryEditor.getByLabel("Start hidden", { exact: true }).isChecked());
      // Advance the revision outside the UI to prove a stale save keeps the draft intact.
      const changed = registry();
      changed.scripts.find((script) => script.id === "gamma").notes = [`${label} concurrent update`];
      fs.writeFileSync(registryPath, JSON.stringify(changed));
      await entryEditor.getByRole("button", { name: "Save entry", exact: true }).click();
      await entryEditor.getByRole("alert").waitFor();
      check(`${label}: stale registry save keeps draft`, (await entryEditor.getByRole("alert").textContent()).includes("changed since") && await entryEditor.getByLabel("Description", { exact: true }).inputValue() === `${label} edited description`);
      await entryEditor.getByRole("button", { name: "Cancel", exact: true }).click();
      await card.getByRole("button", { name: "Edit entry", exact: true }).click();
      await entryEditor.getByLabel("Notes (one per line)").waitFor();
      await entryEditor.getByLabel("Name", { exact: true }).fill("Gamma game");
      check(`${label}: reopening loads peer changes`, await entryEditor.getByLabel("Notes (one per line)").inputValue() === `${label} concurrent update`);
      await entryEditor.getByLabel("Description", { exact: true }).fill(`${label} edited description`);
      await entryEditor.getByLabel("Launch type", { exact: true }).fill("process");
      await entryEditor.getByLabel("Executable", { exact: true }).fill("node");
      await entryEditor.getByLabel("Arguments (JSON array)").fill('["game.js", "--test"]');
      await entryEditor.getByRole("button", { name: "Save entry", exact: true }).click();
      await entryEditor.waitFor({ state: "detached" });
      check(`${label}: entry edits update cards`, await card.locator(".sh-desc").textContent() === `${label} edited description` && await card.locator(".sh-cmd").textContent() === "node game.js --test");
      const savedEntry = registry().scripts.find((script) => script.id === "gamma");
      check(`${label}: launch edits saved to actual registry`, savedEntry.start.executable === "node" && savedEntry.start.args[1] === "--test" && savedEntry.notes[0] === `${label} concurrent update`);
      await card.getByRole("button", { name: "Organize", exact: true }).click();
      const editor = card.getByRole("form");
      await editor.getByLabel("Tags (comma separated)").fill("play, Favourite, favourite");
      if (!phone) {
        await page.route("**/scripts/gamma/organization", (route) => route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "test save failure" }) }));
        await editor.getByRole("button", { name: "Save organization" }).click();
        await editor.getByRole("alert").waitFor();
        check("failed save keeps the editable draft", await editor.getByLabel("Tags (comma separated)").inputValue() === "play, Favourite, favourite");
        await page.unroute("**/scripts/gamma/organization");
      }
      await editor.getByRole("button", { name: "Save organization" }).click();
      await editor.waitFor({ state: "detached" });
      await card.getByRole("button", { name: "favourite", exact: true }).waitFor();
      check(`${label}: normalized tags survive API save`, await card.getByRole("button", { name: "favourite", exact: true }).count() === 1);
      await card.getByRole("button", { name: "favourite", exact: true }).click();
      check(`${label}: tag badge filters`, await page.getByLabel("Tag", { exact: true }).inputValue() === "favourite");
      await page.getByRole("button", { name: "Reset filters", exact: true }).click();
      await card.getByRole("button", { name: "Organize", exact: true }).click();
      await editor.getByLabel("Managed as").selectOption("agent");
      await editor.getByRole("button", { name: "Save organization" }).click();
      await card.waitFor({ state: "detached" });
      check(`${label}: marking an app agent-managed removes it from the default view`, await page.locator(".sh-card").count() === 1);
      await page.getByLabel("Show agent-managed", { exact: false }).check();
      await card.waitFor();
      await card.getByRole("button", { name: "Organize", exact: true }).click();
      await editor.getByLabel("Managed as").selectOption("personal");
      await editor.getByRole("button", { name: "Save organization" }).click();
      await editor.waitFor({ state: "detached" });
      await page.getByRole("button", { name: "Reset filters", exact: true }).click();
      await page.getByLabel("Search scripts").fill("play favourite");
      check(`${label}: search combines multiple tags regardless of tag order`, await page.locator(".sh-card").count() === 1);
      await page.getByRole("button", { name: "Reset filters", exact: true }).click();
      await card.getByRole("button", { name: "Organize", exact: true }).click();
      check(`${label}: editor fits the viewport`, await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
      await context.close();
    }
    check("browser has no page errors", errors.length === 0, errors.join(" | "));
  } finally {
    if (browser) await browser.close();
    if (cookie !== undefined) await fetch(`${BASE}/api/modules/scripthub/service/stop`, { method: "POST", headers: { cookie, "content-type": "application/json" }, body: "{}" }).catch(() => {});
    if (child) child.kill();
    killInstance(PORT);
    await new Promise((resolve) => hub.close(resolve));
    fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5 });
  }
  process.exitCode = check.summary() ? 1 : 0;
})().catch((error) => { console.error(error); process.exitCode = 1; });
