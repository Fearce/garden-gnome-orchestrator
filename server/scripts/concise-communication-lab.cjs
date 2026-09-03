// Verify the Concise agent communication setting in an authenticated real browser without touching
// production. The lab owns an alternate port and a temp DATA_DIR, so its toggle clicks and process
// restart cannot change the live installation's settings or wake a real account.
//
//   npm run concise-lab --prefix server
//   npm run concise-lab --prefix server -- --keep
//
// This is intentionally separate from test:concise-communication. That focused gate proves prompt
// coverage and safety invariants; this lab proves the owner-facing control, WebSocket round-trip,
// persisted restart behavior, and phone layout that a typecheck cannot exercise.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Database = require("better-sqlite3");
const {
  SERVER_ROOT,
  loadChromium,
  authPassword,
  requireBuild,
  boot,
  killInstance,
  createChecks,
} = require("./lab-harness.cjs");

// Sibling labs use 4327-4397 plus each base port's +2 HTTPS listener. Keep both 4477 and 4479 clear.
const PORT = 4477;
const BASE = `http://127.0.0.1:${PORT}`;
const NAV_TIMEOUT = 45_000;
const KV_KEY = "setting_concise_agent_communication";
const SETTINGS = '[role="dialog"][aria-label="Settings"]';
const GROUP = '.settings-group:has(.settings-group-label:text-is("Agent communication"))';
const TOGGLE = 'button.switch[aria-label="Keep agent messages concise"]';

const check = createChecks();

/** Refuse to measure an older bundle after a web source edit. */
function requireFreshWebBuild() {
  const webRoot = path.resolve(SERVER_ROOT, "..", "web");
  const built = fs.statSync(path.join(webRoot, "dist", "index.html")).mtimeMs;
  let newestSource = 0;

  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const target = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(target);
      else newestSource = Math.max(newestSource, fs.statSync(target).mtimeMs);
    }
  };
  walk(path.join(webRoot, "src"));

  if (newestSource > built) {
    throw new Error("web/dist is older than web/src; run `npm run build --prefix web` before this lab");
  }
}

function readPersisted(dataDir) {
  const file = path.join(dataDir, "orchestrator.sqlite");
  try {
    const db = new Database(file, { readonly: true });
    const row = db.prepare("SELECT value FROM kv WHERE key = ?").get(KV_KEY);
    db.close();
    return row?.value ?? null;
  } catch {
    return null;
  }
}

/** The switch updates optimistically. Wait for SQLite, the server-owned state, before trusting it. */
async function waitForPersisted(dataDir, expected, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  let actual = null;
  while (Date.now() < deadline) {
    actual = readPersisted(dataDir);
    if (actual === expected) return actual;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return actual;
}

async function authenticate(page) {
  const response = await page.request.post(`${BASE}/api/login`, {
    data: { password: authPassword() },
  });
  if (!response.ok()) throw new Error(`login failed with HTTP ${response.status()}`);
}

async function openSettings(page, { login = false, reload = false } = {}) {
  if (login) await authenticate(page);
  if (reload) await page.reload({ timeout: NAV_TIMEOUT });
  else await page.goto(`${BASE}/`, { timeout: NAV_TIMEOUT });

  // Settings are server-authoritative. The account chip only appears after the WebSocket hello frame.
  await page.waitForSelector(".accounts .acct", { timeout: 25_000 });
  await page.click('[aria-label="Open settings"]');
  await page.waitForSelector(SETTINGS, { timeout: 20_000 });
}

async function toggleState(page) {
  return page.getAttribute(TOGGLE, "aria-checked");
}

/** Inspect actual boxes. document.scrollWidth alone can miss a clipped child inside the panel. */
function inspectMobileLayout() {
  const dialog = document.querySelector('[role="dialog"][aria-label="Settings"]');
  const group = [...document.querySelectorAll(".settings-group")].find(
    (node) => node.querySelector(".settings-group-label")?.textContent?.trim() === "Agent communication",
  );
  if (!dialog || !group) return null;

  const box = (node) => {
    const rect = node.getBoundingClientRect();
    return {
      left: Math.round(rect.left),
      top: Math.round(rect.top),
      right: Math.round(rect.right),
      bottom: Math.round(rect.bottom),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
    };
  };
  const overflow = [];
  for (const node of dialog.querySelectorAll("*")) {
    const style = getComputedStyle(node);
    const rect = node.getBoundingClientRect();
    if (style.display === "none" || style.visibility === "hidden" || rect.width === 0 || rect.height === 0) continue;
    if (rect.left < -1 || rect.right > innerWidth + 1) {
      overflow.push(`${node.tagName.toLowerCase()}.${String(node.className).trim()}: ${Math.round(rect.left)}..${Math.round(rect.right)}`);
    }
  }

  return {
    viewport: { width: innerWidth, height: innerHeight },
    dialog: box(dialog),
    group: box(group),
    documentWidth: document.documentElement.scrollWidth,
    overflow: overflow.slice(0, 10),
  };
}

async function rmWithRetry(dir) {
  for (let attempt = 0; attempt < 20; attempt++) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      return;
    } catch (error) {
      if (attempt === 19) {
        console.log(`  temp dir left behind (${error.code ?? "unknown error"}): ${dir}`);
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
}

async function verifyDesktop(browser, dataDir) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  try {
    const page = await context.newPage();
    await openSettings(page, { login: true });

    const categories = await page.locator(".settings-nav-item").allInnerTexts();
    check("the desktop rail organizes settings into eight categories", categories.length === 8, categories.join(" | "));
    check("General is the focused default category", (await page.locator('.settings-nav-item[aria-current="page"]').innerText()) === "General");
    check("only one settings page is visible at a time", (await page.locator(".settings-category-panel:visible").count()) === 1);
    await page.click('[data-settings-category="pipeline"]');
    check("a rail category opens its matching page", (await page.locator("#settings-page-title").innerText()) === "Pipeline");

    const desktopSearch = page.locator('.settings-search-desktop input[aria-label="Search settings"]');
    check("the desktop settings rail exposes keyword search", await desktopSearch.isVisible());
    await page.keyboard.press("Control+f");
    check("Ctrl+F focuses settings search instead of browser find", await desktopSearch.evaluate((input) => document.activeElement === input));
    await desktopSearch.fill("discord");
    check("search replaces the category page with matching results", (await page.locator("#settings-page-title").innerText()) === "Search results");
    const discordResult = page.locator(".settings-search-result").filter({ hasText: "Post to Discord" });
    check("setting-name keywords find the exact setting", (await discordResult.count()) === 1, await page.locator(".settings-search-results").innerText());
    await desktopSearch.fill("right-click");
    check("help-text keywords find the exact setting", (await page.locator(".settings-search-result").filter({ hasText: "Channel ID" }).count()) === 1, await page.locator(".settings-search-results").innerText());
    await desktopSearch.fill("discord");
    await discordResult.click();
    check("a result opens the setting's category", (await page.locator("#settings-page-title").innerText()) === "Voice & alerts");
    const discordToggle = page.locator('[role="switch"][aria-label="Post to Discord"]');
    check("a result focuses its exact control", await discordToggle.evaluate((control) => document.activeElement === control));
    check("a result briefly highlights its exact row", await page.locator('.settings-row.settings-search-target:has([aria-label="Post to Discord"])').isVisible());
    await desktopSearch.fill("definitely-not-a-setting");
    check("an unmatched keyword gets a clear empty state", await page.locator(".settings-search-empty").isVisible());
    await desktopSearch.press("Escape");
    check("Escape clears an active search without closing Settings", await page.locator(SETTINGS).isVisible() && (await desktopSearch.inputValue()) === "");
    await page.click('[data-settings-category="general"]');

    // The dialog opens focus into search on purpose, but that must happen ONCE per open. `App` re-renders
    // whenever a top-bar scalar moves (a run starting, a task arriving), and while the opening-focus effect
    // was keyed on the `onClose` arrow it re-ran on each of those and dragged focus out of whatever the
    // owner was editing — so their next keystrokes silently went into the search box.
    const nameInput = page.locator('.settings-row:has-text("Director name") input').first();
    await nameInput.click();
    await nameInput.fill("Gizm");
    await page.evaluate(() => document.querySelector('[aria-label="Toggle director chat panel"]').click());
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const focusedLabel = await page.evaluate(() => document.activeElement?.getAttribute("aria-label") || "");
    check("an unrelated re-render does not drag focus into settings search", focusedLabel !== "Search settings", focusedLabel);
    await page.keyboard.type("o");
    check("keystrokes after a re-render still reach the edited setting", (await nameInput.inputValue()) === "Gizmo", await nameInput.inputValue());
    await nameInput.fill("");
    await page.evaluate(() => document.querySelector('[aria-label="Toggle director chat panel"]').click());

    check("the Agent communication group renders", (await page.locator(GROUP).count()) === 1);
    check("a fresh installation defaults concise communication ON", (await toggleState(page)) === "true", await toggleState(page));

    const copy = (await page.locator(GROUP).innerText()).replace(/\s+/g, " ");
    const scope = [
      "Director chat",
      "findings",
      "handoffs",
      "QA/review/supervisor messages",
      "office chat",
      "task-status explanations",
    ];
    check("the copy names every owner-facing role and bridge family", scope.every((part) => copy.includes(part)), copy);
    const safeguards = ["Wording only", "implement", "investigate", "test", "blockers", "errors", "exact commands/IDs", "safety caveats", "evidence"];
    check("the copy preserves diligence and decision evidence", safeguards.every((part) => copy.includes(part)), copy);

    await page.click(TOGGLE);
    const storedOff = await waitForPersisted(dataDir, "0");
    check("turning it OFF reaches the server and persists", storedOff === "0", String(storedOff));

    await openSettings(page, { reload: true });
    check("OFF survives a browser reload", (await toggleState(page)) === "false", await toggleState(page));
  } finally {
    await context.close();
  }
}

async function verifyRestart(browser) {
  const context = await browser.newContext({ viewport: { width: 1200, height: 800 } });
  try {
    const page = await context.newPage();
    await openSettings(page, { login: true });
    check("OFF survives a real throwaway-server restart", (await toggleState(page)) === "false", await toggleState(page));
  } finally {
    await context.close();
  }
}

async function verifyMobile(browser, dataDir) {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    isMobile: true,
    deviceScaleFactor: 3,
  });
  try {
    const page = await context.newPage();
    await openSettings(page, { login: true });

    const media = await page.evaluate(() => ({
      coarse: matchMedia("(pointer: coarse)").matches,
      hoverNone: matchMedia("(hover: none)").matches,
    }));
    check("the phone pass really uses touch media", media.coarse && media.hoverNone, JSON.stringify(media));
    check("the category rail collapses on a phone", !(await page.locator(".settings-sidebar").isVisible()));
    check("the phone exposes the compact category picker", await page.locator('.settings-mobile-nav select[aria-label="Settings category"]').isVisible());
    const mobileSearch = page.locator('.settings-search-mobile input[aria-label="Search settings"]');
    check("the phone keeps settings search visible", await mobileSearch.isVisible());
    await mobileSearch.fill("drag reorder");
    check("phone search is clearly global, not scoped to the old page", (await page.locator('.settings-mobile-nav select[aria-label="Settings category"]').inputValue()) === "");
    const dragResult = page.locator(".settings-search-result").filter({ hasText: "Drag to reorder" });
    check("multi-word search finds a matching phone setting", (await dragResult.count()) === 1, await page.locator(".settings-search-results").innerText());
    await dragResult.tap();
    check("a phone search result opens its matching page", (await page.locator("#settings-page-title").innerText()) === "Interface");
    await page.selectOption('.settings-mobile-nav select[aria-label="Settings category"]', "interface");
    check("the phone picker opens its matching page", (await page.locator("#settings-page-title").innerText()) === "Interface");
    await page.selectOption('.settings-mobile-nav select[aria-label="Settings category"]', "general");
    check("the phone receives the persisted OFF state", (await toggleState(page)) === "false", await toggleState(page));

    const layout = await page.evaluate(inspectMobileLayout);
    const dialogInside = !!layout
      && layout.dialog.left >= 0
      && layout.dialog.top >= 0
      && layout.dialog.right <= layout.viewport.width
      && layout.dialog.bottom <= layout.viewport.height;
    check("the Settings sheet stays inside the phone viewport", dialogInside, JSON.stringify(layout));
    const groupInside = !!layout
      && layout.group.left >= layout.dialog.left
      && layout.group.right <= layout.dialog.right;
    check("the communication control and copy stay inside the sheet", groupInside && layout.overflow.length === 0, JSON.stringify(layout));
    check("the page has no hidden horizontal spill", !!layout && layout.documentWidth <= layout.viewport.width + 1, JSON.stringify(layout));

    await page.tap(TOGGLE);
    const storedOn = await waitForPersisted(dataDir, "1");
    check("turning it ON from a phone reaches the server and persists", storedOn === "1", String(storedOn));

    await openSettings(page, { reload: true });
    check("ON survives a phone reload", (await toggleState(page)) === "true", await toggleState(page));
  } finally {
    await context.close();
  }
}

async function main() {
  const keep = process.argv.includes("--keep");
  requireBuild();
  requireFreshWebBuild();
  killInstance(PORT);

  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "concise-communication-lab-"));
  let browser;
  let succeeded = false;
  try {
    await boot({ dataDir, port: PORT });
    browser = await loadChromium().launch();

    await verifyDesktop(browser, dataDir);

    // Reuse the same DATA_DIR across a real process death. This is the restart guarantee the setting makes.
    killInstance(PORT);
    await boot({ dataDir, port: PORT });
    await verifyRestart(browser);

    await verifyMobile(browser, dataDir);
    const code = check.summary();
    succeeded = code === 0;
    return code;
  } finally {
    if (browser) await browser.close().catch(() => {});
    if (!keep || !succeeded) {
      killInstance(PORT);
      await rmWithRetry(dataDir);
    } else {
      console.log(`  instance kept at ${BASE} (data: ${dataDir})`);
    }
  }
}

main().then(
  (code) => process.exit(code),
  (error) => {
    console.error(error);
    killInstance(PORT);
    process.exit(1);
  },
);
