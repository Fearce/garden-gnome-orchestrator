#!/usr/bin/env node
/**
 * task-model-lab — drives the task-detail provider/model picker through its real browser → WebSocket
 * → ThreadManager → SQLite round-trip on a throwaway instance. It covers the compact desktop trigger,
 * persisted exact pin + Auto reset, the running-task guard, and the phone touch layout.
 *
 *   npm run task-model-lab --prefix server
 *   npm run task-model-lab --prefix server -- --shots data/task-model-lab-shots
 *
 * Not in GATES: it needs a real browser and disposable server, like the other `*-lab` scripts.
 */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const Database = require("better-sqlite3");
const {
  SERVER_ROOT,
  loadChromium,
  authPassword,
  requireBuild,
  boot,
  killInstance,
  createChecks,
  boxBounds,
  shotDir,
} = require("./lab-harness.cjs");

const PORT = 4401;
const BASE = `http://127.0.0.1:${PORT}`;
const TASK_ID = "8a1ff64d-a4e0-41f4-a0bf-b23637f013d8";
const ACTIVE_TASK_ID = "9747655b-b4e3-4629-a810-79b4cc54ebaa";
const check = createChecks();

/** Compile the current server source without replacing live `dist`. The output must be a DIRECT child
 * of the server root: config.ts deliberately derives `serverRoot` as its compiled file's parent, so a
 * nested temp build would point static assets at the wrong directory. This dedicated path is gitignored
 * and cannot collide with ide-lab's sibling build. */
function compileIsolatedServer() {
  const buildDir = path.join(SERVER_ROOT, ".task-model-lab-dist");
  fs.rmSync(buildDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  try {
    execFileSync(
      process.execPath,
      [require.resolve("typescript/bin/tsc"), "-p", "tsconfig.json", "--outDir", buildDir],
      { cwd: SERVER_ROOT, stdio: "inherit", windowsHide: true },
    );
    return { buildDir, entry: path.join(buildDir, "index.js") };
  } catch (error) {
    fs.rmSync(buildDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    throw error;
  }
}

function seed(dataDir) {
  const db = new Database(path.join(dataDir, "orchestrator.sqlite"));
  const at = Date.now();
  const insert = db.prepare(
    `INSERT INTO threads(id, title, state, workspace, brief, raw_prompt, model_request, created_at, updated_at)
     VALUES(@id, @title, @state, @workspace, 'Seeded browser check', 'Seeded browser check', @request, @at, @at)`,
  );
  insert.run({
    id: TASK_ID,
    title: "Choose an exact task model",
    state: "paused",
    workspace: path.resolve(SERVER_ROOT, ".."),
    request: null,
    at,
  });
  insert.run({
    id: ACTIVE_TASK_ID,
    title: "Running task model guard",
    state: "implementing",
    workspace: path.resolve(SERVER_ROOT, ".."),
    request: JSON.stringify({
      requested: "claude-opus-5",
      provider: "claude",
      model: "claude-opus-5",
      strict: true,
      selectedAt: at - 1_000,
    }),
    at,
  });
  // A second enabled provider makes the provider choice itself observable. The harness supplies only
  // bogus tokens, so this cannot spend quota or start provider work.
  db.prepare(
    "INSERT INTO kv(key, value) VALUES('setting_codex_enabled', '1') ON CONFLICT(key) DO UPDATE SET value='1'",
  ).run();
  db.close();
}

function readModelRequest(dataDir, threadId = TASK_ID) {
  const db = new Database(path.join(dataDir, "orchestrator.sqlite"), { readonly: true });
  const row = db.prepare("SELECT model_request FROM threads WHERE id = ?").get(threadId);
  db.close();
  return row?.model_request ? JSON.parse(row.model_request) : null;
}

async function waitForModelRequest(dataDir, predicate, message) {
  for (let i = 0; i < 80; i++) {
    const request = readModelRequest(dataDir);
    if (predicate(request)) return request;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`${message}; last value: ${JSON.stringify(readModelRequest(dataDir))}`);
}

function captureBrowserErrors(page, errors) {
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
}

async function loginAndLoad(page) {
  const login = await page.request.post(`${BASE}/api/login`, { data: { password: authPassword() } });
  if (!login.ok()) throw new Error(`Lab login failed: HTTP ${login.status()}`);
  await page.goto(`${BASE}/`, { timeout: 45_000 }).catch(() => page.goto(`${BASE}/`, { timeout: 45_000 }));
  await page.waitForSelector(".accounts .acct", { timeout: 30_000 }); // server-authoritative hello landed
}

async function openTask(page, threadId, title) {
  await page.click(`[data-thread-id="${threadId}"]`);
  await page.waitForSelector(".detail", { state: "visible", timeout: 20_000 });
  await page.waitForFunction(
    (expected) => document.querySelector(".detail-head")?.textContent?.includes(expected),
    title,
    { timeout: 20_000 },
  );
}

async function desktopPass(browser, dataDir, shots, errors) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  captureBrowserErrors(page, errors);
  await loginAndLoad(page);
  await openTask(page, TASK_ID, "Choose an exact task model");

  let trigger = page.locator('[aria-label="Choose task provider and model"]');
  const triggerBox = boxBounds(await trigger.boundingBox());
  check(
    "desktop: the task footer exposes one compact model button",
    (await trigger.count()) === 1 && !!triggerBox && Math.abs(triggerBox.width - 30) < 1 && Math.abs(triggerBox.height - 28) < 1,
    JSON.stringify(triggerBox),
  );

  await trigger.click();
  let popover = page.locator('[role="dialog"][aria-label="Choose exact task model"]');
  await popover.waitFor({ state: "visible" });
  const popoverBox = boxBounds(await popover.boundingBox());
  check(
    "desktop: the picker opens above the footer without clipping",
    !!popoverBox && !!triggerBox && popoverBox.bottom < triggerBox.top,
    JSON.stringify({ popoverBox, triggerBox }),
  );

  const provider = page.locator('select[aria-label="Task provider"]');
  const providerLabels = await provider.locator("option").allTextContents();
  check(
    "the provider choice includes Claude and enabled Codex",
    providerLabels.some((label) => label.startsWith("Claude")) &&
      providerLabels.some((label) => label.startsWith("Codex") && !label.includes("disabled")),
    JSON.stringify(providerLabels),
  );
  await provider.selectOption("codex");

  const model = page.locator('select[aria-label="Task model"]');
  const modelValues = await model.locator("option").evaluateAll((options) => options.map((option) => option.value));
  const expectedModel = modelValues.find(Boolean);
  check("Codex exposes at least one exact model", !!expectedModel, JSON.stringify(modelValues));
  if (!expectedModel) throw new Error("No Codex model was available in the task picker.");
  await model.selectOption(expectedModel);
  await page.getByRole("button", { name: "Pin exact model", exact: true }).click();
  await popover.waitFor({ state: "detached" });

  const request = await waitForModelRequest(
    dataDir,
    (value) => value?.provider === "codex" && value.model === expectedModel && Number.isSafeInteger(value.selectedAt),
    "Exact task model was not persisted",
  );
  check("the click persists the exact provider/model with a selection timestamp", !!request, JSON.stringify(request));
  check(
    "the closed trigger visibly carries the new pin",
    (await trigger.getAttribute("data-task-model")) === expectedModel && (await trigger.getAttribute("class"))?.includes("pinned"),
    await trigger.getAttribute("data-task-model"),
  );
  check(
    "the detail status says the new pin is waiting for its first run",
    (await page.locator(".model-request-status").textContent())?.includes("waiting to start"),
    await page.locator(".model-request-status").textContent(),
  );
  await page.waitForFunction(
    () => document.querySelector(".feed")?.textContent?.includes("No fallback model is allowed"),
    { timeout: 15_000 },
  );
  check("the task feed records the strict no-fallback contract", true);

  await trigger.click();
  popover = page.locator('[role="dialog"][aria-label="Choose exact task model"]');
  await popover.waitFor({ state: "visible" });
  await page.screenshot({ path: path.join(shots, "task-model-desktop.png") });
  await page.getByRole("button", { name: "Close model picker", exact: true }).click();

  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForSelector(".accounts .acct", { timeout: 30_000 });
  await openTask(page, TASK_ID, "Choose an exact task model");
  trigger = page.locator('[aria-label="Choose task provider and model"]');
  check(
    "the exact pin survives a full browser reload",
    (await trigger.getAttribute("data-task-model")) === expectedModel,
    await trigger.getAttribute("data-task-model"),
  );

  await trigger.click();
  await page.getByRole("button", { name: "Use Auto", exact: true }).click();
  await waitForModelRequest(dataDir, (value) => value === null, "Auto routing did not clear the task pin");
  check(
    "Use Auto clears both the durable pin and its closed-trigger highlight",
    (await trigger.getAttribute("data-task-model")) === "auto" && !(await trigger.getAttribute("class"))?.includes("pinned"),
    `${await trigger.getAttribute("data-task-model")} | ${await trigger.getAttribute("class")}`,
  );

  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForSelector(".accounts .acct", { timeout: 30_000 });
  await openTask(page, TASK_ID, "Choose an exact task model");
  check(
    "Auto routing survives a full browser reload",
    (await page.locator('[aria-label="Choose task provider and model"]').getAttribute("data-task-model")) === "auto",
  );

  await openTask(page, ACTIVE_TASK_ID, "Running task model guard");
  await page.locator('[aria-label="Choose task provider and model"]').click();
  const warning = await page.locator(".task-model-warning").textContent();
  check("a running task explains that it must be interrupted first", /Interrupt the current implementor/.test(warning ?? ""), warning);
  check(
    "a running task disables both routing mutations",
    (await page.getByRole("button", { name: "Use Auto", exact: true }).isDisabled()) &&
      (await page.getByRole("button", { name: "Pin exact model", exact: true }).isDisabled()),
  );
  await context.close();
}

async function phonePass(browser, shots, errors) {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
  });
  const page = await context.newPage();
  captureBrowserErrors(page, errors);
  await loginAndLoad(page);
  check(
    "phone: touch media emulation is active",
    await page.evaluate(() => matchMedia("(pointer: coarse)").matches && matchMedia("(hover: none)").matches),
  );
  await openTask(page, TASK_ID, "Choose an exact task model");

  const composeToggle = page.locator(".mobile-inject-toggle");
  await composeToggle.waitFor({ state: "visible" });
  await composeToggle.click();
  await page.locator(".inject-bar:not(.mobile-collapsed)").waitFor({ state: "visible" });

  const trigger = page.locator('[aria-label="Choose task provider and model"]');
  const triggerBox = boxBounds(await trigger.boundingBox());
  check(
    "phone: the model control has a full 44px touch target",
    !!triggerBox && triggerBox.width >= 44 && triggerBox.height >= 44,
    JSON.stringify(triggerBox),
  );
  const closeBox = boxBounds(await page.locator('[aria-label="Hide message composer"]').boundingBox());
  const overlaps = !!triggerBox && !!closeBox &&
    triggerBox.left < closeBox.right && triggerBox.right > closeBox.left && triggerBox.top < closeBox.bottom && triggerBox.bottom > closeBox.top;
  check("phone: the model and composer-close touch targets do not overlap", !overlaps, JSON.stringify({ triggerBox, closeBox }));

  await trigger.click();
  const popover = page.locator('[role="dialog"][aria-label="Choose exact task model"]');
  await popover.waitFor({ state: "visible" });
  const popoverBox = boxBounds(await popover.boundingBox());
  check(
    "phone: the picker remains inside the viewport",
    !!popoverBox && popoverBox.left >= -1 && popoverBox.right <= 391 && popoverBox.top >= -1 && popoverBox.bottom <= 845,
    JSON.stringify(popoverBox),
  );
  check(
    "phone: the picker is actually tappable",
    await page.evaluate(() => {
      const element = document.querySelector('[role="dialog"][aria-label="Choose exact task model"]');
      if (!element) return false;
      const rect = element.getBoundingClientRect();
      const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + 12);
      return !!hit && (hit === element || element.contains(hit));
    }),
  );
  await page.screenshot({ path: path.join(shots, "task-model-phone.png") });
  await context.close();
}

async function main() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "task-model-lab-"));
  const shots = shotDir(dataDir);
  const errors = [];
  let browser;
  let buildDir;
  try {
    const build = compileIsolatedServer();
    buildDir = build.buildDir;
    requireBuild(build.entry);
    killInstance(PORT);
    await boot({ dataDir, port: PORT, entry: build.entry, env: { CODEX_WAKE: "off" } });
    seed(dataDir);
    browser = await loadChromium().launch();
    await desktopPass(browser, dataDir, shots, errors);
    await phonePass(browser, shots, errors);
    check("no browser console or page errors occurred", errors.length === 0, errors.slice(0, 4).join(" | "));
    return check.summary();
  } catch (error) {
    if (errors.length) console.error(`browser errors before failure:\n  ${errors.join("\n  ")}`);
    const logPath = path.join(dataDir, "lab.log");
    if (fs.existsSync(logPath)) {
      const tail = fs.readFileSync(logPath, "utf8").split(/\r?\n/).slice(-80).join("\n").trim();
      if (tail) console.error(`throwaway server log tail:\n${tail}`);
    }
    throw error;
  } finally {
    if (browser) await browser.close().catch(() => {});
    killInstance(PORT);
    fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    if (buildDir) fs.rmSync(buildDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
}

main().then(
  (code) => process.exit(code),
  (error) => {
    console.error("task-model-lab error:", error);
    killInstance(PORT);
    process.exit(2);
  },
);
