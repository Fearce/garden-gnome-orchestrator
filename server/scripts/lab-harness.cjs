// Shared plumbing for the "labs" — the tools that verify a console surface by booting a THROWAWAY
// orchestrator and driving it in a real browser (`chip-lab.cjs`, `git-console-lab.cjs`).
//
// A lab exists because a typecheck, a unit gate and a `grep` of the bundle can all be green over a
// surface that doesn't actually work, while prod is off-limits to drive (it is frequently modal-blocked
// by a real pending question, and clicking it mutates real state). So each lab stands up its own
// instance against its own temp DATA_DIR, seeds exactly the state it wants to see, and clicks freely.
//
// Everything below is the part that is identical for every lab and easy to get subtly wrong. Reach for
// this before hand-rolling a throwaway instance — hand-rolling one is how this session started, and it
// cost several tool calls and one stale-server confusion before the lab existed.
//
// ---- The cookbook for whoever writes the next lab (kept HERE because this is the file every lab
//      requires) ----
//   • Wait for the socket's `hello`, not for the shell to mount. Everything server-authoritative
//     (settings, accounts, any broadcast collection) renders NEUTRAL DEFAULTS until that frame lands, so
//     a check that opens on `.topbar` reads a toggle as "off" and a list as empty on a busy box — which
//     is indistinguishable from the feature being broken. `.accounts .acct` is hello-only ⇒ the signal.
//   • Lazy views: wait for their VISIBLE panel, not a fixed delay after the navigation click.
//     Retained panels may still exist under `hidden`; DOM presence alone doesn't prove navigation.
//   • A diff's `.diff` shell also wraps "Loading diff…". For a fixture with known changes, wait for
//     `.diff-line.add` / `.diff-line.del` before assertions or screenshots. After push/fetch, wait for
//     the refreshed ahead/behind state too; an action result can arrive before the new repo snapshot.
//   • Cache checks need evidence of reuse: count API reads and verify the same editor/panel instance
//     survives tool switches. A quick second click alone doesn't establish that caching worked.
//   • Never believe an optimistic control: a settings switch flips its own `aria-checked` before the
//     round-trip (`store.setSettings`), so re-reading it proves nothing and reloading straight after
//     races the write. Poll the instance's own kv row read-only (`waitForPersisted`, model-select-lab).
//   • Selectors: gear `[aria-label="Open settings"]` → `[role="dialog"][aria-label="Settings"]`; Git
//     console `[aria-label="Open Git"]` → `.gc-window`; a task row `.card`; the top bar `.topbar`.
//   • **Settings is CATEGORIZED — opening the dialog is not enough.** Only the active category's page is
//     visible (the others carry `hidden`), and it opens on General. A control on any other page is in
//     the DOM but never visible, so `waitForSelector`/`click` times out and reads as a broken selector.
//     Click its category first: `[data-settings-category="<id>"]` — `general` · `pipeline` · `usage` ·
//     `subscriptions` · `free-ai` · `voice-alerts` · `office` · `appearance` · `interface`. Below 900px the rail is
//     replaced by `.settings-mobile-nav select[aria-label="Settings category"]` (`selectOption`).
//   • **Close an overlay the way the app closes it — Escape is not universal.** The office panel
//     (`.office-panel`, opened from the top-bar strip) has NO key handler: only its `.office-scrim` or
//     `.close-x` closes it, and that scrim covers the whole app. So an `Escape` that works on the
//     Settings dialog leaves the office panel open, and every later click is silently eaten by the
//     scrim — Playwright reports "<div class=office-scrim> intercepts pointer events" and retries for
//     the full timeout, which reads as a broken selector rather than an unclosed overlay. Click the
//     real control and `waitForSelector(..., {state:"detached"})` before moving on.
//   • `has-text` is a SUBSTRING match, so adding a button can break an existing selector (strict-mode
//     violation: "Auto-review & mark done" also matches `has-text("Mark done")`) — use `text-is` then.
//   • State badges are CSS-uppercased (`.detail-head .badge`): the DOM reads `AUTO-REVIEW`, so compare
//     case-insensitively, never against the `stateLabel` string.
//   • Clipboard in headless chromium needs context `permissions:["clipboard-read","clipboard-write"]`
//     AND a `writeText` stub (`window.__copied = t`) — `readText()` alone can be gated.
//   • A touch change needs a TOUCH context (`tablet-lab`, `phone-lab`, or `ide-lab`): `hasTouch`/`isMobile` are `newContext()`
//     options, not viewport ones, and they are what make Chromium report `pointer: coarse` /
//     `hover: none`. A viewport resize alone keeps a FINE pointer and misses touch-specific rules.
//   • Test uncommitted server work in an isolated output directory, without replacing live dist:
//     from server/, `npx tsc -p tsconfig.json --outDir .ide-lab-dist`, then set GGO_LAB_ENTRY to
//     `.ide-lab-dist/index.js` for the lab process. Both requireBuild() and boot() honor that entry;
//     an explicit entry argument overrides the environment. ide-lab compiles its own isolated build.
//     Web gets the same treatment: `npm run build:lab --prefix web` writes `server/.lab-web-dist`, and
//     GGO_LAB_WEB_DIST=.lab-web-dist points requireBuild() and the instance (via WEB_DIST) at it, so
//     prod's web auto-builder cannot replace the bundle mid-measurement. Without it the lab serves the
//     checkout's web/dist. Either way the instance never runs its own web auto-builder (labChildEnv).
//     build:lab empties its one directory, so two labs running at once need one each: from web/,
//     `npx vite build --outDir ../server/.lab-web-dist-<lab> --emptyOutDir` + the matching variable.
//     An isolated lab proves behavior, not deployment; verify the live revision after committing.
//   • Assert `getComputedStyle`, never the CSS rule you wrote: `main.tsx` loads `styles.css` FIRST, so
//     `gitChanges.css` / `gitConsole.css` / `diff.css` land later in the bundle and win ties.
//   • Playwright's `locator.boundingBox()` returns `{x,y,width,height}`, NOT a DOMRect. `right` and
//     `bottom` are undefined, so a correct layout fails a naive bounds assertion. Use `boxBounds()`
//     below (or return `getBoundingClientRect()` fields from `page.evaluate`) before comparing edges.
//   • Don't wrap a lab in `timeout` — it SIGTERMs the whole npm child tree, so `--keep`'s instance dies
//     with it. Give the Bash call a long timeout, or background it and poll the port.
//   • **Seed AFTER `boot()`, never before.** The schema is created by the server's own `Db`
//     constructor, so a seed that opens the temp sqlite first dies on `no such table: threads`. Every
//     existing lab does it in this order; it is not obvious from reading one, because the seeding block
//     sits visually above the assertions it feeds.
//   • **Filler rows paginate your fixture off the board.** The task list is paged (`PER_PAGE`), so
//     seeding a few hundred threads to push something past a bound leaves `.card:has-text(...)` timing
//     out on a task that exists and is simply on page 4. Seed filler as `state:"closed"` — closed tasks
//     get their own collapsed section, while `agent_runs` are carried by the connect snapshot
//     regardless of task state, which is usually the thing the filler was for.
//   • **A reload does not re-select the open task.** `selectedThreadId` is not persisted, so a
//     lab checking that something survives `page.reload()` must click the card again before asserting;
//     otherwise the feed is genuinely empty and the failure looks like the regression you were hunting.
//   • Wrap a long `waitForFunction` in try/catch and report the miss through `check(...)`. An
//     uncaught Playwright timeout kills the run with a stack naming a selector, not a claim, and
//     every later assertion goes unrun — the `[crashed]`-vs-`[reported]` distinction from
//     `threadmanager-itest.md`, in browser form.
//   • Screenshots go through `shotDir(dataDir)`, so `-- --shots <dir>` lands them somewhere that still
//     exists after the run. A lab deletes its temp DATA_DIR on the way out, which takes the evidence
//     with it — and an implementor now has to SURFACE that evidence as a deliverable, so without the
//     flag the only way to keep a picture is a second full run with `--keep` plus a manual port kill.
//     Point it INSIDE `data/` (`-- --shots data/<lab>-shots`): a deliverable has to outlive the run, so
//     the pictures stay on disk forever, and `server/data/` is the one place already gitignored. Any
//     other path leaves them untracked in a checkout several agents share — permanent `git status`
//     noise that the nightly sweep reports as dirty and that lands in the gate-provenance stamp.
//   • `boot()` takes TWO ports: `port` and the HTTPS listener at `port + 2`. A lab that stands up a
//     COMPANION service (office-lab's relay) must avoid both. Landing on `port + 2` does not fail
//     loudly — the console's TLS socket answers the companion's plain-HTTP request, and the only clue
//     is `fetch failed`, whose real reason ("Response does not match the HTTP/1.1 protocol") is on
//     `e.cause`, never on `e.message`. Always unwrap `cause` before believing a `fetch failed`.
//
// The four traps it encodes, all of which bite silently:
//   • ACCOUNT_i_TOKEN must be BOGUS. A live token makes the boot ping start a REAL 5h window and shift
//     the reset stagger — corrupting the production account state you were only trying to look at.
//   • Kill by PORT OWNER, never by process name: `pkill -f "node dist/index.js"` is a silent no-op in
//     Git Bash on Windows AND would match prod's node if it worked.
//   • NODE_PATH is unset in agent shells, so a bare `require("playwright")` misses the global install.
//   • CLOSE EACH CONTEXT BEFORE OPENING THE NEXT. A lab measures what a console does when nothing is
//     happening to it, so a context you forgot to close is not untidiness: it is a second console
//     holding a socket, running timers and going idle on its own schedule, and it misbehaves in a
//     LATER step rather than where it leaked. `screensaver-lab` closed its main context only on the
//     `--video` path (closing is what flushes a recording), failed 2 runs in 3 at two different
//     steps, and the fix for that still missed two more contexts in the same file. `loadChromium`
//     here is wrapped by `labContextGuard.cjs`, which now refuses the second one and names where the
//     first was opened; `allowConcurrentContexts()` opts out when two live consoles ARE the point.
//     It watches contexts you create explicitly, not the one behind `browser.newPage()`: real
//     Playwright builds a page's context through the public `newContext`, so guarding that too reds
//     every lab that simply opens two pages. Gate: `test:lab-contexts`.

const { spawn, execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const Database = require("better-sqlite3");

const SERVER_ROOT = path.resolve(__dirname, "..");

/** The globally-installed Playwright, found without NODE_PATH. Shared with the web/ probes, so the
 *  search order can never drift between them again (see `findPlaywright.cjs` for why it bit). */
const { loadChromium: resolveChromium } = require("./findPlaywright.cjs");
const { guardConcurrentContexts, allowConcurrentContexts } = require("./labContextGuard.cjs");

/** The same Playwright, with the two-live-contexts guard armed. Labs reach Playwright through this
 *  module rather than `findPlaywright.cjs` directly, so the guard costs no lab an edit of its own;
 *  `labContextGuard.cjs` explains which failure it is there to prevent. */
function loadChromium() {
  return guardConcurrentContexts(resolveChromium());
}

/** The real console password, so a lab can log its browser in. The throwaway instance inherits
 *  `server/.env`, so this is the password it will actually accept. */
function authPassword() {
  const line = fs
    .readFileSync(path.join(SERVER_ROOT, ".env"), "utf8")
    .split(/\r?\n/)
    .find((l) => /^AUTH_PASSWORD=/.test(l));
  return line ? line.slice("AUTH_PASSWORD=".length).trim() : "";
}

/** Resolve relative entries from the same cwd used by the child process. */
function labEntry(entry = process.env.GGO_LAB_ENTRY || "dist/index.js") {
  return path.resolve(SERVER_ROOT, entry);
}

/** The web bundle the lab instance serves: the checkout's `web/dist`, or an isolated build named by
 *  GGO_LAB_WEB_DIST (resolved from server/, like GGO_LAB_ENTRY). */
function labWebDist() {
  const pinned = process.env.GGO_LAB_WEB_DIST;
  return pinned ? path.resolve(SERVER_ROOT, pinned) : path.resolve(SERVER_ROOT, "..", "web", "dist");
}

/** How to refresh labWebDist(). A plain web build writes the LIVE console's bundle, so never
 *  suggest it for a pinned lab. */
function webRebuildHint() {
  if (labWebDist() === path.resolve(SERVER_ROOT, ".lab-web-dist")) return "run `npm run build:lab --prefix web`";
  if (process.env.GGO_LAB_WEB_DIST) return "rebuild that bundle (from web/: `npx vite build --outDir <it> --emptyOutDir`)";
  return "run `npm run build --prefix web`";
}

/** Validate the bundle the lab will actually boot, including isolated server and web builds. */
function requireBuild(entry) {
  for (const file of [labEntry(entry), path.join(labWebDist(), "index.html")]) {
    if (!fs.existsSync(file)) {
      console.error(`missing ${file} — compile the selected server entry and build web before running the lab.`);
      process.exit(2);
    }
  }
}

/** The lab instance's environment. WEB_DIST is always set: it pins the bundle AND switches off the
 *  instance's own web auto-builder, which would otherwise rebuild the live console's web/dist. */
function labChildEnv({ dataDir, port, env = {} }) {
  return {
    ...process.env,
    DATA_DIR: dataDir,
    PORT: String(port),
    HTTPS_PORT: String(port + 2),
    ACCOUNT_1_TOKEN: "lab-not-a-real-token",
    ACCOUNT_2_TOKEN: "lab-not-a-real-token",
    CLAUDE_CODE_OAUTH_TOKEN: "lab-not-a-real-token",
    WEB_DIST: labWebDist(),
    ...env,
  };
}

/** Boot a throwaway instance on `port` against `dataDir`, resolving once it answers `/api/me`.
 *  Account tokens are overridden with a bogus value (see the header); `env` adds anything else the
 *  lab needs. Its log lands in `<dataDir>/lab.log` — read it when a boot times out. */
async function boot({ dataDir, port, env = {}, entry }) {
  const child = spawn(process.execPath, [labEntry(entry)], {
    cwd: SERVER_ROOT,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
    env: labChildEnv({ dataDir, port, env }),
  });
  const log = fs.createWriteStream(path.join(dataDir, "lab.log"));
  child.stdout.pipe(log);
  child.stderr.pipe(log);
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 500));
    try {
      if ((await fetch(`http://127.0.0.1:${port}/api/me`)).ok) return child;
    } catch {
      /* not listening yet */
    }
  }
  throw new Error(`instance never came up — see ${path.join(dataDir, "lab.log")}`);
}

/**
 * Wait until a setting mutation has crossed the WebSocket round-trip and is durable in this
 * throwaway instance. Settings controls update optimistically, so their rendered state alone
 * cannot prove persistence; querying the lab's own SQLite KV row is read-only and WAL-safe.
 */
async function waitForPersisted(dataDir, key, expected, timeoutMs = 15_000) {
  const file = path.join(dataDir, "orchestrator.sqlite");
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const db = new Database(file, { readonly: true });
    const row = db.prepare("SELECT value FROM kv WHERE key = ?").get(key);
    db.close();
    if (row && (expected === undefined || row.value === expected)) return row.value;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return null;
}

/**
 * A reconnect reads the server's `hello` snapshot cache, whose two-second TTL intentionally keeps
 * a burst of browser tabs from rebuilding the full snapshot. Persisting a setting proves the write,
 * but not that a page reloaded immediately afterward receives the new snapshot. Use this before
 * reload/reconnect assertions; keep it aligned with HELLO_CACHE_MS in src/ws/hub.ts.
 */
async function waitForSettingsReloadSafe(dataDir, key, expected, timeoutMs = 15_000) {
  const stored = await waitForPersisted(dataDir, key, expected, timeoutMs);
  if (stored === null) return null;
  await new Promise((resolve) => setTimeout(resolve, 2_100));
  return stored;
}

/** Refuse to run when `web/dist` is older than `web/src`: the lab would measure the PREVIOUS bundle
 *  and report it as the current one, which is the failure a lab exists to rule out. */
function requireFreshWebBuild() {
  const webRoot = path.resolve(SERVER_ROOT, "..", "web");
  const built = fs.statSync(path.join(labWebDist(), "index.html")).mtimeMs;
  let newest = 0;
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else newest = Math.max(newest, fs.statSync(p).mtimeMs);
    }
  };
  walk(path.join(webRoot, "src"));
  if (newest > built) {
    console.error(`${labWebDist()} is older than web/src — ${webRebuildHint()} first, or this lab measures the previous bundle.`);
    process.exit(2);
  }
}

/** Kill whatever owns `port`. Precise, and cannot touch prod on :4317. */
function killInstance(port) {
  try {
    execFileSync(
      "powershell",
      [
        "-NoProfile",
        "-Command",
        `Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue | Select-Object -Expand OwningProcess -Unique | ForEach-Object { Stop-Process -Id $_ -Force }`,
      ],
      { stdio: "ignore", windowsHide: true },
    );
  } catch {
    /* already gone */
  }
}

/** A pass/fail line collector, so every lab reports in the same shape and exits non-zero on failure. */
function createChecks() {
  const results = [];
  const check = (label, cond, detail) => {
    results.push({ label, ok: !!cond, detail });
    console.log(`  ${cond ? "✓" : "✗"} ${label}${detail && !cond ? ` — ${detail}` : ""}`);
  };
  check.summary = () => {
    const failed = results.filter((r) => !r.ok);
    console.log(`\n${results.length - failed.length} passed, ${failed.length} failed`);
    if (failed.length === 0) return 0;
    console.log("\nFailures:");
    for (const f of failed) console.log(`  - ${f.label}${f.detail ? ` — ${f.detail}` : ""}`);
    return 1;
  };
  return check;
}

/** Convert Playwright's `{x,y,width,height}` bounding box into named viewport edges. Returning null
 * for a missing/non-finite box lets a geometry check fail through `createChecks` with useful detail
 * instead of accidentally passing arithmetic over `undefined`. */
function boxBounds(box) {
  if (!box || ![box.x, box.y, box.width, box.height].every(Number.isFinite)) return null;
  return {
    left: box.x,
    top: box.y,
    right: box.x + box.width,
    bottom: box.y + box.height,
    width: box.width,
    height: box.height,
  };
}

/**
 * Where this run's screenshots belong: `--shots <dir>` when the caller wants to keep them, else the
 * lab's own temp DATA_DIR (deleted on exit, which is the right default for a gate nobody is watching).
 * The directory is created here so a lab never has to care which of the two it got.
 */
function shotDir(dataDir) {
  // Both spellings: `layout-lab` already took `--shot <dir>`, and one of the two is what the next agent
  // will type. Guessing wrong would silently drop the screenshots back into the temp dir it deletes.
  const at = Math.max(process.argv.indexOf("--shots"), process.argv.indexOf("--shot"));
  const chosen = at >= 0 && process.argv[at + 1] ? path.resolve(process.argv[at + 1]) : dataDir;
  fs.mkdirSync(chosen, { recursive: true });
  return chosen;
}

module.exports = { SERVER_ROOT, loadChromium, allowConcurrentContexts, authPassword, labWebDist, labChildEnv, requireBuild, requireFreshWebBuild, boot, waitForPersisted, waitForSettingsReloadSafe, killInstance, createChecks, boxBounds, shotDir };
