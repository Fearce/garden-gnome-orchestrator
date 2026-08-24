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
//      requires, and because .claude/rules/verify-a-ui-change-shipped.md has a 60-line budget) ----
//   • Wait for the socket's `hello`, not for the shell to mount. Everything server-authoritative
//     (settings, accounts, any broadcast collection) renders NEUTRAL DEFAULTS until that frame lands, so
//     a check that opens on `.topbar` reads a toggle as "off" and a list as empty on a busy box — which
//     is indistinguishable from the feature being broken. `.accounts .acct` is hello-only ⇒ the signal.
//   • Never believe an optimistic control: a settings switch flips its own `aria-checked` before the
//     round-trip (`store.setSettings`), so re-reading it proves nothing and reloading straight after
//     races the write. Poll the instance's own kv row read-only (`waitForPersisted`, model-select-lab).
//   • Selectors: gear `[aria-label="Open settings"]` → `[role="dialog"][aria-label="Settings"]`; Git
//     console `[aria-label="Open Git"]` → `.gc-window`; a task row `.card`; the top bar `.topbar`.
//   • `has-text` is a SUBSTRING match, so adding a button can break an existing selector (strict-mode
//     violation: "Auto-review & mark done" also matches `has-text("Mark done")`) — use `text-is` then.
//   • State badges are CSS-uppercased (`.detail-head .badge`): the DOM reads `AUTO-REVIEW`, so compare
//     case-insensitively, never against the `stateLabel` string.
//   • Clipboard in headless chromium needs context `permissions:["clipboard-read","clipboard-write"]`
//     AND a `writeText` stub (`window.__copied = t`) — `readText()` alone can be gated.
//   • A touch change needs `tablet-lab` and ONLY `tablet-lab`: `hasTouch`/`isMobile` are `newContext()`
//     options, not viewport ones, and they are what make Chromium report `pointer: coarse` /
//     `hover: none`. Every other lab runs a FINE pointer and is blind to `styles.css`'s touch blocks.
//   • Assert `getComputedStyle`, never the CSS rule you wrote: `main.tsx` loads `styles.css` FIRST, so
//     `gitChanges.css` / `gitConsole.css` / `diff.css` land later in the bundle and win ties.
//   • Don't wrap a lab in `timeout` — it SIGTERMs the whole npm child tree, so `--keep`'s instance dies
//     with it. Give the Bash call a long timeout, or background it and poll the port.
//   • `boot()` takes TWO ports: `port` and the HTTPS listener at `port + 2`. A lab that stands up a
//     COMPANION service (office-lab's relay) must avoid both. Landing on `port + 2` does not fail
//     loudly — the console's TLS socket answers the companion's plain-HTTP request, and the only clue
//     is `fetch failed`, whose real reason ("Response does not match the HTTP/1.1 protocol") is on
//     `e.cause`, never on `e.message`. Always unwrap `cause` before believing a `fetch failed`.
//
// The three traps it encodes, all of which bite silently:
//   • ACCOUNT_i_TOKEN must be BOGUS. A live token makes the boot ping start a REAL 5h window and shift
//     the reset stagger — corrupting the production account state you were only trying to look at.
//   • Kill by PORT OWNER, never by process name: `pkill -f "node dist/index.js"` is a silent no-op in
//     Git Bash on Windows AND would match prod's node if it worked.
//   • NODE_PATH is unset in agent shells, so a bare `require("playwright")` misses the global install.

const { spawn, execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const SERVER_ROOT = path.resolve(__dirname, "..");

/** The globally-installed Playwright, found without NODE_PATH. */
function loadChromium() {
  for (const mod of [process.env.PLAYWRIGHT_PATH, "playwright", "playwright-core"].filter(Boolean)) {
    try {
      return require(mod).chromium;
    } catch {
      /* try the next candidate */
    }
  }
  const root = execFileSync("npm", ["root", "-g"], { shell: true }).toString().trim();
  return require(path.join(root, "playwright")).chromium;
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

/** A lab drives the BUILT bundle, not the sources — fail loudly rather than testing a stale one. */
function requireBuild() {
  for (const rel of ["dist/index.js", "../web/dist/index.html"]) {
    if (!fs.existsSync(path.resolve(SERVER_ROOT, rel))) {
      console.error(`missing ${rel} — run \`npm run build\` at the repo root first.`);
      process.exit(2);
    }
  }
}

/** Boot a throwaway instance on `port` against `dataDir`, resolving once it answers `/api/me`.
 *  Account tokens are overridden with a bogus value (see the header); `env` adds anything else the
 *  lab needs. Its log lands in `<dataDir>/lab.log` — read it when a boot times out. */
async function boot({ dataDir, port, env = {} }) {
  const child = spawn(process.execPath, [path.join(SERVER_ROOT, "dist", "index.js")], {
    cwd: SERVER_ROOT,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      DATA_DIR: dataDir,
      PORT: String(port),
      HTTPS_PORT: String(port + 2),
      ACCOUNT_1_TOKEN: "lab-not-a-real-token",
      ACCOUNT_2_TOKEN: "lab-not-a-real-token",
      CLAUDE_CODE_OAUTH_TOKEN: "lab-not-a-real-token",
      ...env,
    },
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
      { stdio: "ignore" },
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

module.exports = { SERVER_ROOT, loadChromium, authPassword, requireBuild, boot, killInstance, createChecks };
