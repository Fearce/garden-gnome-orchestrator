// Drive contextual code navigation — task / Co-work / Supervisor → IDE and Git, and back — in a real
// browser, headlessly, against a repository built for the occasion.
//
//   npm run code-nav-lab --prefix server
//   npm run code-nav-lab --prefix server -- --keep              (leave the instance + fixture behind)
//   npm run code-nav-lab --prefix server -- --shots data/nav    (keep the screenshots)
//
// Use it for any change to CodeContextBar.tsx / lib/codeNav.ts / orchestrator/codeContext.ts / the
// `code.context` command, or to the surfaces that carry the routes (ThreadDetail, CoWork,
// SupervisorPanel, GitChanges, GitConsole, Ide).
//
// `test:code-context` already proves the resolver and the path math with no browser. This proves the
// other half — that the routes are WIRED: that a click lands the IDE on the right workspace and file,
// that the Git console opens on the right repository, that the way back works, and that the row stays
// usable on a phone. A deep link is exactly the kind of feature a typecheck cannot see.
//
// Why it can't disturb anything: temp DATA_DIR (prod's sqlite is never opened, and an empty thread
// table means the boot auto-resume has nothing to resurrect), bogus account tokens, a throwaway
// fixture repo with a local bare origin, alt ports, and the instance killed by PORT owner.

const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Database = require("better-sqlite3");
const { SERVER_ROOT, loadChromium, authPassword, requireBuild, boot, killInstance, createChecks, shotDir } = require("./lab-harness.cjs");

const PORT = 4341;
const BASE = `http://127.0.0.1:${PORT}`;
const REPO_TASK = "code-nav-repo-task";
const PARENT_TASK = "code-nav-parent-task";
const TASK_COMMIT_SUBJECT = "the task's own commit";

// ---- the isolated build --------------------------------------------------------------------------

/** Compile the CURRENT server source without touching live `dist`. Without this the lab would drive
 *  whatever is already deployed, and a contextual route is exactly the kind of change that typechecks
 *  green while being unwired — so a lab against a stale build proves nothing about the diff. The output
 *  must be a DIRECT child of the server root: `config.ts` derives `serverRoot` from its compiled file's
 *  parent, so a nested temp build points static assets at the wrong directory. */
function compileIsolatedServer() {
  const buildDir = path.join(SERVER_ROOT, ".code-nav-lab-dist");
  fs.rmSync(buildDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  try {
    execFileSync(
      process.execPath,
      [require.resolve("typescript/bin/tsc"), "-p", "tsconfig.json", "--outDir", buildDir],
      { cwd: SERVER_ROOT, stdio: "inherit", windowsHide: true },
    );
    return path.join(buildDir, "index.js");
  } catch (error) {
    fs.rmSync(buildDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    throw error;
  }
}

// ---- the fixture -----------------------------------------------------------------------------------

/** A checkout inside a parent folder, carrying both shapes a task's Changes drawer routes FROM: one
 *  commit the task made after its dispatch baseline, and one still-uncommitted edit. The parent is the
 *  layout that matters most: a task workspace is routinely the PARENT of its repo, which is exactly when
 *  a repo-relative changed file needs the prefix prepended before the IDE can open it. */
function buildFixture(base) {
  const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", windowsHide: true }).trim();
  const parent = path.join(base, "project-root");
  const work = path.join(parent, "sample-project");
  fs.mkdirSync(work, { recursive: true });
  git(work, "init", "--quiet", "-b", "master");
  for (const [k, v] of [["user.name", "Code Nav Lab"], ["user.email", "nav-lab@example.com"], ["commit.gpgsign", "false"], ["core.autocrlf", "false"]]) git(work, "config", k, v);
  fs.writeFileSync(path.join(work, "app.js"), "console.log('one');\n");
  fs.writeFileSync(path.join(work, "README.md"), "# sample\n");
  git(work, "add", "-A");
  git(work, "commit", "--quiet", "-m", "initial commit");
  // The dispatch baseline: everything after it is the task's own work, which is what makes its History
  // tab attributable and its commits routable into the repo console.
  const baseline = git(work, "rev-parse", "HEAD");
  fs.writeFileSync(path.join(work, "app.js"), "console.log('one');\nconsole.log('two');\n");
  git(work, "add", "-A");
  git(work, "commit", "--quiet", "-m", TASK_COMMIT_SUBJECT);
  // And an edit the task hasn't committed, so the Changes tab has a file to route from too.
  fs.writeFileSync(path.join(work, "app.js"), "console.log('one');\nconsole.log('two');\nconsole.log('three');\n");
  return { parent, work, baseline };
}

/**
 * Seed the two tasks, a co-work session and a Supervisor audit row — one per surface that carries a
 * route. The tasks sit in `review` so nothing tries to run an agent, and the repo task gets a recorded
 * `Write` tool message plus a baseline so its Changes drawer attributes a real file to it (that
 * attribution is what the per-file route hangs off).
 */
function seed(dataDir, fixture) {
  const db = new Database(path.join(dataDir, "orchestrator.sqlite"));
  const now = Date.now();
  db.prepare("INSERT INTO kv(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(
    "setting_recent_repos",
    JSON.stringify([fixture.work]),
  );
  const insertThread = db.prepare(
    "INSERT INTO threads (id, title, state, workspace, brief, raw_prompt, baseline_head, created_at, updated_at) VALUES (?, ?, 'review', ?, ?, ?, ?, ?, ?)",
  );
  insertThread.run(REPO_TASK, "Repo task", fixture.work, "a seeded task", "a seeded task", fixture.baseline, now, now);
  insertThread.run(PARENT_TASK, "Parent task", fixture.parent, "a seeded task", "a seeded task", null, now, now);
  db.prepare("INSERT INTO messages (id, thread_id, role, kind, content, created_at) VALUES (?, ?, 'implementor', 'tool', ?, ?)").run(
    "code-nav-msg-1",
    REPO_TASK,
    `Write ${JSON.stringify({ file_path: path.join(fixture.work, "app.js") })}`,
    now,
  );
  db.prepare(
    "INSERT INTO cowork_sessions (id, name, workspace, state, created_at, updated_at) VALUES (?, ?, ?, 'idle', ?, ?)",
  ).run("code-nav-cowork", "Pairing session", fixture.work, now, now);
  db.prepare(
    "INSERT INTO supervisor_events (id, thread_id, thread_title, workspace, trigger, kind, summary, created_at) VALUES (?, ?, ?, ?, 'state_change', 'check', ?, ?)",
  ).run("code-nav-sup", null, "Repo task", fixture.work, "Checked the task and found nothing to do.", now);
  db.close();
}

// ---- the drive ---------------------------------------------------------------------------------------

const check = createChecks();

/** The context row's branch reading, once the server's answer has landed. */
async function branchText(page, scope) {
  await page.waitForSelector(`${scope} .codectx-reading b`, { timeout: 20_000 });
  return (await page.textContent(`${scope} .codectx-reading b`))?.trim() ?? "";
}

/** Switch board area the way the desktop console does — `.board-area-select` is the narrow-viewport
 *  fallback and is not visible at lab width, where a `selectOption` on it times out. */
async function openArea(page, view) {
  await page.click(`.board-tab.bt-${view}`);
  await page.waitForSelector(`.board-${view}`, { timeout: 15_000 });
}

async function openTask(page, title) {
  await page.click(`.card:has-text("${title}")`);
  await page.waitForSelector(".detail-head", { timeout: 15_000 });
}

async function drive(page, shots) {
  const errors = [];
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  page.on("pageerror", (e) => errors.push(String(e)));

  await page.request.post(`${BASE}/api/login`, { data: { password: authPassword() } });
  await page.goto(`${BASE}/`);
  // The socket's hello, not the shell: everything server-authoritative is neutral until it lands.
  await page.waitForSelector(".accounts .acct", { timeout: 30_000 });

  console.log("\nTASK — the detail panel states repo and branch");
  await openTask(page, "Repo task");
  check("the task panel carries a code-context row", await page.isVisible(".detail .codectx"));
  check("it reads the real branch", (await branchText(page, ".detail")) === "master", await branchText(page, ".detail"));
  check(
    "it names the repository",
    (await page.textContent(".detail .codectx-repo"))?.trim() === "sample-project",
    (await page.textContent(".detail .codectx-repo")) ?? "",
  );

  console.log("\nTASK → IDE — one click lands in the editor on that workspace");
  await page.click('.detail .codectx-btn:has-text("Code")');
  await page.waitForSelector(".ide-mount:not([hidden]) .ide", { timeout: 20_000 });
  // The IDE mounts before its workspace list arrives, so the select reads "Loading workspaces…" for a
  // moment. Wait for the resolved selection rather than sampling the placeholder.
  await page
    .waitForFunction(
      () => !!document.querySelector('.ide-toolbar select[aria-label="IDE workspace"]')?.selectedOptions[0]?.textContent?.includes("sample-project"),
      null,
      { timeout: 20_000 },
    )
    .catch(() => {});
  const workspaceLabel = await page.$eval('.ide-toolbar select[aria-label="IDE workspace"]', (el) => el.selectedOptions[0]?.textContent ?? "");
  check("the IDE opened on the task's workspace", workspaceLabel.includes("sample-project"), workspaceLabel);
  check("a way back is offered", (await page.textContent(".ide-return .codectx-btn"))?.includes("Repo task") === true);

  console.log("\nIDE → TASK — the return trip restores the origin");
  await page.click(".ide-return .codectx-btn");
  await page.waitForSelector(".board-tasks", { timeout: 15_000 });
  check("it returns to the task board", await page.isVisible(".board-tasks"));
  check("with the originating task still open", (await page.textContent(".detail-head"))?.includes("Repo task") === true);
  check("and the return banner is spent", (await page.$(".codectx-return")) === null);

  console.log("\nTASK → GIT — the console opens on that repository");
  await page.click('.detail .codectx-btn:has-text("Git")');
  await page.waitForSelector(".gc-window", { timeout: 20_000 });
  await page.waitForSelector('.gc-pick-value:text-is("sample-project")', { timeout: 20_000 }).catch(() => {});
  const picked = await page.$$eval(".gc-pick-value", (els) => els.map((e) => e.textContent));
  check("the Git console landed on the task's repo", picked.includes("sample-project"), picked.join(","));
  check("the console offers the way back too", await page.isVisible(".gc-return .codectx-btn"));
  await page.click(".gc-return .codectx-btn");
  await page.waitForSelector(".gc-window", { state: "detached", timeout: 15_000 });
  check("returning closes the console", (await page.$(".gc-window")) === null);

  console.log("\nCHANGED FILE → IDE — the task's own file, through the repo prefix");
  await openTask(page, "Repo task");
  await page.click('.card:has-text("Repo task") .changes-chip');
  await page.waitForSelector(".git-panel", { timeout: 20_000 });
  await page.waitForSelector(".git-file-row", { timeout: 20_000 });
  check("the drawer attributes the task's file", (await page.textContent(".git-file-list"))?.includes("app.js") === true);
  await page.waitForSelector('.git-diff-head .codectx-btn:has-text("Edit")', { timeout: 20_000 });
  await page.click('.git-diff-head .codectx-btn:has-text("Edit")');
  await page.waitForSelector(".ide-mount:not([hidden]) .ide", { timeout: 20_000 });
  await page.waitForSelector(".ide-tab.active", { timeout: 20_000 });
  const tab = (await page.textContent(".ide-tab.active")) ?? "";
  check("the IDE opened that exact file", tab.includes("app.js"), tab);
  check("the drawer closed behind the navigation", (await page.$(".git-panel")) === null);
  await page.screenshot({ path: path.join(shots, "code-nav-ide.png") });
  await page.click(".ide-return .codectx-btn");
  await page.waitForSelector(".board-tasks", { timeout: 15_000 });

  console.log("\nTASK COMMIT → GIT HISTORY — the task's own commit, opened in the repo console");
  await page.click('.card:has-text("Repo task") .changes-chip');
  await page.waitForSelector(".git-panel", { timeout: 20_000 });
  await page.click('.git-tab:has-text("History")');
  await page.waitForSelector(".commit-row", { timeout: 20_000 });
  check(
    "the drawer attributes the task's own commit",
    (await page.textContent(".commit-list"))?.includes(TASK_COMMIT_SUBJECT) === true,
    (await page.textContent(".commit-list")) ?? "",
  );
  await page.click(`.commit-open:has-text("${TASK_COMMIT_SUBJECT}")`);
  await page.waitForSelector(".gc-window", { timeout: 20_000 });
  // The console must land on History, not its default Changes tab — the commit IS the destination.
  await page.waitForSelector(".gc-window .gc-tab.on", { timeout: 20_000 });
  const activeTab = (await page.textContent(".gc-window .gc-tab.on")) ?? "";
  check("the Git console opened on History", activeTab.includes("History"), activeTab);
  // Tolerant on purpose: a landing that never happens must REPORT as the failed check below, not throw
  // a stack that ends the drive and takes every later section with it.
  await page.waitForSelector(".gc-window .gc-commit-row.on", { timeout: 20_000 }).catch(() => {});
  const openCommit = (await page.textContent(".gc-window .gc-commit-row.on").catch(() => "")) ?? "";
  check("and landed on that exact commit", openCommit.includes(TASK_COMMIT_SUBJECT), openCommit);
  check("with no not-in-history warning", (await page.$(".gc-window .gc-list-col .gc-none")) === null);
  // Selecting the row is not the destination — its diff is. The detail is a second round trip, so a
  // deep link that highlights a commit and then stalls on "Select a commit." would still look right.
  await page.waitForSelector(".gc-commit-detail", { timeout: 20_000 }).catch(() => {});
  const detail = (await page.textContent(".gc-commit-detail").catch(() => "")) ?? "";
  check("and its detail actually loads", detail.includes(TASK_COMMIT_SUBJECT) && detail.includes("app.js"), detail.slice(0, 120));
  await page.screenshot({ path: path.join(shots, "code-nav-commit.png") });
  await page.click(".gc-return .codectx-btn");
  await page.waitForSelector(".gc-window", { state: "detached", timeout: 15_000 });

  console.log("\nPARENT WORKSPACE — a nested checkout still resolves");
  await openTask(page, "Parent task");
  check("a parent-of-repo workspace still reads its branch", (await branchText(page, ".detail")) === "master");
  check("and still offers both routes", (await page.$$(".detail .codectx-actions .codectx-btn")).length === 2);

  console.log("\nCO-WORK — the conversation header carries the same row");
  // Close the task panel first: that is how an operator moves between areas, and it also gives the
  // conversation header its real width instead of a column squeezed by an open detail panel.
  await page.click('.detail-title-actions .close-x[aria-label="Close"]');
  await page.waitForSelector(".detail", { state: "detached", timeout: 10_000 });
  await openArea(page, "cowork");
  await page.waitForSelector(".cowork-session-row", { timeout: 20_000 });
  await page.click('.cowork-session-row:has-text("Pairing session")');
  await page.waitForSelector(".cowork-chat-identity .codectx", { timeout: 20_000 });
  check("the co-work header states the branch", (await branchText(page, ".cowork-chat-identity")) === "master");
  check("and offers a route into the code", await page.isVisible('.cowork-chat-identity .codectx-btn:has-text("Code")'));
  await page.click('.cowork-chat-identity .codectx-btn:has-text("Code")');
  await page.waitForSelector(".ide-mount:not([hidden]) .ide", { timeout: 20_000 });
  check("a co-work session opens the editor", await page.isVisible(".ide-mount:not([hidden]) .ide"));
  await page.click(".ide-return .codectx-btn");
  // Co-work is its own board area, so the return must land THERE — not on the task board, which is
  // where a `thread`-shaped origin goes.
  await page.waitForSelector(".board-cowork", { timeout: 15_000 }).catch(() => {});
  check("and returning lands back in Co-work, not on the task board", await page.isVisible(".board-cowork"));
  check("with the conversation still open", await page.isVisible(".cowork-chat-identity"));

  console.log("\nSUPERVISOR — an audit row routes into its workspace");
  await openArea(page, "supervisor");
  await page.waitForSelector(".supervisor-row", { timeout: 20_000 });
  check("the audit row states the branch", (await branchText(page, ".supervisor-row")) === "master");
  await page.click('.supervisor-row .codectx-btn:has-text("Git")');
  await page.waitForSelector(".gc-window", { timeout: 20_000 });
  check("a Supervisor row opens the Git console", await page.isVisible(".gc-window"));
  await page.click(".gc-return .codectx-btn");
  await page.waitForSelector(".gc-window", { state: "detached", timeout: 15_000 });
  check("and returns to the Supervisor view, not the task board", await page.isVisible(".supervisor-view"));

  console.log("\nPHONE — the row survives a narrow viewport without new header chrome");
  await openArea(page, "tasks");
  await page.setViewportSize({ width: 390, height: 844 });
  await openTask(page, "Repo task");
  // A phone opens the panel with its header collapsed (an existing reading-mode default), so the row
  // adds NOTHING to the crowded header until the operator expands it — which is the point of putting
  // it there rather than in the top bar.
  check("nothing new in the collapsed phone header", (await page.$(".detail .codectx")) === null);
  await page.click('.detail .head-toggle[aria-label="Expand header"]');
  await page.waitForSelector(".detail .codectx", { timeout: 20_000 });
  const row = await page.$(".detail .codectx");
  const box = await row.boundingBox();
  check("the context row stays inside the viewport", !!box && box.x >= 0 && box.x + box.width <= 390 + 1, JSON.stringify(box));
  check("both routes stay reachable on a phone", (await page.$$(".detail .codectx-actions .codectx-btn")).length === 2);
  const overflow = await page.$eval(".detail .codectx", (el) => el.scrollWidth - el.clientWidth);
  check("the row does not scroll sideways", overflow <= 1, String(overflow));
  await page.screenshot({ path: path.join(shots, "code-nav-phone.png") });

  check("no console errors during the whole drive", errors.length === 0, errors.slice(0, 3).join(" | "));
  console.log(`\n  screenshots: ${shots}`);
}

// ---- run ----------------------------------------------------------------------------------------------

(async () => {
  const keep = process.argv.includes("--keep");
  const entry = compileIsolatedServer();
  requireBuild(entry);
  killInstance(PORT);

  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "code-nav-lab-"));
  const fixtureBase = fs.mkdtempSync(path.join(os.tmpdir(), "code-nav-repo-"));
  const fixture = buildFixture(fixtureBase);
  const shots = shotDir(dataDir);

  let browser;
  try {
    await boot({ dataDir, port: PORT, entry, env: { CODEX_WAKE: "off" } });
    seed(dataDir, fixture);
    browser = await loadChromium().launch();
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await drive(page, shots);
  } finally {
    if (browser) await browser.close().catch(() => {});
    if (!keep) {
      killInstance(PORT);
      fs.rmSync(dataDir, { recursive: true, force: true });
      fs.rmSync(fixtureBase, { recursive: true, force: true });
    }
  }
  process.exit(check.summary());
})().catch((e) => {
  console.error(e);
  killInstance(PORT);
  process.exit(1);
});
