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
