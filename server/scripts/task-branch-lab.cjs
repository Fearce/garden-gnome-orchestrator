// Lab for the task header's branch line (`npm run task-branch-lab`). A gate proves a task is bound to its
// own worktree; only a render proves the header SAYS so — which branch, which worktree folder, cut from
// what — and that a task still working in the main checkout names that branch instead. Builds a fixture
// repo with a real linked worktree, seeds one task bound to it and one working in place, and reads both
// headers in a real browser at desktop and phone width. A third task carries a real-length branch and folder
// (the names that pushed the header's ✕ and collapse chevron out of the panel) and proves every header
// control stays inside the panel and clickable, expanded and collapsed, at desktop and tablet width. Also flips Settings › Pipeline › Task worktrees
// and waits for the kv row. Not in GATES: it needs a browser + an instance, like the other labs. To test
// uncommitted server work, see the GGO_LAB_ENTRY note in lab-harness.cjs.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { loadChromium, authPassword, requireBuild, boot, killInstance, createChecks, shotDir, waitForPersisted } = require("./lab-harness.cjs");

const PORT = 4437;
const OWN = "c3c3c3c3-3333-4333-8333-333333333333";
const IN_PLACE = "d4d4d4d4-4444-4444-8444-444444444444";
const LONG = "e5e5e5e5-5555-4555-8555-555555555555";
const BRANCH = "ggo/dark-mode-c3c3c3c3";
const LONG_BRANCH = "ggo/worktree-guidance-clarification-e5e5e5e5";
const LONG_FOLDER = "worktree-guidance-clarification";
const check = createChecks();

const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", windowsHide: true }).trim();

/** A repo on `master` plus one linked worktree on the task branch, laid out the way GGO makes them. */
function fixtureRepo(root) {
  const repo = path.join(root, "app");
  fs.mkdirSync(repo, { recursive: true });
  git(repo, "init", "--quiet", "-b", "master");
  git(repo, "config", "user.name", "Lab");
  git(repo, "config", "user.email", "lab@example.com");
  git(repo, "config", "commit.gpgsign", "false");
  fs.writeFileSync(path.join(repo, "README.md"), "lab\n");
  git(repo, "add", "README.md");
  git(repo, "commit", "--quiet", "-m", "initial");
  const folder = path.join(root, "app.worktrees", "dark-mode");
  git(repo, "worktree", "add", "--quiet", "-b", BRANCH, folder);
  const longFolder = path.join(root, "app.worktrees", LONG_FOLDER);
  git(repo, "worktree", "add", "--quiet", "-b", LONG_BRANCH, longFolder);
  return {
    repo: fs.realpathSync(repo),
    folder: fs.realpathSync(folder),
    longFolder: fs.realpathSync(longFolder),
    baseSha: git(repo, "rev-parse", "HEAD"),
  };
}

function seed(dataDir, fx) {
  const Database = require(path.join(__dirname, "..", "node_modules", "better-sqlite3"));
  const db = new Database(path.join(dataDir, "orchestrator.sqlite"));
  const now = Date.now();
  const worktree = (folder, branch) => JSON.stringify([{ repo: fx.repo, path: folder, branch, base: "master", baseSha: fx.baseSha, commitOnly: false, links: [], createdAt: now }]);
  const insert = db.prepare(
    "INSERT INTO threads (id, title, raw_prompt, brief, workspace, home_workspace, worktrees, state, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
  );
  insert.run(OWN, "OWN WORKTREE TASK", "p", "b", fx.folder, fx.repo, worktree(fx.folder, BRANCH), "review", now, now);
  insert.run(LONG, "LONG BRANCH TASK relax worktree enforcement to guidance", "p", "b", fx.longFolder, fx.repo, worktree(fx.longFolder, LONG_BRANCH), "review", now - 500, now - 500);
  insert.run(IN_PLACE, "IN PLACE TASK", "p", "b", fx.repo, null, null, "review", now - 1000, now - 1000);
  db.close();
}

async function openTask(page, title) {
  await page.click(`.card:has-text("${title}")`);
  await page.waitForFunction((t) => document.querySelector(".detail-head")?.textContent?.includes(t), title, { timeout: 20000 });
}

function readBranchLine(page) {
  return page.evaluate(() => {
    const line = document.querySelector(".detail-head .task-branch-line");
    if (!line) return null;
    const text = (sel) => line.querySelector(sel)?.textContent ?? null;
    const visible = (sel) => {
      const el = line.querySelector(sel);
      return !!el && getComputedStyle(el).display !== "none" && el.getBoundingClientRect().width > 0;
    };
    const name = line.querySelector(".task-branch-name");
    return {
      branch: text(".task-branch-name"),
      tags: [...line.querySelectorAll(".task-branch-tag")].map((t) => t.textContent),
      folder: text(".task-branch-folder"),
      folderVisible: visible(".task-branch-folder"),
      base: text(".task-branch-base"),
      branchFits: !!name && name.scrollWidth <= name.clientWidth + 1,
      lineInsideHead: line.getBoundingClientRect().right <= (document.querySelector(".detail-head")?.getBoundingClientRect().right ?? 0) + 1,
      title: line.getAttribute("title"),
    };
  });
}

/** Every control in the header's title row and code-context row, measured against the panel: each must lie
 *  inside `.detail` and be the element a click at its centre actually lands on (not clipped by the header's
 *  `overflow-x: hidden`, not covered by a neighbour). */
function readHeaderFit(page) {
  return page.evaluate(() => {
    const panel = document.querySelector(".detail")?.getBoundingClientRect();
    const head = document.querySelector(".detail-head");
    if (!panel || !head) return null;
    const controls = [...head.querySelectorAll(".detail-head-status > *, .detail-head-buttons > *, .codectx-btn")].filter((el) => el.getBoundingClientRect().width > 0);
    const outside = controls
      .map((el) => {
        const r = el.getBoundingClientRect();
        const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
        const inside = r.left >= panel.left - 1 && r.right <= panel.right + 1;
        return inside && !!hit && (hit === el || el.contains(hit)) ? null : `${el.className || el.tagName}@${Math.round(r.left)}-${Math.round(r.right)}`;
      })
      .filter(Boolean);
    const line = head.querySelector(".task-branch-line")?.getBoundingClientRect();
    return {
      controls: controls.length,
      closeShown: !!head.querySelector('.detail-title-actions [aria-label="Close"]'),
      toggleShown: !!head.querySelector(".detail-title-actions .head-toggle"),
      outside,
      headScrollsSideways: head.scrollWidth > head.clientWidth + 1,
      lineInsidePanel: !!line && line.right <= panel.right + 1,
      panel: `${Math.round(panel.left)}-${Math.round(panel.right)}`,
    };
  });
}

async function checkHeaderFits(page, label, shot, dataDir) {
  const fit = await readHeaderFit(page);
  const detail = JSON.stringify(fit);
  check(`${label}: the close ✕ and collapse chevron render`, !!fit?.closeShown && !!fit?.toggleShown, detail);
  check(`${label}: every header control sits inside the panel and takes its own click`, !!fit && fit.controls >= 3 && fit.outside.length === 0, detail);
  check(`${label}: the header never runs wider than the panel`, fit?.headScrollsSideways === false, detail);
  check(`${label}: the branch line stays inside the panel`, fit?.lineInsidePanel ?? false, detail);
  await page.screenshot({ path: path.join(shotDir(dataDir), shot) });
}

async function checkLongBranchHeader(browser, dataDir, viewport, label, { nameFits }) {
  const context = await browser.newContext({ viewport });
  const page = await context.newPage();
  await page.request.post(`http://127.0.0.1:${PORT}/api/login`, { data: { password: authPassword() } });
  await page.goto(`http://127.0.0.1:${PORT}/`, { timeout: 45000 });
  await page.waitForSelector(".accounts .acct", { state: "attached", timeout: 30000 });
  await openTask(page, "LONG BRANCH TASK");
  await page.waitForSelector(".detail-head .task-branch-line", { timeout: 15000 });
  const line = await readBranchLine(page);
  check(`${label}: the long branch still names itself`, line?.branch === LONG_BRANCH, JSON.stringify(line));
  if (nameFits) check(`${label}: the folder and base give way before the branch name truncates`, line?.branchFits ?? false, JSON.stringify(line));
  await checkHeaderFits(page, `${label}, expanded`, `long-branch-${viewport.width}-expanded.png`, dataDir);
  await page.click(".detail-title-actions .head-toggle");
  await page.waitForSelector(".detail-head.collapsed", { timeout: 5000 });
  await checkHeaderFits(page, `${label}, collapsed`, `long-branch-${viewport.width}-collapsed.png`, dataDir);
  await page.click('.detail-title-actions [aria-label="Close"]');
  check(`${label}: the ✕ closes the panel`, await page.waitForSelector(".detail-head", { state: "detached", timeout: 5000 }).then(() => true, () => false));
  await context.close();
}

(async () => {
  requireBuild();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "task-branch-lab-"));
  const fx = fixtureRepo(fs.mkdtempSync(path.join(os.tmpdir(), "task-branch-repo-")));
  killInstance(PORT);
  let child = await boot({ dataDir, port: PORT });
  let code = 1;
  try {
    seed(dataDir, fx);
    child.kill();
    killInstance(PORT);
    child = await boot({ dataDir, port: PORT });

    const chromium = loadChromium();
    const browser = await chromium.launch();
    const context = await browser.newContext({ viewport: { width: 1500, height: 950 } });
    const page = await context.newPage();
    await page.request.post(`http://127.0.0.1:${PORT}/api/login`, { data: { password: authPassword() } });
    await page.goto(`http://127.0.0.1:${PORT}/`, { timeout: 45000 });
    await page.waitForSelector(".accounts .acct", { state: "attached", timeout: 30000 });

    await openTask(page, "OWN WORKTREE TASK");
    await page.waitForSelector(".detail-head .task-branch-line", { timeout: 15000 });
    const own = await readBranchLine(page);
    check("the worktree task names its branch", own?.branch === BRANCH, JSON.stringify(own));
    check("...tagged as a worktree", own?.tags.includes("worktree") ?? false, JSON.stringify(own?.tags));
    check("...with its worktree folder", own?.folder === "dark-mode" && own.folderVisible, JSON.stringify(own));
    check("...and its base", own?.base === "from master", own?.base ?? "");
    check("...the branch name is not truncated at desktop width", own?.branchFits ?? false);
    check("...the hover names the full worktree path", own?.title?.includes(fx.folder) ?? false, own?.title ?? "");
    await page.screenshot({ path: path.join(shotDir(dataDir), "own-worktree-desktop.png") });

    await openTask(page, "IN PLACE TASK");
    await page.waitForSelector(".detail-head .task-branch-line", { timeout: 30000 });
    const inPlace = await readBranchLine(page);
    check("the in-place task names the main checkout's branch", inPlace?.branch === "master", JSON.stringify(inPlace));
    check("...tagged as the main checkout", inPlace?.tags.includes("main checkout") ?? false, JSON.stringify(inPlace?.tags));
    await page.screenshot({ path: path.join(shotDir(dataDir), "in-place-desktop.png") });

    await page.click('[aria-label="Open settings"]');
    await page.waitForSelector('[role="dialog"][aria-label="Settings"]');
    await page.click('[data-settings-category="pipeline"]');
    const sw = page.locator('[role="dialog"][aria-label="Settings"] [role="switch"][aria-label="Task worktrees"]');
    await sw.waitFor({ state: "visible", timeout: 15000 });
    check("Settings › Pipeline shows the Task worktrees toggle, on by default", (await sw.getAttribute("aria-checked")) === "true");
    await sw.click();
    check("turning it off persists", (await waitForPersisted(dataDir, "setting_task_worktrees", "0")) === "0");
    await page.screenshot({ path: path.join(shotDir(dataDir), "settings-pipeline.png") });
    await context.close();

    await checkLongBranchHeader(browser, dataDir, { width: 1500, height: 950 }, "long branch at desktop width", { nameFits: true });
    await checkLongBranchHeader(browser, dataDir, { width: 1000, height: 800 }, "long branch at tablet width", { nameFits: false });

    const phone = await (await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true })).newPage();
    await phone.request.post(`http://127.0.0.1:${PORT}/api/login`, { data: { password: authPassword() } });
    await phone.goto(`http://127.0.0.1:${PORT}/`, { timeout: 45000 });
    await phone.waitForSelector(".accounts .acct", { state: "attached", timeout: 30000 });
    await openTask(phone, "OWN WORKTREE TASK");
    await phone.waitForSelector(".detail-head .task-branch-line", { timeout: 15000 });
    const small = await readBranchLine(phone);
    check("on a phone the branch still shows", small?.branch === BRANCH, JSON.stringify(small));
    check("...the folder yields its space", small?.folderVisible === false, JSON.stringify(small));
    check("...and the line stays inside the header", small?.lineInsideHead ?? false, JSON.stringify(small));
    await phone.screenshot({ path: path.join(shotDir(dataDir), "own-worktree-phone.png") });
    await phone.click('.detail-title-actions [aria-label="Close"]');
    await phone.waitForSelector(".detail-head", { state: "detached", timeout: 5000 });
    await openTask(phone, "LONG BRANCH TASK");
    await phone.waitForSelector(`.detail-head .task-branch-name:text-is("${LONG_BRANCH}")`, { timeout: 15000 });
    await checkHeaderFits(phone, "long branch on a phone", "long-branch-phone.png", dataDir);

    console.log(`\nscreenshots: ${shotDir(dataDir)}`);
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
  process.exit(1);
});
