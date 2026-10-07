// Drive the composer's AUTO repo switch and the repo picker in a real browser against a throwaway instance.
//
//   npm run auto-repo-lab --prefix server
//   npm run auto-repo-lab --prefix server -- --shots data/auto-repo-lab-shots
//
// Three passes: desktop (1440px), a narrow window (820px) and a phone (390px, touch context, so the
// `pointer: coarse` rules apply). Each checks that the switch sits inside the right edge of the repo field
// with typed text kept clear of it, that Tab reaches it and Space/Enter flip it, that AUTO disables the
// field, the folder button and the REPOS chips while the switch stays usable, and that the page never
// scrolls sideways. Desktop also proves the setting persists across a reload. The desktop and phone passes
// then send a real request with AUTO on through the Skip-director route: the server asks the repo question,
// the picker lists the recent repos, a search finds a repo that is not among them, the keyboard (desktop)
// or a tap (phone) picks it, and exactly one task is dispatched into that repo. Bogus account tokens and
// kill-by-port come from lab-harness; the dispatched tasks fail to start, which this lab does not inspect.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Database = require("better-sqlite3");
const { loadChromium, authPassword, requireBuild, requireFreshWebBuild, boot, waitForPersisted, waitForSettingsReloadSafe, killInstance, createChecks, shotDir } = require("./lab-harness.cjs");

const PORT = 4583;
const BASE = `http://127.0.0.1:${PORT}`;
const NAV_TIMEOUT = 45_000;

function makeRepos(dataDir) {
  const at = (name) => {
    const p = path.join(dataDir, "repos", name);
    fs.mkdirSync(path.join(p, ".git"), { recursive: true });
    return p;
  };
  return { orchard: at("orchard"), harbor: at("harbor"), lighthouse: at("lighthouse") };
}

function seed(dataDir, repos) {
  const db = new Database(path.join(dataDir, "orchestrator.sqlite"));
  const setKv = db.prepare("INSERT INTO kv(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value");
  // lighthouse is deliberately NOT recent: the picker's search has to find it on disk.
  setKv.run("setting_recent_repos", JSON.stringify([repos.orchard, repos.harbor]));
  setKv.run("setting_skip_director", "1");
  setKv.run("setting_auto_repo", "0");
  db.close();
}

function tasksIn(dataDir, workspace) {
  const db = new Database(path.join(dataDir, "orchestrator.sqlite"), { readonly: true });
  const rows = db.prepare("SELECT id FROM threads WHERE COALESCE(home_workspace, workspace) = ?").all(workspace);
  db.close();
  return rows.length;
}

async function waitForTasks(dataDir, workspace, n, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (tasksIn(dataDir, workspace) >= n) return true;
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

/** Log in, wait for the socket's hello, and bring the repo field on screen (the Director tab on a narrow
 *  window, then the Send options sheet on a phone). */
async function openComposer(context) {
  const page = await context.newPage();
  await page.request.post(`${BASE}/api/login`, { data: { password: authPassword() } });
  await page.goto(`${BASE}/`, { timeout: NAV_TIMEOUT });
  await page.waitForSelector(".accounts .acct", { state: "attached", timeout: 25_000 });
  await showField(page);
  return page;
}

async function showField(page) {
  const toggle = page.locator(".auto-repo-toggle");
  if (!(await toggle.isVisible())) {
    const tab = page.getByRole("button", { name: /^director$/i }).last();
    if (await tab.isVisible()) await tab.click();
    await page.waitForTimeout(400);
  }
  if (!(await toggle.isVisible())) {
    const sheet = page.locator(".composer-options-toggle");
    if (await sheet.isVisible()) await sheet.click();
  }
  await toggle.waitFor({ state: "visible", timeout: 10_000 });
}

const isOn = async (page) => (await page.locator(".auto-repo-toggle").getAttribute("aria-checked")) === "true";

/** The switch inside the field: geometry, text clearance, both states, keyboard, and the locked controls. */
async function checkField(page, check, tag, shots, dataDir) {
  const toggle = page.locator(".auto-repo-toggle");
  const input = page.locator(".ws-wrap input.ws").first();
  const folder = page.locator('button[aria-label="Browse for a folder"]').first();
  const manual = page.locator(".recent-repos .repo-chip-pick, .recent-repos .repo-add");

  check(`${tag}: AUTO starts off`, !(await isOn(page)));
  check(`${tag}: the switch is a switch`, (await toggle.getAttribute("role")) === "switch" && (await toggle.getAttribute("aria-label")) === "AUTO repository selection");
  check(`${tag}: manual controls usable while AUTO is off`, (await input.isEnabled()) && (await folder.isEnabled()) && (await manual.evaluateAll((els) => els.length > 0 && els.every((e) => !e.disabled))));

  const geo = await page.evaluate(() => {
    const field = document.querySelector(".ws-wrap input.ws");
    const fr = field.getBoundingClientRect();
    const sw = document.querySelector(".auto-repo-toggle");
    const box = sw.getBoundingClientRect();
    const inset = -parseFloat(getComputedStyle(sw, "::before").top || "0");
    const padRight = parseFloat(getComputedStyle(field).paddingRight);
    return { field: { l: fr.left, r: fr.right, t: fr.top, b: fr.bottom }, sw: { l: box.left, r: box.right, t: box.top, b: box.bottom, h: box.height }, inset, padRight, overflow: document.documentElement.scrollWidth > window.innerWidth };
  });
  check(`${tag}: the switch sits inside the field's right edge`, geo.sw.l > (geo.field.l + geo.field.r) / 2 && geo.sw.r <= geo.field.r + 0.5 && geo.sw.t >= geo.field.t - 0.5 && geo.sw.b <= geo.field.b + 0.5, JSON.stringify(geo));
  check(`${tag}: typed text stops before the switch`, geo.field.r - geo.padRight <= geo.sw.l + 0.5, JSON.stringify(geo));
  check(`${tag}: the switch's hit area is at least 24px tall`, geo.sw.h + 2 * geo.inset >= 24, JSON.stringify(geo));
  check(`${tag}: no sideways scroll`, !geo.overflow);
  const clip = await page.evaluate(() => {
    const r = document.querySelector(".ws-wrap").getBoundingClientRect();
    const x = Math.max(r.left - 60, 0);
    return { x, y: Math.max(r.top - 14, 0), width: Math.min(r.width + 120, window.innerWidth - x), height: r.height + 28 };
  });
  await page.screenshot({ path: path.join(shots, `${tag}-1-off.png`) });

  await input.fill("C:/a/very/long/path/that/would/run/under/the/switch/if/the/field/did/not/reserve/room");
  await page.screenshot({ path: path.join(shots, `${tag}-2-long-path.png`), clip });
  await input.fill("");

  await input.focus();
  await page.keyboard.press("Tab");
  check(`${tag}: Tab moves from the field to the switch`, await toggle.evaluate((el) => el === document.activeElement));
  check(`${tag}: keyboard focus shows a ring`, await toggle.evaluate((el) => el.matches(":focus-visible") && getComputedStyle(el).outlineStyle !== "none"));
  await page.screenshot({ path: path.join(shots, `${tag}-3-focus.png`), clip });
  await page.keyboard.press("Space");
  check(`${tag}: Space turns AUTO on`, await isOn(page));
  check(`${tag}: the server stores AUTO on`, (await waitForPersisted(dataDir, "setting_auto_repo", "1")) === "1");
  check(`${tag}: focus stays on the switch`, await toggle.evaluate((el) => el === document.activeElement));

  check(`${tag}: AUTO disables the field`, await input.isDisabled());
  check(`${tag}: AUTO disables the folder button`, await folder.isDisabled());
  check(`${tag}: AUTO disables every REPOS chip and +`, await manual.evaluateAll((els) => els.length > 0 && els.every((e) => e.disabled)));
  check(`${tag}: the switch itself stays usable`, await toggle.isEnabled());
  const states = await page.evaluate(() => {
    const knob = document.querySelector(".auto-repo-knob");
    const label = document.querySelector(".auto-repo-label");
    return { knob: getComputedStyle(knob).transform, label: label.textContent.trim(), visible: label.getBoundingClientRect().width > 0 };
  });
  check(`${tag}: ON is shown by the knob and a text label, not colour alone`, states.knob !== "none" && states.label.toLowerCase() === "auto" && states.visible, JSON.stringify(states));
  check(`${tag}: no sideways scroll with AUTO on`, await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
  await page.screenshot({ path: path.join(shots, `${tag}-4-on.png`) });
  await page.screenshot({ path: path.join(shots, `${tag}-5-on-field.png`), clip });

  await page.keyboard.press("Enter");
  check(`${tag}: Enter turns AUTO off and frees the field`, !(await isOn(page)) && (await input.isEnabled()));
  check(`${tag}: the server stores AUTO off`, (await waitForPersisted(dataDir, "setting_auto_repo", "0")) === "0");
  await page.mouse.move(1, 1);
  await toggle.hover();
  await page.waitForTimeout(200);
  await page.screenshot({ path: path.join(shots, `${tag}-6-off-hover.png`), clip });
}

/** A real AUTO send that the server cannot place: the picker, a search, a pick, one dispatch. */
async function checkPicker(page, check, tag, shots, dataDir, repos, pick) {
  if (!(await isOn(page))) await page.locator(".auto-repo-toggle").click();
  await waitForPersisted(dataDir, "setting_auto_repo", "1");
  const before = tasksIn(dataDir, repos.lighthouse);
  const sheetClose = page.locator(".composer-sheet-head button").first();
  if (await sheetClose.isVisible().catch(() => false)) await sheetClose.click();
  await page.locator(".composer textarea").first().fill(`make the tests faster (${tag})`);
  await page.locator("button.composer-send:visible").first().click();

  const search = page.locator('.repo-question input[role="combobox"]');
  try {
    await search.waitFor({ state: "visible", timeout: 15_000 });
  } catch {
    check(`${tag}: an unclear AUTO send opens the repo picker`, false, "no .repo-question appeared");
    return;
  }
  check(`${tag}: an unclear AUTO send opens the repo picker`, true);
  const rows = () => page.$$eval(".repo-row", (els) => els.map((e) => e.querySelector(".repo-row-name").textContent.trim()));
  const first = await rows();
  check(`${tag}: the picker offers the recent repos by name`, first.includes("orchard") && first.includes("harbor"), JSON.stringify(first));
  check(`${tag}: the search box has focus`, await search.evaluate((el) => el === document.activeElement));
  check(`${tag}: the picker fits the viewport`, await page.locator(".repo-question").evaluate((el) => { const r = el.getBoundingClientRect(); return r.left >= -0.5 && r.right <= window.innerWidth + 0.5; }));
  await page.screenshot({ path: path.join(shots, `${tag}-7-picker.png`) });

  await search.fill("light");
  try {
    await page.waitForFunction(() => [...document.querySelectorAll(".repo-row-name")].some((e) => e.textContent.trim() === "lighthouse"), null, { timeout: 8_000 });
  } catch {
    /* reported below */
  }
  const found = await rows();
  check(`${tag}: search finds a repo that was not suggested`, found[0] === "lighthouse", JSON.stringify(found));
  await page.screenshot({ path: path.join(shots, `${tag}-8-picker-search.png`) });
  if (pick === "keyboard") {
    await search.press("ArrowDown");
    await search.press("ArrowUp");
    check(`${tag}: the arrow keys move the active row`, (await page.locator(".repo-row.active .repo-row-name").innerText()) === "lighthouse");
    await search.press("Enter");
  } else {
    await page.locator(".repo-row", { hasText: "lighthouse" }).first().tap();
  }
  try {
    await page.waitForSelector(".repo-question", { state: "detached", timeout: 10_000 });
    check(`${tag}: picking closes the picker`, true);
  } catch {
    check(`${tag}: picking closes the picker`, false);
  }
  check(`${tag}: the request is dispatched into the picked repo`, await waitForTasks(dataDir, repos.lighthouse, before + 1));
  await page.waitForTimeout(1_500);
  check(`${tag}: and only once`, tasksIn(dataDir, repos.lighthouse) === before + 1, String(tasksIn(dataDir, repos.lighthouse)));
}

async function main() {
  requireBuild();
  requireFreshWebBuild();
  const check = createChecks();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "auto-repo-lab-"));
  const keep = process.argv.includes("--keep");
  const shots = shotDir(dataDir);
  console.log(`auto-repo-lab: ${BASE} (data ${dataDir})`);
  const env = { WORKSPACE_SEARCH_ROOTS: path.join(dataDir, "repos") };

  try {
    const repos = makeRepos(dataDir);
    await boot({ dataDir, port: PORT, env });
    killInstance(PORT);
    seed(dataDir, repos);
    await boot({ dataDir, port: PORT, env });

    const browser = await loadChromium().launch();
    try {
      console.log("desktop 1440x900");
      let context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
      let page = await openComposer(context);
      await checkField(page, check, "desktop", shots, dataDir);
      await page.locator(".auto-repo-toggle").click();
      check("desktop: AUTO on is stored before the reload", (await waitForSettingsReloadSafe(dataDir, "setting_auto_repo", "1")) === "1");
      await page.reload({ timeout: NAV_TIMEOUT });
      await page.waitForSelector(".accounts .acct", { state: "attached", timeout: 25_000 });
      await showField(page);
      check("desktop: AUTO survives a reload", await isOn(page));
      check("desktop: and the field is still locked after it", await page.locator(".ws-wrap input.ws").first().isDisabled());
      await checkPicker(page, check, "desktop", shots, dataDir, repos, "keyboard");
      await page.locator(".auto-repo-toggle").click();
      await waitForPersisted(dataDir, "setting_auto_repo", "0");
      await context.close();

      console.log("narrow 820x1000");
      context = await browser.newContext({ viewport: { width: 820, height: 1000 } });
      page = await openComposer(context);
      await checkField(page, check, "narrow", shots, dataDir);
      await context.close();

      console.log("phone 390x844 (touch)");
      context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 });
      page = await openComposer(context);
      await checkField(page, check, "phone", shots, dataDir);
      await checkPicker(page, check, "phone", shots, dataDir, repos, "tap");
      await context.close();
      console.log(`  screenshots: ${shots}`);
    } finally {
      await browser.close();
    }
    return check.summary();
  } finally {
    killInstance(PORT);
    if (!keep) fs.rmSync(dataDir, { recursive: true, force: true });
    else console.log(`kept ${dataDir}`);
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
