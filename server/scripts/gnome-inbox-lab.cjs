// Real browser and CLI against a throwaway database/server; never sends to production agents.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { spawnSync } = require("node:child_process");
const assert = require("node:assert/strict");
const { SERVER_ROOT, loadChromium, requireBuild, boot, killInstance } = require("./lab-harness.cjs");

const PORT = 4387;
const BASE = `http://127.0.0.1:${PORT}`;
const PASSWORD = "inbox-lab-fixture-password";
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gnome-inbox-lab-"));
let checks = 0;
function check(label, condition) { assert.ok(condition, label); checks++; console.log(`PASS ${label}`); }

async function main() {
  requireBuild();
  // Initialize through Db itself before boot, so the seed has the exact current schema. All runs are
  // terminal and all tasks are drafts: boot cannot dispatch a real model from these fixtures.
  process.env.DATA_DIR = dir;
  const { Db } = await import(pathToFileURL(path.join(SERVER_ROOT, "dist/db/db.js")).href);
  const { DirectMessages } = await import(pathToFileURL(path.join(SERVER_ROOT, "dist/office/directMessages.js")).href);
  const db = new Db(path.join(dir, "orchestrator.sqlite"));
  const a = db.createThread({ title: "Parser fixture", workspace: "C:/example/parser", rawPrompt: "fixture" });
  const b = db.createThread({ title: "Renderer fixture", workspace: "C:/example/renderer", rawPrompt: "fixture" });
  for (const thread of [a, b]) {
    const run = db.createRun({ threadId: thread.id, role: "implementor", model: "fixture", account: "fixture", effort: "low" });
    db.updateRun(run.id, { state: "done", endedAt: Date.now() });
  }
  const from = { threadId: a.id, role: "implementor" };
  const to = { threadId: b.id, role: "implementor" };
  const names = { [`${a.id}::implementor`]: "Aster Ink", [`${b.id}::implementor`]: "Copper Vale" };
  db.kvSet("office_names", JSON.stringify(names));
  const letters = new DirectMessages(db, (id, role) => names[`${id}::${role}`]);
  const senderToken = letters.capability(from);
  const receiverToken = letters.capability(to);
  for (let index = 0; index < 105; index++) letters.send(from, to, `History letter ${index}`);
  db.raw.close();

  let browser;
  let child;
  try {
    child = await boot({ dataDir: dir, port: PORT, env: { AUTH_PASSWORD: PASSWORD, GOOGLE_CLIENT_ID: "", GOOGLE_CLIENT_SECRET: "", REMOTE_ACCESS: "0" } });
    const chromium = loadChromium();
    browser = await chromium.launch({ headless: true });
    for (const mobile of [false, true]) {
      const context = await browser.newContext({ viewport: mobile ? { width: 390, height: 844 } : { width: 1280, height: 900 }, isMobile: mobile, hasTouch: mobile });
      const login = await context.request.post(`${BASE}/api/login`, { data: { password: PASSWORD } });
      check(`${mobile ? "phone" : "desktop"} authenticated`, login.ok());
      const page = await context.newPage();
      const errors = [];
      page.on("pageerror", error => errors.push(error.message));
      // A proxy serving only /orchestrator/ rejects origin-root API requests. Exercise
      // that deployment on desktop while retaining root-mount coverage on phone.
      if (!mobile) await page.route(`${BASE}/api/**`, route => route.fulfill({ status: 404, body: "Wrong API mount" }));
      await page.goto(mobile ? BASE : `${BASE}/orchestrator/`, { waitUntil: "domcontentloaded", timeout: 60000 });
      await page.locator('[data-office-room="general"]').first().click({ timeout: 60000 });
      await page.getByRole("button", { name: "Gnome inbox", exact: true }).click();
      const inbox = page.getByRole("region", { name: "Direct gnome inbox" });
      await inbox.waitFor();
      if (!mobile) {
        await page.route("**/api/gnome-inbox/directory", route => route.fulfill({ status: 404, contentType: "text/html", body: "<p>Not found</p>" }));
        await page.getByRole("alert").waitFor();
        check("missing live endpoint reports activation state clearly", (await page.getByRole("alert").innerText()).includes("waiting for server activation"));
        await page.unroute("**/api/gnome-inbox/directory");
        await page.getByRole("alert").waitFor({ state: "detached" });
      }
      await page.getByRole("button", { name: /Copper Vale.*implementor/ }).click();
      await page.locator(".gnome-inbox-letters").getByText("History letter 104", { exact: true }).waitFor();
      check(`${mobile ? "phone" : "desktop"} selected inbox has unread status`, (await page.locator(".gnome-inbox-conversation h3").innerText()).includes(`${mobile ? 106 : 105} unread`));
      await page.getByRole("button", { name: "Earlier messages", exact: true }).click();
      await page.getByText("History letter 0", { exact: true }).waitFor();
      check(`${mobile ? "phone" : "desktop"} earlier history loaded`, await page.locator(".gnome-inbox-letter").count() === (mobile ? 106 : 105));
      const input = page.getByRole("textbox", { name: "Message Copper Vale", exact: true });
      const body = mobile ? "Phone quiet ping ✅" : "Desktop quiet ping Ångström";
      await input.fill(body);
      if (!mobile) {
        await page.route("**/api/gnome-inbox/messages", route => route.request().method() === "POST" ? undefined : route.continue());
        await page.getByRole("button", { name: "Send quietly", exact: true }).click();
        await page.getByRole("alert").waitFor();
        check("failed send keeps draft and reports failure", await input.inputValue() === body);
        check("stalled send times out and releases the composer", (await page.getByRole("alert").innerText()).includes("timed out") && await page.getByRole("button", { name: "Send quietly", exact: true }).isEnabled());
        await page.unroute("**/api/gnome-inbox/messages");
      }
      await page.getByRole("button", { name: "Send quietly", exact: true }).click();
      await page.getByRole("status").filter({ hasText: "Queued for Copper Vale" }).waitFor();
      check(`${mobile ? "phone" : "desktop"} sent mail renders and draft clears`, await input.inputValue() === "" && await page.getByText(body, { exact: true }).count() === 1);
      const read = await context.request.get(`${BASE}/api/gnome-inbox/messages?${new URLSearchParams(to)}`);
      check(`${mobile ? "phone" : "desktop"} owner inspection does not acknowledge`, read.ok() && read.json && (await read.json()).unread >= 106);
      await page.getByRole("textbox", { name: "Find a gnome" }).fill("Parser fixture");
      check(`${mobile ? "phone" : "desktop"} directory search works`, await page.locator(".gnome-inbox-people button").count() === 1 && (await page.locator(".gnome-inbox-people").innerText()).includes("Aster Ink"));
      await page.getByRole("textbox", { name: "Find a gnome" }).fill("");
      await page.getByRole("button", { name: /Aster Ink.*implementor/ }).click();
      check(`${mobile ? "phone" : "desktop"} switching recipient resets composer`, await page.getByRole("textbox", { name: "Message Aster Ink", exact: true }).inputValue() === "");
      const bounds = await inbox.boundingBox();
      check(`${mobile ? "phone" : "desktop"} inbox fits viewport`, bounds && bounds.x >= 0 && bounds.x + bounds.width <= (mobile ? 390 : 1280) && bounds.y + bounds.height <= (mobile ? 844 : 900));
      check(`${mobile ? "phone" : "desktop"} no horizontal content overflow`, await inbox.evaluate(element => element.scrollWidth <= element.clientWidth + 1));
      await page.getByRole("button", { name: "Office", exact: true }).click();
      check(`${mobile ? "phone" : "desktop"} can return to group chat`, await page.locator(".office-msgs").count() === 1 && await inbox.count() === 0);
      check(`${mobile ? "phone" : "desktop"} no browser exceptions`, errors.length === 0);
      await context.close();
    }
    const cli = (token, action, value, input) => spawnSync(process.execPath, [path.join(SERVER_ROOT, "scripts/gnome-inbox.cjs"), BASE, token, action, ...(value ? [String(value)] : [])], { input, encoding: "utf8", timeout: 20000, windowsHide: true });
    const directory = cli(senderToken, "directory");
    check("CLI lists stable gnome addresses", directory.status === 0 && JSON.parse(directory.stdout).some(entry => entry.threadId === b.id && entry.role === "implementor"));
    const sent = cli(senderToken, "send", null, JSON.stringify({ recipient: to, body: "CLI quiet ping 東京 ✅" }));
    check("CLI sends exact Unicode mail through scoped route", sent.status === 0 && JSON.parse(sent.stdout).body === "CLI quiet ping 東京 ✅");
    const read = cli(receiverToken, "read");
    const inbox = JSON.parse(read.stdout);
    check("CLI reads recipient inbox without consuming mail", read.status === 0 && inbox.unread === 108 && inbox.messages.some(letter => letter.body === "CLI quiet ping 東京 ✅"));
    const acked = cli(receiverToken, "ack", inbox.messages.at(-1).id);
    check("CLI explicitly acknowledges recipient mail", acked.status === 0 && JSON.parse(acked.stdout).acknowledged === 108);
    const invalid = cli("bogus", "read");
    check("CLI refuses invalid capability", invalid.status === 1 && invalid.stderr.includes("Invalid inbox capability"));
    console.log(`${checks} browser/CLI checks passed`);
  } finally {
    if (browser) await browser.close();
    if (child) await killInstance(PORT, child);
  }
}
main().then(() => { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 }); }).catch(error => { console.error(error); console.error(`Diagnostic log retained in ${dir}`); process.exitCode = 1; });
