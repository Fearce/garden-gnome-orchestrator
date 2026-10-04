// Drive the composer's REPOS chips in a real browser against a throwaway instance: one chip per
// workspace, whatever spelling of the path reached the server.
//
//   npm run repo-chips-lab --prefix server
//   npm run repo-chips-lab --prefix server -- --keep --shots data/repo-chips-shots
//
// The chips doubled on 2026-10-04 because `C:\x` and `C:/x` (and `c:\x`) were stored as different repos.
// This seeds exactly that legacy row, boots, and checks the boot repair, the active chip for a variant
// spelling, an add through the + picker under a variant spelling, a genuine add, a removal, and that all
// of it survives a reload. Bogus account tokens and kill-by-port come from lab-harness.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Database = require("better-sqlite3");
const { loadChromium, authPassword, requireBuild, requireFreshWebBuild, boot, waitForPersisted, killInstance, createChecks, shotDir } = require("./lab-harness.cjs");

const PORT = 4571;
const BASE = `http://127.0.0.1:${PORT}`;
const NAV_TIMEOUT = 45_000;

const forwardSlashes = (p) => p.replace(/\\/g, "/");
const lowerDrive = (p) => p.charAt(0).toLowerCase() + p.slice(1);

function makeRepos(dataDir) {
  const at = (name) => {
    const p = path.join(dataDir, "repos", name);
    fs.mkdirSync(p, { recursive: true });
    return p;
  };
  // `twin` shares alpha's folder name in a worktree-shaped path: a genuinely different workspace.
  return { alpha: at("alpha"), beta: at("beta"), gamma: at("gamma"), twin: at(path.join("alpha.worktrees", "chips", "alpha")) };
}

function seedLegacy(dataDir, repos) {
  const db = new Database(path.join(dataDir, "orchestrator.sqlite"));
  const setKv = db.prepare("INSERT INTO kv(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value");
  setKv.run("setting_max_recent_repos", "9");
  setKv.run(
    "setting_recent_repos",
    JSON.stringify([lowerDrive(repos.alpha), repos.beta, forwardSlashes(repos.beta), repos.twin, forwardSlashes(repos.alpha) + "/"]),
  );
  db.close();
}

function storedRepos(dataDir) {
  const db = new Database(path.join(dataDir, "orchestrator.sqlite"), { readonly: true });
  const row = db.prepare("SELECT value FROM kv WHERE key = 'setting_recent_repos'").get();
  db.close();
  return row ? JSON.parse(row.value) : null;
}

async function openComposer(browser) {
  const page = await browser.newPage({ viewport: { width: 1500, height: 950 } });
  await page.request.post(`${BASE}/api/login`, { data: { password: authPassword() } });
  await page.goto(`${BASE}/`, { timeout: NAV_TIMEOUT });
  await page.waitForSelector(".accounts .acct", { state: "attached", timeout: 25_000 });
  await page.waitForSelector(".recent-repos .repo-chip", { timeout: 20_000 });
  return page;
}

/** The chips as the owner reads them: label, full path and whether it is the lit (active) one. */
function readChips(page) {
  return page.$$eval(".recent-repos .repo-chip", (chips) =>
    chips.map((c) => ({ label: c.querySelector(".repo-chip-pick").textContent.trim(), path: c.getAttribute("title"), on: c.classList.contains("on") })),
  );
}

async function waitForChipCount(page, n) {
  try {
    await page.waitForFunction((want) => document.querySelectorAll(".recent-repos .repo-chip").length === want, n, { timeout: 10_000 });
  } catch {
    /* reported by the caller's check */
  }
}

async function pickThroughPlus(page, typed) {
  await page.locator("input.ws").first().fill(typed);
  await page.click(".recent-repos .repo-add");
  await page.waitForSelector(".folder-picker .btn.primary:not([disabled])", { timeout: 15_000 });
  await page.click(".folder-picker .btn.primary");
  await page.waitForSelector(".folder-picker", { state: "detached", timeout: 10_000 });
}

async function main() {
  requireBuild();
  requireFreshWebBuild();
  const check = createChecks();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "repo-chips-lab-"));
  const keep = process.argv.includes("--keep");
  const shots = shotDir(dataDir);
  console.log(`repo-chips-lab — ${BASE} (data ${dataDir})`);

  try {
    const repos = makeRepos(dataDir);
    // First boot creates the schema; seed the legacy row into it, then boot again so the repair runs.
    await boot({ dataDir, port: PORT });
    killInstance(PORT);
    seedLegacy(dataDir, repos);
    await boot({ dataDir, port: PORT });

    const repaired = [repos.alpha, repos.beta, repos.twin];
    check("boot rewrites the duplicated row to one entry per workspace", JSON.stringify(storedRepos(dataDir)) === JSON.stringify(repaired), JSON.stringify(storedRepos(dataDir)));

    const browser = await loadChromium().launch();
    try {
      const page = await openComposer(browser);
      let chips = await readChips(page);
      check("the composer shows one chip per workspace", JSON.stringify(chips.map((c) => c.path)) === JSON.stringify(repaired), JSON.stringify(chips));
      check("two chips may share a label when their workspaces differ", chips.filter((c) => c.label === "alpha").length === 2, JSON.stringify(chips.map((c) => c.label)));
      await page.locator(".recent-repos").screenshot({ path: path.join(shots, "1-repaired.png") });

      await page.locator("input.ws").first().fill(lowerDrive(forwardSlashes(repos.beta)) + "/");
      chips = await readChips(page);
      check("a variant spelling in the path field lights the canonical chip", chips.filter((c) => c.on).map((c) => c.path).join() === repos.beta, JSON.stringify(chips));

      await pickThroughPlus(page, forwardSlashes(lowerDrive(repos.alpha)));
      await page.waitForTimeout(500);
      chips = await readChips(page);
      check("adding a listed repo under another spelling moves it, adding no chip", chips.length === 3 && chips[0].path === repos.alpha, JSON.stringify(chips));
      const afterVariantAdd = await waitForPersisted(dataDir, "setting_recent_repos", JSON.stringify([repos.alpha, repos.beta, repos.twin]));
      check("the server stores that add without a duplicate", afterVariantAdd !== null, JSON.stringify(storedRepos(dataDir)));

      await pickThroughPlus(page, repos.gamma);
      await waitForChipCount(page, 4);
      chips = await readChips(page);
      check("a genuinely new repo still gets its chip", chips.length === 4 && chips[0].path === repos.gamma, JSON.stringify(chips));

      await page.click(`.recent-repos .repo-chip[title="${repos.beta.replace(/\\/g, "\\\\")}"] .repo-chip-x`);
      await waitForChipCount(page, 3);
      chips = await readChips(page);
      check("× removes exactly that repo", JSON.stringify(chips.map((c) => c.path)) === JSON.stringify([repos.gamma, repos.alpha, repos.twin]), JSON.stringify(chips));
      const afterRemove = await waitForPersisted(dataDir, "setting_recent_repos", JSON.stringify([repos.gamma, repos.alpha, repos.twin]));
      check("the removal is persisted", afterRemove !== null, JSON.stringify(storedRepos(dataDir)));
      await page.locator(".recent-repos").screenshot({ path: path.join(shots, "2-after-add-remove.png") });
      await page.close();

      // Past the two-second hello snapshot cache, so the reload reads the persisted list.
      await new Promise((r) => setTimeout(r, 2_100));
      const reloaded = await openComposer(browser);
      chips = await readChips(reloaded);
      check("the list survives a reload unchanged", JSON.stringify(chips.map((c) => c.path)) === JSON.stringify([repos.gamma, repos.alpha, repos.twin]), JSON.stringify(chips));
      const labels = chips.map((c) => c.path.toLowerCase().replace(/\//g, "\\"));
      check("no two chips name the same workspace", new Set(labels).size === labels.length, JSON.stringify(labels));
      await reloaded.locator(".composer-options").screenshot({ path: path.join(shots, "3-after-reload.png") });
      console.log(`  screenshots: ${shots}`);
      await reloaded.close();
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
