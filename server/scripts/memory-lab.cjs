// Drive Settings → Memory in a real browser, headlessly, without touching prod or the owner's memories:
// status, the behaviour toggles' round-trip, the recall tester, and create / edit / delete in the browser.
//
//   npm run memory-lab --prefix server
//   npm run memory-lab --prefix server -- --keep
//
// Why a lab: every value on the page comes from /api/memory/* over the real file-backed service and its
// index worker, and every edit lands in Markdown files a typecheck never sees. The instance boots on :4447
// against a temp DATA_DIR AND a temp MEMORY_DIR seeded below, so the owner's real memory folder is never
// read or written. Model ranking and the Luna fallback are switched off in the browser before the first
// recall, so the lab never spends a subscription call (and the bogus account tokens could not anyway).

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { loadChromium, authPassword, requireBuild, requireFreshWebBuild, boot, waitForPersisted, killInstance, createChecks, shotDir } = require("./lab-harness.cjs");

const PORT = 4447;
const BASE = `http://127.0.0.1:${PORT}`;
const NAV_TIMEOUT = 45_000; // this box runs near 100% CPU; a cold goto has measured 28s

const SEED = {
  "reference_deploy_server_change.md": [
    "---",
    "name: Deploy a server change",
    "description: How a server change goes live — build, restart through the atomic restart, then verify the dist",
    "type: reference",
    "created_at: 2026-01-02",
    "last_verified: 2026-01-02",
    "triggers:",
    "  - deploy the server",
    "---",
    "",
    "Commit first, run the deploy script, then confirm the running build matches HEAD.",
    "",
  ],
  "workflow_release_checklist.md": [
    "---",
    "name: Release checklist",
    "description: The steps before tagging a release of the example project",
    "type: workflow",
    "created_at: 2026-01-03",
    "last_verified: 2026-01-03",
    "related: [reference_deploy_server_change.md]",
    "---",
    "",
    "Update the changelog, run the full test suite, then tag.",
    "",
  ],
  "user_lunch_preference.md": [
    "---",
    "name: Lunch preference",
    "description: Alex prefers soup on cold days and salad otherwise",
    "type: user",
    "created_at: 2026-01-04",
    "last_verified: 2026-01-04",
    "---",
    "",
    "Soup when it is below ten degrees outside.",
    "",
  ],
  "MEMORY.md": [
    "# Memory index",
    "",
    "- [Deploy a server change](reference_deploy_server_change.md) — build, restart, verify",
    "- [Release checklist](workflow_release_checklist.md) — before tagging",
    "- [Lunch preference](user_lunch_preference.md) — soup or salad",
    "",
  ],
};

function seedMemories(memoryDir) {
  for (const [file, lines] of Object.entries(SEED)) fs.writeFileSync(path.join(memoryDir, file), lines.join("\n"), "utf8");
}

async function openMemorySettings(browser) {
  const page = await browser.newPage({ viewport: { width: 1500, height: 950 } });
  await page.request.post(`${BASE}/api/login`, { data: { password: authPassword() } });
  await page.goto(`${BASE}/`, { timeout: NAV_TIMEOUT });
  await page.waitForSelector(".accounts .acct", { state: "attached", timeout: 25_000 });
  await page.click('[aria-label="Open settings"]');
  await page.waitForSelector('[role="dialog"][aria-label="Settings"]', { timeout: 20_000 });
  await page.click('[data-settings-category="memory"]');
  await page.waitForSelector(".mem-stats", { timeout: 30_000 });
  return page;
}

const toggle = (label) => `button.switch[aria-label="${label}"]`;
const statValue = (page, label) => page.locator(".mem-stat").filter({ has: page.locator(`dt:text-is("${label}")`) }).locator(".mem-stat-value").textContent();

/** Switch a behaviour toggle off and wait for the server's kv row to carry it, not just the switch. */
async function switchOff(page, dataDir, label, key) {
  await page.click(toggle(label));
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const stored = await waitForPersisted(dataDir, "memory_settings", undefined, 2_000);
    if (stored && JSON.parse(stored)[key] === false) return true;
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

async function recall(page, query, mode) {
  await page.fill('input[aria-label="Recall query"]', query);
  await page.selectOption('select[aria-label="Recall mode"]', mode);
  await page.click('.mem-recall-form button[type="submit"]');
  await page.waitForFunction(() => document.querySelector('[data-testid="memory-recall-result"]') && !document.querySelector(".mem-recall-form button[disabled]"), null, { timeout: 30_000 });
  return page.evaluate(() => ({
    meta: document.querySelector(".mem-recall-meta")?.textContent ?? "",
    files: [...document.querySelectorAll(".mem-hit-file")].map((n) => n.textContent.trim()),
    badges: [...document.querySelectorAll(".mem-hit .mem-badge")].map((n) => n.textContent.trim()),
  }));
}

const listedFiles = (page) => page.$$eval(".mem-list-item .mem-list-meta", (nodes) => nodes.map((n) => n.textContent));
const fileText = (memoryDir, file) => fs.readFileSync(path.join(memoryDir, file), "utf8");

/** The list only exists once the editor has closed, and an absent list reads as "not listed". */
async function waitForListed(page, file, present) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const rows = await listedFiles(page);
    const listed = rows.some((t) => t.includes(file));
    if (rows.length && listed === present) return true;
    await page.waitForTimeout(250);
  }
  return false;
}

async function checkStatusAndToggles(page, check, dataDir) {
  check("status counts the three seeded memories", (await statValue(page, "Memories"))?.trim() === "3", await statValue(page, "Memories"));
  check("the memory folder shown is the lab's", ((await page.locator(".mem-path").textContent()) ?? "").includes("memory-lab-"), await page.locator(".mem-path").textContent());
  for (const label of ["Model relevance ranking", "Recall in GGO's agents", "Retrieval cards", "Automatic extraction", "Luna fallback"]) {
    check(`"${label}" starts on`, (await page.getAttribute(toggle(label), "aria-checked")) === "true");
  }
  check("turning model ranking off is persisted server-side", await switchOff(page, dataDir, "Model relevance ranking", "modelRanking"));
  check("turning the Luna fallback off is persisted server-side", await switchOff(page, dataDir, "Luna fallback", "lunaFallback"));
}

async function checkRecall(page, check) {
  const search = await recall(page, "how do I deploy the server", "search");
  check("search finds the deploy memory first", search.files[0] === "reference_deploy_server_change.md", JSON.stringify(search));
  check("with ranking off the hit is labelled lexical", search.badges[0] === "lexical" && search.meta.includes("lexical"), JSON.stringify(search));
  const offTopic = await recall(page, "quarterly tax filing deadlines", "prompt");
  check("prompt recall injects nothing for an off-topic prompt", offTopic.files.length === 0, JSON.stringify(offTopic));
}

async function checkCustomTypeEdit(page, check, memoryDir) {
  await page.locator(".mem-list-item").filter({ hasText: "Release checklist" }).click();
  await page.waitForSelector('[data-testid="memory-editor"] textarea', { timeout: 15_000 });
  check("the editor shows the custom type as selected", (await page.locator('[data-testid="memory-editor"] select').inputValue()) === "workflow");
  await page.locator(".mem-field").filter({ hasText: "Description" }).locator("input").fill("The steps before tagging a release, edited in the lab");
  await page.click('.mem-editor-actions button:text-is("Save")');
  await page.waitForSelector(".mem-browser", { timeout: 15_000 });
  const text = fileText(memoryDir, "workflow_release_checklist.md");
  check("the edit reached the file", text.includes("description: The steps before tagging a release, edited in the lab"), text);
  check("an untouched custom type survives the edit", /^type: workflow$/m.test(text), text);
  check("an untouched related link survives the edit", text.includes("related: [reference_deploy_server_change.md]"), text);
}

async function checkCreateAndDelete(page, check, memoryDir) {
  await page.click('.mem-browser-bar button:text-is("New memory")');
  const editor = page.locator('[data-testid="memory-editor"]');
  await editor.locator(".mem-field").filter({ hasText: "Name" }).locator("input").fill("Lab created memory");
  await editor.locator(".mem-field").filter({ hasText: "Description" }).locator("input").fill("A memory the browser lab writes and then deletes");
  await editor.locator("select").selectOption("project");
  await editor.locator("textarea").fill("Written through Settings, Memory by the lab.");
  await page.click('.mem-editor-actions button:text-is("Create")');
  const file = "project_lab_created_memory.md";
  check("create lists the new memory", await waitForListed(page, file, true));
  check("create wrote the file with its frontmatter", fs.existsSync(path.join(memoryDir, file)) && /^type: project$/m.test(fileText(memoryDir, file)));
  check("create added an index pointer", fileText(memoryDir, "MEMORY.md").includes(`(${file})`), fileText(memoryDir, "MEMORY.md"));
  check("status counts the new memory", await page.waitForFunction(() => document.querySelector(".mem-stat-value")?.textContent?.trim() === "4", null, { timeout: 20_000 }).then(() => true, () => false));

  await page.locator(".mem-list-item").filter({ hasText: "Deploy a server change" }).click();
  await page.waitForSelector('[data-testid="memory-editor"] textarea', { timeout: 15_000 });
  await page.click(".mem-delete");
  await page.click('.mem-delete:text-is("Move to trash")');
  check("delete removes it from the list", await waitForListed(page, "reference_deploy_server_change.md", false));
  check("delete moved the file into .ggo-trash", !fs.existsSync(path.join(memoryDir, "reference_deploy_server_change.md")) && fs.readdirSync(path.join(memoryDir, ".ggo-trash")).some((f) => f.endsWith("_reference_deploy_server_change.md")));
  check("delete dropped its index pointer", !fileText(memoryDir, "MEMORY.md").includes("(reference_deploy_server_change.md)"), fileText(memoryDir, "MEMORY.md"));
  check("delete dropped the related link to it", !fileText(memoryDir, "workflow_release_checklist.md").includes("reference_deploy_server_change.md"), fileText(memoryDir, "workflow_release_checklist.md"));
}

async function main() {
  requireBuild();
  requireFreshWebBuild();
  const check = createChecks();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "memory-lab-data-"));
  const memoryDir = fs.mkdtempSync(path.join(os.tmpdir(), "memory-lab-"));
  const keep = process.argv.includes("--keep");
  seedMemories(memoryDir);
  console.log(`memory-lab — ${BASE} (data ${dataDir}, memories ${memoryDir})`);

  try {
    await boot({ dataDir, port: PORT, env: { MEMORY_DIR: memoryDir, GROK_HOME_DIR: path.join(dataDir, ".grok"), ZAI_API_KEY: "" } });
    const browser = await loadChromium().launch();
    try {
      const page = await openMemorySettings(browser);
      await checkStatusAndToggles(page, check, dataDir);
      await checkRecall(page, check);
      await checkCustomTypeEdit(page, check, memoryDir);
      await checkCreateAndDelete(page, check, memoryDir);
      const shot = path.join(shotDir(dataDir), "memory-settings.png");
      await page.locator('[role="dialog"][aria-label="Settings"]').screenshot({ path: shot });
      console.log(`  screenshot: ${shot}`);
      await page.close();

      const second = await openMemorySettings(browser);
      check("model ranking stays off after a reload", (await second.getAttribute(toggle("Model relevance ranking"), "aria-checked")) === "false");
      await second.close();
    } finally {
      await browser.close();
    }
    return check.summary();
  } finally {
    killInstance(PORT);
    if (!keep) for (const dir of [dataDir, memoryDir]) fs.rmSync(dir, { recursive: true, force: true });
    else console.log(`kept ${dataDir} and ${memoryDir}`);
  }
}

main().then(
  (code) => process.exit(code),
  (e) => {
    console.error(e);
    killInstance(PORT);
    process.exit(1);
  },
);
