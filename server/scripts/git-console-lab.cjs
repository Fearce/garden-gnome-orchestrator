// Drive the whole Git console (the in-app GitHub Desktop) in a real browser, headlessly, against a
// repository built for the occasion — without touching prod and without burning a token.
//
//   npm run git-lab --prefix server
//   npm run git-lab --prefix server -- --keep      (leave the instance + fixture repo behind to poke at)
//
// Use it for any change to GitConsole.tsx / gitConsole.css / repoConsole.ts / the repo.* WS commands.
// `test:repo-ops` already proves the git operations themselves against real repos with no browser at
// all; this proves the other half — that the console is WIRED to them: that a click reaches git, that
// the panel re-renders from the server's reply, and that a refusal is shown rather than swallowed.
//
// Why it can't disturb anything:
//   • DATA_DIR is a temp dir, so prod's orchestrator.sqlite is never opened — and an empty thread table
//     means the on-boot auto-resume has nothing to resurrect (no real agents spawn).
//   • ACCOUNT_i_TOKEN is overridden with a bogus value, so the boot ping can neither burn quota nor
//     START a real 5h window (the trap that makes a naive second instance wrong — see chip-lab).
//   • Every git action it performs is against a throwaway repo in the temp dir with a local bare
//     "origin". It never acts on this checkout, so a fetch/push here can't reach GitHub.
//   • Alt ports; the instance is killed by PORT owner (killing by process name would hit prod).

const { spawn, execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Database = require("better-sqlite3");

const SERVER_ROOT = path.resolve(__dirname, "..");
const PORT = 4337;
const BASE = `http://127.0.0.1:${PORT}`;

// ---- harness plumbing (mirrors chip-lab.cjs, deliberately: one way to boot a throwaway instance) ----

function loadChromium() {
  for (const mod of [process.env.PLAYWRIGHT_PATH, "playwright", "playwright-core"].filter(Boolean)) {
    try {
      return require(mod).chromium;
    } catch {
      /* try the next candidate */
    }
  }
  // NODE_PATH is unset in agent shells, so a bare require misses the global install — resolve it.
  const root = execFileSync("npm", ["root", "-g"], { shell: true }).toString().trim();
  return require(path.join(root, "playwright")).chromium;
}

function authPassword() {
  const line = fs
    .readFileSync(path.join(SERVER_ROOT, ".env"), "utf8")
    .split(/\r?\n/)
    .find((l) => /^AUTH_PASSWORD=/.test(l));
  return line ? line.slice("AUTH_PASSWORD=".length).trim() : "";
}

function requireBuild() {
  for (const rel of ["dist/index.js", "../web/dist/index.html"]) {
    if (!fs.existsSync(path.resolve(SERVER_ROOT, rel))) {
      console.error(`missing ${rel} — run \`npm run build\` at the repo root first.`);
      process.exit(2);
    }
  }
}

async function boot(dataDir) {
  const child = spawn(process.execPath, [path.join(SERVER_ROOT, "dist", "index.js")], {
    cwd: SERVER_ROOT,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      DATA_DIR: dataDir,
      PORT: String(PORT),
      HTTPS_PORT: String(PORT + 2),
      ACCOUNT_1_TOKEN: "git-lab-not-a-real-token",
      ACCOUNT_2_TOKEN: "git-lab-not-a-real-token",
      CLAUDE_CODE_OAUTH_TOKEN: "git-lab-not-a-real-token",
    },
  });
  const log = fs.createWriteStream(path.join(dataDir, "git-lab.log"));
  child.stdout.pipe(log);
  child.stderr.pipe(log);
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 500));
    try {
      if ((await fetch(`${BASE}/api/me`)).ok) return child;
    } catch {
      /* not listening yet */
    }
  }
  throw new Error(`instance never came up — see ${path.join(dataDir, "git-lab.log")}`);
}

/** Kill by PORT owner: killing by process name would take prod's node down with it. */
function killInstance() {
  try {
    execFileSync(
      "powershell",
      ["-NoProfile", "-Command", `Get-NetTCPConnection -LocalPort ${PORT} -State Listen | Select-Object -Expand OwningProcess -Unique | ForEach-Object { Stop-Process -Id $_ -Force }`],
      { stdio: "ignore" },
    );
  } catch {
    /* already gone */
  }
}

// ---- the fixture repository ------------------------------------------------------------------------

/** A clone of a local bare "origin" with: one pushed commit, a second branch, an upstream commit
 *  waiting to be pulled, a modified tracked file and an untracked one. That shape exercises every
 *  control in the console — including the diverged-branch refusal, which needs local AND upstream work. */
function buildFixture(base) {
  const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } }).trim();
  const configure = (dir) => {
    for (const [k, v] of [["user.name", "Git Lab"], ["user.email", "git-lab@example.com"], ["commit.gpgsign", "false"], ["core.autocrlf", "false"], ["push.default", "simple"]]) git(dir, "config", k, v);
  };

  const originBare = path.join(base, "origin.git");
  const work = path.join(base, "sample-project");
  git(base, "init", "--quiet", "--bare", originBare);
  git(base, "clone", "--quiet", originBare, work);
  configure(work);
  fs.writeFileSync(path.join(work, "README.md"), "# sample\n\nbase line\n");
  fs.writeFileSync(path.join(work, "app.js"), "console.log('one');\n");
  git(work, "add", "-A");
  git(work, "commit", "--quiet", "-m", "initial commit");
  git(work, "branch", "-M", "master");
  git(work, "push", "--quiet", "-u", "origin", "master");
  git(work, "branch", "feature/existing");

  const other = path.join(base, "upstream-clone");
  git(base, "clone", "--quiet", originBare, other);
  configure(other);
  fs.writeFileSync(path.join(other, "upstream.txt"), "landed upstream\n");
  git(other, "add", "-A");
  git(other, "commit", "--quiet", "-m", "upstream: add upstream.txt");
  git(other, "push", "--quiet", "origin", "master");

  fs.writeFileSync(path.join(work, "app.js"), "console.log('one');\nconsole.log('two');\n");
  fs.writeFileSync(path.join(work, "notes.md"), "a brand new file\n");
  return work;
}

/** Point the instance's recent-repo list at the fixture so the console's picker offers it, and park a
 *  task in that repo so the "open on the selected task's repo" path has something to select. Both are
 *  read live (no restart needed); the task is left in `review` so nothing tries to run an agent. */
function seedRepoAndTask(dataDir, repo) {
  const db = new Database(path.join(dataDir, "orchestrator.sqlite"));
  db.prepare("INSERT INTO kv(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run("setting_recent_repos", JSON.stringify([repo]));
  const now = Date.now();
  db.prepare(
    "INSERT INTO threads (id, title, state, workspace, brief, raw_prompt, created_at, updated_at) VALUES (?, ?, 'review', ?, ?, ?, ?, ?)",
  ).run(TASK_ID, "Sample project task", repo, "a seeded task", "a seeded task", now, now);
  db.close();
}

const TASK_ID = "git-lab-task-0000";

// ---- the drive -------------------------------------------------------------------------------------

const results = [];
function check(label, cond, detail) {
  results.push({ label, ok: !!cond, detail });
  console.log(`  ${cond ? "✓" : "✗"} ${label}${detail && !cond ? ` — ${detail}` : ""}`);
}

/** Wait for the activity strip to leave "running git…" and settle on an outcome. */
async function settle(page) {
  await page.waitForFunction(
    () => !document.querySelector(".gc-activity.busy") && !!document.querySelector(".gc-activity.ok, .gc-activity.err, .gc-activity.note"),
    null,
    { timeout: 90_000 },
  );
  const cls = await page.getAttribute(".gc-activity", "class");
  return { outcome: /\bok\b/.test(cls) ? "ok" : /\berr\b/.test(cls) ? "err" : "note", text: (await page.textContent(".gc-activity")) ?? "" };
}

async function drive(page, work, keep) {
  const git = (...args) => execFileSync("git", args, { cwd: work, encoding: "utf8" }).trim();

  const errors = [];
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("dialog", (d) => d.accept()); // the Discard confirmation

  await page.request.post(`${BASE}/api/login`, { data: { password: authPassword() } });
  await page.goto(`${BASE}/`);
  await page.waitForSelector(".topbar", { timeout: 20_000 });

  console.log("\nOPEN — the top-bar button and the console window");
  check("the Git button is in the top bar", await page.isVisible('[aria-label="Open Git"]'));
  await page.click('[aria-label="Open Git"]');
  await page.waitForSelector(".gc-window", { timeout: 10_000 });
  check("it opens the console", await page.isVisible(".gc-window"));

  console.log("\nAUTO-PICK — opening from a task lands in that task's repo");
  // Remember a DIFFERENT repo as the last one used, so landing on the task's repo can only be the
  // task preference winning — not the fallback happening to agree.
  await page.evaluate(() => localStorage.setItem("orch-git-console-repo", "C:\\claude-orchestrator"));
  await page.click(".gc-close");
  await page.click('.card:has-text("Sample project task")');
  await page.waitForSelector(".detail-head", { timeout: 10_000 });
  await page.click('[aria-label="Open Git"]');
  await page.waitForSelector(".gc-window", { timeout: 10_000 });
  await page.waitForSelector('.gc-pick-value:text-is("sample-project")', { timeout: 15_000 }).catch(() => {});
  const landed = await page.$$eval(".gc-pick-value", (els) => els.map((e) => e.textContent));
  check("it opened on the selected task's repository", landed.includes("sample-project"), landed.join(","));
  // …and an explicit pick still wins over it, so the auto-pick can't fight the operator.
  await page.click('[aria-label="Choose a repository"]');
  await page.fill(".gc-menu-head .gc-filter", "claude-orchestrator");
  await page.click('.gc-menu-row:has(.gc-menu-name:text-is("claude-orchestrator"))');
  await page.waitForSelector('.gc-pick-value:text-is("claude-orchestrator")', { timeout: 15_000 });
  check("an explicit pick overrides the auto-pick", true);

  console.log("\nPICK — the repository picker (populated by discovery, not by typing paths)");
  await page.click('[aria-label="Choose a repository"]');
  await page.waitForSelector(".gc-menu-row");
  const repoNames = await page.$$eval(".gc-menu .gc-menu-name", (els) => els.map((e) => e.textContent));
  check("it lists the recent repo and this app's own checkout", repoNames.includes("sample-project") && repoNames.includes("claude-orchestrator"), repoNames.join(","));
  // Discovery is the whole point: repos nobody configured must appear under their own heading.
  check("it discovered repositories on disk", await page.isVisible('.gc-menu-sep:has-text("Found on disk")'));
  check("…more than just the configured ones", repoNames.length > 2, `${repoNames.length} listed`);
  await page.screenshot({ path: path.join(SERVER_ROOT, "data", "git-console-repos.png") });
  await page.fill(".gc-menu-head .gc-filter", "sample-pro");
  check("the filter narrows a long list", (await page.$$eval(".gc-menu-row", (e) => e.length)) === 1, String(await page.$$eval(".gc-menu-row", (e) => e.length)));
  await page.click('.gc-menu-row:has(.gc-menu-name:text-is("sample-project"))');
  await page.waitForSelector('.gc-pick-value:text-is("sample-project")', { timeout: 10_000 });
  await page.waitForSelector(".gc-file", { timeout: 10_000 });
  const files = await page.$$eval(".gc-file .gc-name", (els) => els.map((e) => e.textContent).sort());
  check("the repo's real changes are listed", JSON.stringify(files) === JSON.stringify(["app.js", "notes.md"]), files.join(","));
  check("the current branch is shown", (await page.$$eval(".gc-pick-value", (e) => e.map((x) => x.textContent))).includes("master"));

  console.log("\nDIFF — the selected file's real patch");
  await page.click('.gc-file:has(.gc-name:text-is("app.js")) .gc-file-main');
  await page.waitForSelector(".diff-line.add", { timeout: 10_000 });
  check("the diff renders the added line", ((await page.textContent(".diff-line.add .diff-text")) ?? "").includes("two"));

  console.log("\nCOMMIT — only the ticked files");
  await page.uncheck('.gc-file:has(.gc-name:text-is("notes.md")) input[type="checkbox"]');
  await page.fill(".gc-commit-summary", "feat: log a second line");
  await page.fill(".gc-commit-body", "Committed from the orchestrator's Git console.");
  check("the button names the count and the branch", /Commit 1 file to/.test((await page.textContent(".gc-commit .gc-btn.primary")) ?? ""));
  await page.click(".gc-commit .gc-btn.primary");
  const commit = await settle(page);
  check("the commit succeeds", commit.outcome === "ok", commit.text);
  check("git recorded it", git("log", "-1", "--format=%s") === "feat: log a second line", git("log", "-1", "--format=%s"));
  check("the description became the body", git("log", "-1", "--format=%b").includes("Git console"));
  check("ONLY the ticked file was committed", git("show", "--name-only", "--format=", "HEAD") === "app.js", git("show", "--name-only", "--format=", "HEAD"));
  // The server sends fresh state BEFORE the outcome, so the list is correct the instant the strip settles.
  check(
    "the file list refreshed with the outcome, not after it",
    JSON.stringify(await page.$$eval(".gc-file .gc-name", (els) => els.map((e) => e.textContent))) === JSON.stringify(["notes.md"]),
  );

  console.log("\nHISTORY — open a commit and read its diff");
  await page.click('.gc-tab:has-text("History")');
  await page.waitForSelector(".gc-commit-row", { timeout: 10_000 });
  check("the commit is in the log", (await page.$$eval(".gc-commit-subject", (e) => e.map((x) => x.textContent))).includes("feat: log a second line"));
  check("an unpushed commit is tagged local", (await page.$$eval(".gc-tag.local", (e) => e.length)) >= 1);
  await page.click('.gc-commit-row:has(.gc-commit-subject:text-is("feat: log a second line"))');
  await page.waitForSelector(".gc-detail-file", { timeout: 10_000 });
  check("it lists the file it touched", JSON.stringify(await page.$$eval(".gc-detail-file-name", (e) => e.map((x) => x.textContent))) === JSON.stringify(["app.js"]));
  await page.waitForSelector(".gc-commit-detail .diff-line.add", { timeout: 10_000 });
  check("and renders that commit's own diff", ((await page.textContent(".gc-commit-detail .diff-line.add .diff-text")) ?? "").includes("two"));

  console.log("\nFETCH / PULL — including the diverged refusal and the rebase it names");
  await page.click('.gc-sync .gc-btn:has-text("Fetch")');
  await settle(page);
  await page.waitForSelector(".gc-split-main .gc-btn-count", { timeout: 15_000 });
  check("Fetch surfaces the upstream commit as 1 behind", (await page.textContent(".gc-split-main .gc-btn-count")) === "1");

  await page.click(".gc-split-main");
  const ff = await settle(page);
  check("a fast-forward Pull is refused on a diverged branch", ff.outcome === "err", ff.text);
  check("…and the refusal names Pull (rebase)", /Pull \(rebase\)/i.test(ff.text), ff.text);
  await page.click('[aria-label="More pull options"]');
  await page.waitForSelector('.gc-menu-action:has-text("Pull (rebase)")', { timeout: 5_000 });
  check("…which the Pull menu actually offers", true);
  await page.click('.gc-menu-action:has-text("Pull (rebase)")');
  const rebase = await settle(page);
  check("Pull (rebase) succeeds", rebase.outcome === "ok", rebase.text);
  check("the upstream commit is now in history", git("log", "--oneline", "-5").includes("upstream: add upstream.txt"));
  check("history stayed linear", git("rev-list", "--count", "--merges", "HEAD") === "0");

  console.log("\nPUSH");
  check("Push shows the outgoing count", /1/.test((await page.textContent('.gc-sync .gc-btn:has-text("Push")')) ?? ""));
  await page.click('.gc-sync .gc-btn:has-text("Push")');
  const push = await settle(page);
  check("Push succeeds", push.outcome === "ok", push.text);
  check("origin has the commit", git("rev-parse", "HEAD") === git("rev-parse", "origin/master"));

  console.log("\nBRANCHES — switch, then create");
  await page.click('[aria-label="Choose a branch"]');
  await page.waitForSelector(".gc-branch-row");
  await page.click('.gc-menu-row:has(.gc-menu-name:text-is("feature/existing"))');
  await settle(page);
  check("switching moves HEAD", git("rev-parse", "--abbrev-ref", "HEAD") === "feature/existing", git("rev-parse", "--abbrev-ref", "HEAD"));
  await page.waitForSelector('.gc-pick-value:text-is("feature/existing")', { timeout: 10_000 });
  await page.click('[aria-label="Choose a branch"]');
  await page.click('.gc-menu-action:has-text("New branch")');
  await page.fill(".gc-new-branch .gc-filter", "feature/from-console");
  await page.click('.gc-new-branch .gc-btn:has-text("Create")');
  await settle(page);
  check("creating a branch checks it out", git("rev-parse", "--abbrev-ref", "HEAD") === "feature/from-console", git("rev-parse", "--abbrev-ref", "HEAD"));

  console.log("\nDISCARD");
  await page.click('.gc-tab:has-text("Changes")');
  await page.waitForSelector(".gc-file", { timeout: 10_000 });
  await page.click('.gc-link:has-text("Discard")');
  const discard = await settle(page);
  check("Discard succeeds", discard.outcome === "ok", discard.text);
  check("the untracked file is gone from disk", git("status", "--porcelain") === "", git("status", "--porcelain"));

  console.log("\nOPEN ON THE WEB — the remote becomes a browser link");
  // The fixture's origin is a local bare repo, which has no web page — so the button is correctly
  // absent until the remote points at a host.
  check("no Open button for a remote with no web page", (await page.$('a.gc-btn:has-text("Open")')) === null);
  execFileSync("git", ["remote", "set-url", "origin", "git@github.com:Fearce/sample.git"], { cwd: work });
  await page.click('.gc-sync .gc-btn:has-text("Fetch")'); // any action re-reads the repo
  await settle(page);
  const href = await page.getAttribute('a.gc-btn:has-text("Open")', "href");
  check("an Open link appears, deep-linked to the current branch", href === "https://github.com/Fearce/sample/tree/feature/from-console", String(href));
  check("it opens in a new tab", (await page.getAttribute('a.gc-btn:has-text("Open")', "target")) === "_blank");

  const shot = path.join(SERVER_ROOT, "data", "git-console.png");
  await page.screenshot({ path: shot });
  check("no console errors during the whole drive", errors.length === 0, errors.slice(0, 3).join(" | "));
  console.log(`\n  screenshot: ${shot}${keep ? `\n  fixture repo: ${work}\n  instance: ${BASE}` : ""}`);
}

// ---- run --------------------------------------------------------------------------------------------

(async () => {
  const keep = process.argv.includes("--keep");
  requireBuild();
  killInstance(); // a previous --keep run may still hold the port

  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "git-lab-"));
  const fixtureBase = fs.mkdtempSync(path.join(os.tmpdir(), "git-lab-repo-"));
  const work = buildFixture(fixtureBase);

  let browser;
  try {
    await boot(dataDir);
    seedRepoAndTask(dataDir, work);
    browser = await loadChromium().launch();
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await drive(page, work, keep);
  } finally {
    if (browser) await browser.close().catch(() => {});
    if (!keep) {
      killInstance();
      fs.rmSync(dataDir, { recursive: true, force: true });
      fs.rmSync(fixtureBase, { recursive: true, force: true });
    }
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length} passed, ${failed.length} failed`);
  if (failed.length > 0) {
    console.log("\nFailures:");
    for (const f of failed) console.log(`  - ${f.label}${f.detail ? ` — ${f.detail}` : ""}`);
    process.exit(1);
  }
})().catch((e) => {
  console.error(e);
  killInstance();
  process.exit(1);
});
