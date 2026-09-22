// token-safety-lab: the Token Safety limit box and its "Resume anyway" bypass, driven in a real browser
// against a THROWAWAY instance (never prod).
//
// Run:  npm run token-safety-lab --prefix server [-- --shots <dir>] [-- --keep]
//       Uncommitted server work: `npx tsc -p tsconfig.json --outDir .token-safety-lab-dist` from server/,
//       then GGO_LAB_ENTRY=.token-safety-lab-dist/index.js (see lab-harness.cjs).
//
// What it proves, in order:
//   1. A real freeze. The instance boots with Token Safety on at 80% and a task parked by the safety
//      limit, which is exactly the state a restart restores from. Seeded Claude usage sits at 90%, so the
//      boot's own usage refresh keeps the freeze engaged rather than clearing it.
//   2. The box renders from the server's durable state (not a transient notice), with the button and
//      the risk note, in Classic AND Nocturne, and paints no light background under either theme.
//   3. The click does real work: the parked task leaves the safety park and re-enters the pipeline
//      (a new agent run row, or a state change out of `review`), and the bypass is persisted.
//   4. The confirmation survives a reload, and dismissing it hides it.
//   5. The freeze can engage again: a restart whose usage reading is BELOW the limit ends the bypass, and
//      the next restart ABOVE it trips the freeze and shows the box again.
//
// Safety: bogus Claude tokens (lab-harness), and every other backend plus planner/researcher/QA is
// switched off in the lab's own kv, so the resumed task can only reach a Claude spawn that fails auth.
// Its workspace is a temp dir inside the lab's DATA_DIR.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Database = require("better-sqlite3");
const {
  loadChromium,
  authPassword,
  requireBuild,
  requireFreshWebBuild,
  boot,
  killInstance,
  createChecks,
  shotDir,
} = require("./lab-harness.cjs");

const PORT = 4337;
const BASE = `http://127.0.0.1:${PORT}`;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
// Byte-identical to threadManager.ts TOKEN_SAFETY_PARK_PREFIX (the separator is an em dash).
const DASH = String.fromCodePoint(0x2014);
const SAFETY_PREFIX = `⏳ Auto-resume pending ${DASH} token safety limit`;
const ACCOUNT_ENV = { ACCOUNT_1_ID: "acct1", ACCOUNT_1_LABEL: "personal", ACCOUNT_2_ID: "acct2", ACCOUNT_2_LABEL: "secondary" };
const check = createChecks();

function withDb(dataDir, fn, readonly = false) {
  const db = new Database(path.join(dataDir, "orchestrator.sqlite"), { readonly });
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

function putKv(db, key, value) {
  db.prepare("INSERT INTO kv(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(key, value);
}

/** Both subscriptions at `pct` on the 5h window, read just now, so the freeze check sees a real reading. */
function seedUsage(db, pct) {
  const at = Date.now();
  for (const id of ["acct1", "acct2"]) {
    putKv(
      db,
      `account_usage_${id}`,
      JSON.stringify({ fiveHour: pct, sevenDay: 40, fiveHourReset: at + 2 * HOUR, sevenDayReset: at + 4 * DAY, usageAt: at, holdUntil: null, extWakeAt: null }),
    );
  }
}

/** Token Safety on at 80%, nothing but a (bogus-token) Claude to run on, and one task the safety limit
 *  parked mid-implementor with its kickoff persisted, so a resume goes straight to the implementor. */
function seed(db, workspace) {
  for (const [key, value] of Object.entries({
    setting_token_limit_enabled: "1",
    setting_token_limit_percent: "80",
    setting_codex_enabled: "0",
    setting_grok_enabled: "0",
    setting_zai_enabled: "0",
    setting_planner_enabled: "0",
    setting_researcher_enabled: "0",
    setting_qa_enabled: "0",
    setting_auto_model_selection: "0",
  })) {
    putKv(db, key, value);
  }
  seedUsage(db, 90);
  const at = Date.now() - 60_000;
  const id = "7a5e0000-0000-4000-8000-00000000c0de";
  db.prepare(
    `INSERT INTO threads (id, title, workspace, state, raw_prompt, brief, error, stage_outputs, created_at, updated_at)
     VALUES (?, ?, ?, 'review', ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    "Lab: task parked by Token Safety",
    workspace,
    "lab prompt",
    "lab brief",
    `${SAFETY_PREFIX} (implementor stage) ${DASH} usage reached 90% (limit 80%). The saved work resumes automatically when the blocking window resets.`,
    JSON.stringify({ kickoff: "lab kickoff", planDone: true, approved: true }),
    at,
    at,
  );
  return id;
}

/** Rendered colours of the box, resolved through a 1px canvas so any syntax the browser returns
 *  (oklch, color-mix, rgb) compares the same way. */
async function paint(page, selector) {
  return page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) return null;
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 1;
    const ctx = canvas.getContext("2d");
    const rgb = (color) => {
      ctx.clearRect(0, 0, 1, 1);
      ctx.fillStyle = "#000";
      ctx.fillStyle = color;
      ctx.fillRect(0, 0, 1, 1);
      const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data;
      return { r, g, b, a: a / 255 };
    };
    const lum = ({ r, g, b }) => {
      const f = (c) => {
        const v = c / 255;
        return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
      };
      return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
    };
    const contrast = (a, b) => (Math.max(lum(a), lum(b)) + 0.05) / (Math.min(lum(a), lum(b)) + 0.05);
    const bg = rgb(getComputedStyle(el).backgroundColor);
    const title = rgb(getComputedStyle(el.querySelector(".notice-title")).color);
    const risk = el.querySelector(".token-safety-risk");
    const button = el.querySelector(".btn");
    return {
      theme: document.documentElement.getAttribute("data-theme") ?? "classic",
      bgLum: +lum(bg).toFixed(3),
      bgAlpha: bg.a,
      titleContrast: +contrast(title, bg).toFixed(2),
      riskContrast: risk ? +contrast(rgb(getComputedStyle(risk).color), bg).toFixed(2) : null,
      buttonContrast: button ? +contrast(rgb(getComputedStyle(button).color), bg).toFixed(2) : null,
    };
  }, selector);
}

async function openConsole(browser, name) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  await page.request.post(`${BASE}/api/login`, { data: { password: authPassword() } });
  await page.goto(`${BASE}/?lab=${name}`);
  await page.waitForSelector(".accounts .acct", { timeout: 30_000 });
  return { context, page };
}

async function setTheme(page, theme) {
  await page.evaluate((t) => {
    if (t) document.documentElement.setAttribute("data-theme", t);
    else document.documentElement.removeAttribute("data-theme");
  }, theme);
  await page.waitForTimeout(500); // computed colours report the animated value until any fade settles
}

async function visible(page, selector, timeout = 15_000) {
  try {
    await page.waitForSelector(selector, { state: "visible", timeout });
    return true;
  } catch {
    return false;
  }
}

async function waitFor(probe, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await probe();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return null;
}

const bypassKv = (db) => db.prepare("SELECT value FROM kv WHERE key = 'token_safety_bypass'").get()?.value ?? null;

async function main() {
  requireBuild();
  requireFreshWebBuild();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "token-safety-lab-"));
  const shots = shotDir(dataDir);
  const workspace = path.join(dataDir, "workspace");
  fs.mkdirSync(workspace, { recursive: true });
  const box = '[data-testid="token-safety-box"]';
  const confirm = '[data-testid="token-safety-bypassed"]';
  console.log(`token-safety-lab on ${BASE} (data ${dataDir})`);
  let browser;
  try {
    // First boot creates the schema; the seeded freeze and usage are read by the second boot.
    await boot({ dataDir, port: PORT, env: ACCOUNT_ENV });
    killInstance(PORT);
    const threadId = withDb(dataDir, (db) => seed(db, workspace));
    await boot({ dataDir, port: PORT, env: ACCOUNT_ENV });
    browser = await loadChromium().launch();

    console.log("\n1-2. the box renders from server state, in both themes");
    let { context, page } = await openConsole(browser, "freeze");
    check("the Token Safety box is on screen", await visible(page, box), `lab log: ${path.join(dataDir, "lab.log")}`);
    const text = await page.locator(box).innerText().catch(() => "");
    check("it names the freeze and counts the held task", /Token safety limit reached/.test(text) && /1 task is paused/.test(text), text);
    check("it offers Resume anyway", await page.locator('[data-testid="token-safety-bypass"]').isEnabled().catch(() => false));
    check("the risk note sits next to the button", /hard cap/.test(text) && /re-arms once usage drops below 80%/.test(text), text);
    for (const theme of [null, "nocturne"]) {
      await setTheme(page, theme);
      const p = await paint(page, box);
      const name = theme ?? "classic";
      await page.screenshot({ path: path.join(shots, `freeze-${name}.png`), clip: { x: 300, y: 40, width: 840, height: 340 } });
      console.log(`    ${name}: ${JSON.stringify(p)}`);
      check(`${name}: the box paints a dark surface, not a light one`, p && p.bgLum < 0.2 && p.bgAlpha > 0.9, JSON.stringify(p));
      check(`${name}: title, risk note and button text stay readable`, p && p.titleContrast >= 7 && p.riskContrast >= 4.5 && p.buttonContrast >= 4.5, JSON.stringify(p));
    }
    await setTheme(page, null);

    console.log("\n3. the click resumes the parked task for real");
    const runsBefore = withDb(dataDir, (db) => db.prepare("SELECT COUNT(*) AS n FROM agent_runs WHERE thread_id = ?").get(threadId).n, true);
    await page.click('[data-testid="token-safety-bypass"]');
    check("the box turns into the bypass confirmation", await visible(page, confirm));
    check("the freeze box is gone", !(await page.locator(box).isVisible().catch(() => false)));
    const outcome = await waitFor(
      () =>
        withDb(
          dataDir,
          (db) => {
            const row = {
              thread: db.prepare("SELECT state, error FROM threads WHERE id = ?").get(threadId),
              runs: db.prepare("SELECT COUNT(*) AS n FROM agent_runs WHERE thread_id = ?").get(threadId).n,
              bypass: bypassKv(db),
            };
            return row.runs > runsBefore || row.thread.state !== "review" ? row : null;
          },
          true,
        ),
      30_000,
    );
    check("the parked task re-entered the pipeline (a new run or a new state)", !!outcome, JSON.stringify(outcome));
    check("its token-safety park marker is gone", !!outcome && !String(outcome.thread.error ?? "").startsWith(SAFETY_PREFIX), JSON.stringify(outcome?.thread));
    check("the bypass is persisted", !!outcome?.bypass);
    const confirmText = await page.locator(confirm).innerText().catch(() => "");
    check("the confirmation says what it resumed and when safety re-arms", /Resumed 1 held task/.test(confirmText) && /below 80%/.test(confirmText), confirmText);
    await page.waitForTimeout(400); // the banner fades in over 0.18s; a mid-fade frame shows the board through it
    await page.screenshot({ path: path.join(shots, "bypassed.png"), clip: { x: 300, y: 40, width: 840, height: 240 } });

    console.log("\n4. durable across a reload, and dismissible");
    await page.reload();
    await page.waitForSelector(".accounts .acct", { timeout: 30_000 });
    check("the confirmation survives a reload", await visible(page, confirm, 10_000));
    check("and the freeze did not come back", !(await page.locator(box).isVisible().catch(() => false)));
    await page.click(`${confirm} .notice-x`);
    check("dismissing hides it", !(await page.locator(confirm).isVisible().catch(() => false)));
    await context.close();

    console.log("\n5. a below-limit reading ends the bypass; the next crossing freezes again");
    killInstance(PORT);
    withDb(dataDir, (db) => seedUsage(db, 40));
    await boot({ dataDir, port: PORT, env: ACCOUNT_ENV });
    const ended = await waitFor(() => withDb(dataDir, (db) => (bypassKv(db) ? null : true), true), 30_000);
    check("a real below-limit reading ended the bypass", !!ended);
    killInstance(PORT);
    withDb(dataDir, (db) => seedUsage(db, 92));
    await boot({ dataDir, port: PORT, env: ACCOUNT_ENV });
    ({ context, page } = await openConsole(browser, "refreeze"));
    check("the next crossing shows the freeze box again", await visible(page, box, 30_000));
    const refrozen = await page.locator(box).innerText().catch(() => "");
    check("it reports the new reading", /Token safety limit reached/.test(refrozen) && /92%/.test(refrozen), refrozen);
    await page.screenshot({ path: path.join(shots, "refrozen.png"), clip: { x: 300, y: 40, width: 840, height: 340 } });
    await context.close();
  } finally {
    if (browser) await browser.close();
    killInstance(PORT);
    if (process.argv.includes("--keep")) console.log(`  kept ${dataDir}`);
    else fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 3 });
  }
  if (shots !== dataDir) console.log(`\n  screenshots: ${shots}`);
  return check.summary();
}

main().then(
  (code) => process.exit(code),
  (e) => {
    console.error(e);
    killInstance(PORT);
    process.exit(1);
  },
);
