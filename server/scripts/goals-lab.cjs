// Lab for a goal's owner-chosen effort, model, parallel steps, burn-rate guard, session policy and token
// budget (`npm run goals-lab`). What `test:goals` cannot see: whether the create/edit dialog really offers
// the controls, whether "Auto (low or medium)", one step at a time in one session, no budget and the guard
// on at 100% are the defaults a new goal gets, whether the choices survive the socket into the goals table,
// whether an edit can change them back, and whether the owner's Resume of a goal the loop stopped starts a
// fresh audit — read from the instance's own DB, not the optimistic UI.
// Boots its own throwaway instance with bogus account tokens, so the director never answers and no step
// is ever dispatched. Not in GATES: it needs a browser + an instance, like the other labs.
//
// To test uncommitted work without touching the live dist, build isolated copies first:
//   from server/: npx tsc -p tsconfig.json --outDir .goals-lab-dist
//   from web/:    npx vite build --outDir ../server/.lab-web-dist-goals --emptyOutDir
// then run with GGO_LAB_ENTRY=.goals-lab-dist/index.js GGO_LAB_WEB_DIST=.lab-web-dist-goals.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { loadChromium, authPassword, requireBuild, boot, killInstance, createChecks, shotDir } = require("./lab-harness.cjs");

const PORT = 4417;
const check = createChecks();

function openDb(dataDir, readonly = true) {
  const Database = require(path.join(__dirname, "..", "node_modules", "better-sqlite3"));
  return new Database(path.join(dataDir, "orchestrator.sqlite"), { readonly });
}

function goalRow(dataDir, title) {
  const db = openDb(dataDir);
  try {
    return (
      db
        .prepare("SELECT effort, provider, model, max_concurrent, burn_conservation, burn_rate_pct, persistent_session, token_budget, status, replan_at, blocked_streak FROM goals WHERE title = ?")
        .get(title) ?? null
    );
  } finally {
    db.close();
  }
}

/** What only the loop can do: stop a goal as blocked, the same-impasse streak spent. */
function stopAsBlocked(dataDir, title) {
  const db = openDb(dataDir, false);
  try {
    db.prepare("UPDATE goals SET status = 'blocked', status_reason = ?, blocked_streak = 3, replan_at = NULL WHERE title = ?").run(
      "The same blocker three turns running: the deploy key is missing.",
      title,
    );
  } finally {
    db.close();
  }
}

async function waitForRow(dataDir, title, predicate) {
  for (let i = 0; i < 60; i++) {
    const row = goalRow(dataDir, title);
    if (row && predicate(row)) return row;
    await new Promise((r) => setTimeout(r, 250));
  }
  return goalRow(dataDir, title);
}

async function openGoals(page) {
  await page.click('.board-tab:has-text("Goals")');
  await page.waitForSelector(".goal-view", { timeout: 15000 });
}

/** The editor's three pickers, as the owner sees them. */
async function pickers(page) {
  return page.evaluate(() => {
    const selects = [...document.querySelectorAll(".goal-modal select")];
    const byLabel = (label) =>
      selects.find((s) => s.closest("label")?.querySelector(".sched-label")?.textContent?.trim() === label);
    const read = (s) => (s ? { value: s.value, text: s.selectedOptions[0]?.textContent ?? "", disabled: s.disabled, options: [...s.options].map((o) => o.value) } : null);
    return { effort: read(byLabel("Effort")), provider: read(byLabel("Provider")), model: read(byLabel("Model")) };
  });
}

/** The editor's parallel-steps and burn-rate controls. */
async function paceControls(page) {
  return page.evaluate(() => ({
    parallel: document.querySelector(".goal-modal .goal-concurrency")?.value ?? null,
    guard: document.querySelector(".goal-modal .goal-burn-toggle input")?.checked ?? null,
    rate: document.querySelector(".goal-modal .goal-burn-rate")?.value ?? null,
    rateDisabled: document.querySelector(".goal-modal .goal-burn-rate")?.disabled ?? null,
    session: document.querySelector(".goal-modal .goal-session-toggle input")?.checked ?? null,
    sessionDisabled: document.querySelector(".goal-modal .goal-session-toggle input")?.disabled ?? null,
    budget: document.querySelector(".goal-modal .goal-token-budget")?.value ?? null,
    canSave: !document.querySelector(".goal-modal .m-foot .btn.primary")?.disabled,
  }));
}

const select = (page, label, value) => page.selectOption(`.goal-modal label:has(.sched-label:text-is("${label}")) select`, value);

async function fillNewGoal(page, title, workspace) {
  await page.click('.goal-view .btn.primary:has-text("New goal")');
  await page.waitForSelector(".goal-modal", { timeout: 10000 });
  await page.fill(".goal-modal input[placeholder^='e.g.']", title);
  await page.fill(".goal-modal .ws-wrap input", workspace);
  await page.fill(".goal-modal textarea", `Objective for ${title}.`);
}

async function saveAndClose(page) {
  await page.click('.goal-modal .btn.primary');
  await page.waitForSelector(".goal-modal", { state: "detached", timeout: 10000 });
}

const card = (page, title) => page.locator(".goal-card", { has: page.locator(`.sched-title:text-is("${title}")`) });

(async () => {
  requireBuild();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "goals-lab-"));
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "goals-lab-ws-"));
  killInstance(PORT);
  const child = await boot({ dataDir, port: PORT });
  let code = 1;
  try {
    const chromium = loadChromium();
    const browser = await chromium.launch();
    const page = await (await browser.newContext({ viewport: { width: 1500, height: 950 } })).newPage();
    const errors = [];
    page.on("console", (m) => {
      if (m.type() === "error") errors.push(m.text());
    });
    await page.request.post(`http://127.0.0.1:${PORT}/api/login`, { data: { password: authPassword() } });
    await page.goto(`http://127.0.0.1:${PORT}/`, { timeout: 45000 });
    await page.waitForSelector(".accounts .acct", { state: "attached", timeout: 30000 });
    await openGoals(page);

    // ---- a new goal defaults to the director's model at low-or-medium effort ----
    await fillNewGoal(page, "Default goal", workspace);
    let p = await pickers(page);
    check("the dialog offers an effort picker", !!p.effort, JSON.stringify(p));
    check("...defaulting to Auto (low or medium)", p.effort?.value === "" && /low or medium/.test(p.effort.text), JSON.stringify(p.effort));
    check("...with every owner effort on offer", ["low", "medium", "high", "max"].every((e) => p.effort?.options.includes(e)), JSON.stringify(p.effort?.options));
    check("the dialog offers a provider picker defaulting to the director", p.provider?.value === "" && /Director picks/.test(p.provider.text), JSON.stringify(p.provider));
    check("the model picker waits for a provider", p.model?.disabled === true, JSON.stringify(p.model));
    let pace = await paceControls(page);
    check("the dialog defaults to one step at a time with the burn guard on at 100%", pace.parallel === "1" && pace.guard === true && pace.rate === "100" && pace.rateDisabled === false, JSON.stringify(pace));
    check("...in one session with no token budget", pace.session === true && pace.sessionDisabled === false && pace.budget === "", JSON.stringify(pace));
    check("the dialog has no step budget", !/step budget|max(imum)? steps/i.test(await page.locator(".goal-modal").textContent()));
    await saveAndClose(page);
    let row = await waitForRow(dataDir, "Default goal", () => true);
    check("an untouched dialog stores no pin (director picks, low or medium)", row && row.effort === null && row.provider === null && row.model === null, JSON.stringify(row));
    check("...and the pace defaults", row && row.max_concurrent === 1 && row.burn_conservation === 1 && row.burn_rate_pct === 100, JSON.stringify(row));
    check("...one persistent session and no budget", row && row.persistent_session === 1 && row.token_budget === null, JSON.stringify(row));
    await card(page, "Default goal").waitFor({ timeout: 10000 });
    check("the card says the effort is low–medium", (await card(page, "Default goal").locator(".goal-effort-auto").textContent())?.trim() === "low–medium");
    check("the card counts steps without a budget", /\b0 steps\b/.test(await card(page, "Default goal").locator(".goal-steps-count").textContent()));
    check("the card shows one at a time and the guard",/1 at a time/.test(await card(page, "Default goal").locator(".sched-meta").textContent()) && (await card(page, "Default goal").locator(".goal-burn:not(.off)").textContent())?.trim() === "burn ≤ 100%");
    check("the card says it continues in one session", /one session/.test(await card(page, "Default goal").locator(".sched-meta").textContent()));
    check("a goal with no runs and no budget shows no usage line", (await card(page, "Default goal").locator(".goal-usage").count()) === 0);

    // ---- a token budget, written the short way, and a fresh task per step ----
    await fillNewGoal(page, "Budgeted goal", workspace);
    await page.fill(".goal-modal .goal-token-budget", "12.5x");
    pace = await paceControls(page);
    check("an unreadable budget blocks saving and says how to write one", !pace.canSave && /optionally with k or M/.test(await page.locator(".goal-modal").textContent()), JSON.stringify(pace));
    await page.fill(".goal-modal .goal-token-budget", "20M");
    await page.click(".goal-modal .goal-session-toggle input");
    pace = await paceControls(page);
    check("a valid budget can be saved", pace.canSave && pace.session === false, JSON.stringify(pace));
    check("the hint says what the budget counts and what it does not", /director judgements are not counted/.test(await page.locator(".goal-modal").textContent()));
    const providers = (await pickers(page)).provider?.options ?? [];
    if (providers.includes("grok")) {
      await select(page, "Provider", "grok");
      pace = await paceControls(page);
      check("a budget cannot be pinned to Grok, which reports no usage", !pace.canSave && /Grok reports no token usage/.test(await page.locator(".goal-modal").textContent()), JSON.stringify(pace));
      await select(page, "Provider", "");
    } else {
      console.log(`  - skipped the Grok-pin budget rule: this instance offers no Grok target (${providers.join(", ")}); test:goals covers it server-side`);
    }
    await saveAndClose(page);
    row = await waitForRow(dataDir, "Budgeted goal", () => true);
    check("the budget and the session policy reach the goals table", row && row.token_budget === 20_000_000 && row.persistent_session === 0, JSON.stringify(row));
    const budgetCard = card(page, "Budgeted goal");
    await budgetCard.waitFor({ timeout: 10000 });
    check("the card shows the step-task usage against the budget", (await budgetCard.locator(".goal-usage-total").textContent())?.trim() === "0 of 20M tokens" && /Step-task runs/.test(await budgetCard.locator(".goal-usage").textContent()));
    check("...with its meter", (await budgetCard.locator(".goal-usage-meter").count()) === 1);
    check("the card says each step is a fresh task", /fresh task per step/.test(await budgetCard.locator(".sched-meta").textContent()));
    await budgetCard.locator('.btn:has-text("Edit")').click();
    await page.waitForSelector(".goal-modal", { timeout: 10000 });
    pace = await paceControls(page);
    check("edit opens with the saved budget in its short form", pace.budget === "20M" && pace.session === false, JSON.stringify(pace));
    await page.fill(".goal-modal .goal-token-budget", "");
    await saveAndClose(page);
    row = await waitForRow(dataDir, "Budgeted goal", (r) => r.token_budget === null);
    check("clearing the field removes the budget", row && row.token_budget === null, JSON.stringify(row));

    // ---- several agents at once, guard off ----
    await fillNewGoal(page, "Parallel goal", workspace);
    await page.fill(".goal-modal .goal-concurrency", "3");
    await page.click(".goal-modal .goal-burn-toggle input");
    pace = await paceControls(page);
    check("switching the guard off locks the rate", pace.guard === false && pace.rateDisabled === true, JSON.stringify(pace));
    check("parallel steps lock the one-session toggle", pace.sessionDisabled === true && pace.session === false, JSON.stringify(pace));
    await saveAndClose(page);
    row = await waitForRow(dataDir, "Parallel goal", () => true);
    check("parallel steps and the guard reach the goals table", row && row.max_concurrent === 3 && row.burn_conservation === 0 && row.burn_rate_pct === 100, JSON.stringify(row));
    const wideCard = card(page, "Parallel goal");
    await wideCard.waitFor({ timeout: 10000 });
    check("the card shows 3 at once and the guard off", /3 at once/.test(await wideCard.locator(".sched-meta").textContent()) && (await wideCard.locator(".goal-burn.off").count()) === 1);

    await wideCard.locator('.btn:has-text("Edit")').click();
    await page.waitForSelector(".goal-modal", { timeout: 10000 });
    pace = await paceControls(page);
    check("edit opens with the saved pace", pace.parallel === "3" && pace.guard === false && pace.rateDisabled === true, JSON.stringify(pace));
    await page.fill(".goal-modal .goal-concurrency", "1");
    await page.click(".goal-modal .goal-burn-toggle input");
    await page.fill(".goal-modal .goal-burn-rate", "150");
    await saveAndClose(page);
    row = await waitForRow(dataDir, "Parallel goal", (r) => r.burn_conservation === 1);
    check("the edit turns the guard back on at 150% with one slot", row && row.max_concurrent === 1 && row.burn_conservation === 1 && row.burn_rate_pct === 150, JSON.stringify(row));

    // ---- the owner pins effort and model ----
    await fillNewGoal(page, "Pinned goal", workspace);
    await select(page, "Effort", "high");
    await select(page, "Provider", "claude");
    p = await pickers(page);
    check("choosing a provider enables and fills the model picker", p.model?.disabled === false && !!p.model.value, JSON.stringify(p.model));
    const chosenModel = p.model?.value;
    await page.screenshot({ path: path.join(shotDir(dataDir), "goals-editor.png") });
    await saveAndClose(page);
    row = await waitForRow(dataDir, "Pinned goal", () => true);
    check("the pin reaches the goals table", row && row.effort === "high" && row.provider === "claude" && row.model === chosenModel, JSON.stringify(row));
    const pinnedCard = card(page, "Pinned goal");
    await pinnedCard.waitFor({ timeout: 10000 });
    check("the card shows the owner's effort", (await pinnedCard.locator(".sched-meta .effort-badge.eff-high").count()) === 1);
    check("the card no longer says the director picks", (await pinnedCard.locator(".goal-effort-auto").count()) === 0);

    // ---- editing shows the pin, and can hand it back to the director ----
    await pinnedCard.locator('.btn:has-text("Edit")').click();
    await page.waitForSelector(".goal-modal", { timeout: 10000 });
    p = await pickers(page);
    check("edit opens with the saved pin", p.effort?.value === "high" && p.provider?.value === "claude" && p.model?.value === chosenModel, JSON.stringify(p));
    await select(page, "Effort", "");
    await select(page, "Provider", "");
    p = await pickers(page);
    check("clearing the provider clears and locks the model", p.model?.disabled === true && p.model.value === "", JSON.stringify(p.model));
    await saveAndClose(page);
    row = await waitForRow(dataDir, "Pinned goal", (r) => r.effort === null);
    check("the edit hands effort and model back to the director", row && row.effort === null && row.provider === null && row.model === null, JSON.stringify(row));

    // ---- server-authoritative: a reload shows what the DB holds ----
    await page.reload({ timeout: 45000 });
    await page.waitForSelector(".accounts .acct", { state: "attached", timeout: 30000 });
    await openGoals(page);
    await card(page, "Pinned goal").waitFor({ timeout: 10000 });
    check("after a reload the edited goal reads low–medium", (await card(page, "Pinned goal").locator(".goal-effort-auto").count()) === 1);
    check("after a reload the paced goal reads burn ≤ 150%", (await card(page, "Parallel goal").locator(".goal-burn").textContent())?.trim() === "burn ≤ 150%");

    // ---- a goal the loop stopped as blocked: the owner's Resume starts a fresh audit ----
    // The raw write emits no hub event, so a reload would get the cached hello from before it. An owner
    // action on another goal makes the runner broadcast the whole list from the DB, the same path the
    // loop's own stop takes.
    stopAsBlocked(dataDir, "Default goal");
    await card(page, "Parallel goal").locator('.sched-actions .btn:has-text("Pause")').click();
    row = await waitForRow(dataDir, "Parallel goal", (r) => r.status === "paused");
    check("pausing another goal goes through the runner", row?.status === "paused", JSON.stringify(row));
    const blockedCard = card(page, "Default goal");
    await blockedCard.locator(".goal-status", { hasText: "Blocked" }).waitFor({ timeout: 10000 }).catch(() => {});
    const blockedStatus = (await blockedCard.locator(".goal-status").textContent())?.trim();
    const blockedReason = await blockedCard.locator(".goal-reason").textContent();
    check("a blocked goal reads Blocked, with why", blockedStatus === "Blocked" && /same blocker three turns running/.test(blockedReason ?? ""), JSON.stringify({ blockedStatus, blockedReason }));
    await page.screenshot({ path: path.join(shotDir(dataDir), "goals-blocked.png") });
    await page.reload({ timeout: 45000 });
    await page.waitForSelector(".accounts .acct", { state: "attached", timeout: 30000 });
    await openGoals(page);
    await blockedCard.waitFor({ timeout: 10000 });
    check("after a reload it still reads Blocked", (await blockedCard.locator(".goal-status").textContent())?.trim() === "Blocked");
    await blockedCard.locator('.sched-actions .btn:has-text("Resume")').click();
    row = await waitForRow(dataDir, "Default goal", (r) => r.status === "active");
    check("Resume reactivates it, clears the blocker streak and asks the director first", row && row.status === "active" && row.blocked_streak === 0 && row.replan_at != null, JSON.stringify(row));

    check("no console errors", errors.length === 0, errors.join(" | "));
    await page.screenshot({ path: path.join(shotDir(dataDir), "goals-cards.png") });
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
