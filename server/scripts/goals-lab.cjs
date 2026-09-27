// Lab for a goal's owner-chosen effort and model (`npm run goals-lab`). What `test:goals` cannot see:
// whether the create/edit dialog really offers the pickers, whether "Auto (low or medium)" is the default
// a new goal gets, whether the chosen pin survives the socket into the goals table, and whether an edit
// can hand the pick back to the director — read back from the instance's own DB, not the optimistic UI.
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

function goalRow(dataDir, title) {
  const Database = require(path.join(__dirname, "..", "node_modules", "better-sqlite3"));
  const db = new Database(path.join(dataDir, "orchestrator.sqlite"), { readonly: true });
  try {
    return db.prepare("SELECT effort, provider, model FROM goals WHERE title = ?").get(title) ?? null;
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
    await page.waitForSelector(".accounts .acct", { timeout: 30000 });
    await openGoals(page);

    // ---- a new goal defaults to the director's model at low-or-medium effort ----
    await fillNewGoal(page, "Default goal", workspace);
    let p = await pickers(page);
    check("the dialog offers an effort picker", !!p.effort, JSON.stringify(p));
    check("...defaulting to Auto (low or medium)", p.effort?.value === "" && /low or medium/.test(p.effort.text), JSON.stringify(p.effort));
    check("...with every owner effort on offer", ["low", "medium", "high", "max"].every((e) => p.effort?.options.includes(e)), JSON.stringify(p.effort?.options));
    check("the dialog offers a provider picker defaulting to the director", p.provider?.value === "" && /Director picks/.test(p.provider.text), JSON.stringify(p.provider));
    check("the model picker waits for a provider", p.model?.disabled === true, JSON.stringify(p.model));
    await saveAndClose(page);
    let row = await waitForRow(dataDir, "Default goal", () => true);
    check("an untouched dialog stores no pin (director picks, low or medium)", row && row.effort === null && row.provider === null && row.model === null, JSON.stringify(row));
    await card(page, "Default goal").waitFor({ timeout: 10000 });
    check("the card says the effort is low–medium", (await card(page, "Default goal").locator(".goal-effort-auto").textContent())?.trim() === "low–medium");

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
    await page.waitForSelector(".accounts .acct", { timeout: 30000 });
    await openGoals(page);
    await card(page, "Pinned goal").waitFor({ timeout: 10000 });
    check("after a reload the edited goal reads low–medium", (await card(page, "Pinned goal").locator(".goal-effort-auto").count()) === 1);

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
