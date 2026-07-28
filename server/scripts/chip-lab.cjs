// Render the top-bar subscription strip in a chosen account state, headlessly, without touching prod
// or burning a single token — the missing half of `probe:accounts` (which reads state but can't show
// you the chip). Use it whenever you change accounts/accountManager.ts, Accounts.tsx, or the strip CSS.
//
//   npm run chip-lab --prefix server
//   npm run chip-lab --prefix server -- --scenario stagger-hold --widths 1280,1700 --keep
//   npm run chip-lab --prefix server -- --list
//
// What it does: boots a SECOND orchestrator on :4327 against a fresh temp DATA_DIR, seeds the
// account_usage_* kv blobs for the scenario, restarts it (bootPing only reads those blobs at boot),
// then drives a real browser — printing every meter's text + tooltip per width, asserting the strip
// isn't clipped, and leaving a screenshot behind.
//
// Why it can't disturb anything:
//   • DATA_DIR is a temp dir, so prod's orchestrator.sqlite is never opened and an empty thread table
//     means the on-boot auto-resume has nothing to resurrect (no real agents spawn).
//   • ACCOUNT_i_TOKEN is overridden with a BOGUS value, so AccountManager's boot ping can neither burn
//     quota nor START a real 5h window — which a live token WOULD do, silently wrecking the stagger
//     you are trying to observe. This is the trap that makes "just run a second instance" wrong here.
//   • Alt ports; the instance is killed by PORT owner (killing by process name would hit prod).
// The rest of server/.env still applies, so Codex/Grok/z.ai chips render exactly as they do in prod
// and the geometry you measure is the real one.

const { spawn, execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Database = require("better-sqlite3");

const SERVER_ROOT = path.resolve(__dirname, "..");
const PORT = 4327;
const BASE = `http://127.0.0.1:${PORT}`;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** Account snapshots keyed by the state a reviewer wants to see. `at` is the boot instant. */
const SCENARIOS = {
  healthy: (at) => ({ fiveHour: 34, sevenDay: 52, fiveHourReset: at + 2 * HOUR, sevenDayReset: at + 4 * DAY, usageAt: at - 60_000 }),
  // The 2026-07-28 bug: a weekly reset that elapsed inside a 5h stagger hold was never re-read, so the
  // chip kept a spent week's % with a BLANK countdown.
  "lapsed-weekly": (at) => ({ fiveHour: 0, sevenDay: 97, fiveHourReset: null, sevenDayReset: at - 60_000, usageAt: at - 5 * 60_000, holdUntil: at + 3 * HOUR }),
  // A normal staggered idle window — the "idle 2h 14m" reading operators mistake for a dead sub.
  "stagger-hold": (at) => ({ fiveHour: 0, sevenDay: 41, fiveHourReset: null, sevenDayReset: at + 5 * DAY, usageAt: at - 2 * 60_000, holdUntil: at + 2 * HOUR }),
  // No live read for ~an hour: meters keep the last values behind a "~" and the stale tag.
  stale: (at) => ({ fiveHour: 61, sevenDay: 77, fiveHourReset: at + 40 * 60_000, sevenDayReset: at + 2 * DAY, usageAt: at - 65 * 60_000 }),
  // Both windows nearly spent — the state that empties the failover ladder.
  capped: (at) => ({ fiveHour: 99, sevenDay: 99, fiveHourReset: at + 25 * 60_000, sevenDayReset: at + 6 * DAY, usageAt: at - 30_000 }),
};

function parseArgs(argv) {
  const out = { scenario: "lapsed-weekly", widths: [1280, 1440, 1600, 1700], keep: false, list: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--list") out.list = true;
    else if (a === "--keep") out.keep = true;
    else if (a === "--scenario") out.scenario = argv[++i];
    else if (a === "--widths") out.widths = argv[++i].split(",").map((s) => parseInt(s.trim(), 10)).filter(Boolean);
  }
  return out;
}

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

/** Boot the throwaway instance and resolve once it answers. Bogus tokens: see the header. */
async function boot(dataDir) {
  const child = spawn(process.execPath, [path.join(SERVER_ROOT, "dist", "index.js")], {
    cwd: SERVER_ROOT,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      DATA_DIR: dataDir,
      PORT: String(PORT),
      HTTPS_PORT: String(PORT + 2),
      ACCOUNT_1_TOKEN: "chip-lab-not-a-real-token",
      ACCOUNT_1_ID: "acct1",
      ACCOUNT_1_LABEL: "personal",
      ACCOUNT_2_TOKEN: "chip-lab-not-a-real-token",
      ACCOUNT_2_ID: "acct2",
      ACCOUNT_2_LABEL: "vota",
    },
  });
  const log = fs.createWriteStream(path.join(dataDir, "chip-lab.log"));
  child.stdout.pipe(log);
  child.stderr.pipe(log);
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 500));
    try {
      const res = await fetch(`${BASE}/api/me`);
      if (res.ok) return child;
    } catch {
      /* not listening yet */
    }
  }
  throw new Error(`instance never came up — see ${path.join(dataDir, "chip-lab.log")}`);
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

function seed(dataDir, scenario) {
  const db = new Database(path.join(dataDir, "orchestrator.sqlite"));
  const at = Date.now();
  const put = (id, usage) =>
    db
      .prepare("INSERT INTO kv(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
      .run(`account_usage_${id}`, JSON.stringify({ holdUntil: null, extWakeAt: null, ...usage }));
  put("acct1", SCENARIOS.healthy(at));
  put("acct2", SCENARIOS[scenario](at));
  db.close();
}

/** Every chip's meters plus the one geometry fact that matters: does the strip hide anything? */
async function readStrip(page) {
  return page.evaluate(() => {
    const strip = document.querySelector(".accounts");
    if (!strip) return { clipped: false, chips: [], reason: "no .accounts strip rendered" };
    return {
      clipped: strip.scrollWidth > strip.clientWidth + 2,
      box: `${strip.clientWidth}/${strip.scrollWidth}`,
      chips: [...strip.querySelectorAll(".acct")].map((el) => ({
        label: (el.querySelector(".acct-label")?.textContent || "").trim(),
        tags: [...el.querySelectorAll(".acct-tag")].map((t) => t.textContent.trim()),
        meters: [...el.querySelectorAll(".meter")].map((m) => ({
          k: m.querySelector(".meter-k")?.textContent?.trim(),
          v: m.querySelector(".meter-v")?.textContent?.trim(),
          r: m.querySelector(".meter-r")?.textContent?.trim() || "",
          tip: m.getAttribute("title"),
        })),
      })),
    };
  });
}

function report(width, strip) {
  const status = strip.clipped ? `CLIPPED ${strip.box}` : "fits";
  console.log(`\n  ${width}px — ${status}`);
  for (const c of strip.chips) {
    const tags = c.tags.length ? ` [${c.tags.join(", ")}]` : "";
    console.log(`    ${c.label}${tags}`);
    for (const m of c.meters) console.log(`      ${m.k.padEnd(3)} ${(m.v || "").padStart(5)}  ${m.r.padEnd(12)} ${m.tip ?? ""}`);
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.list) {
    console.log("scenarios: " + Object.keys(SCENARIOS).join(", "));
    return 0;
  }
  if (!SCENARIOS[args.scenario]) {
    console.error(`unknown scenario "${args.scenario}" — one of: ${Object.keys(SCENARIOS).join(", ")}`);
    return 2;
  }
  requireBuild();

  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "chip-lab-"));
  console.log(`chip-lab — scenario "${args.scenario}" on ${BASE} (data ${dataDir})`);
  let clipped = false;
  try {
    // First boot creates the schema; the snapshots are only read by bootPing, so seed and boot again.
    await boot(dataDir);
    killInstance();
    seed(dataDir, args.scenario);
    await boot(dataDir);

    const browser = await loadChromium().launch();
    const shot = path.join(dataDir, "strip.png");
    try {
      for (const width of args.widths) {
        const page = await browser.newPage({ viewport: { width, height: 800 } });
        await page.request.post(`${BASE}/api/login`, { data: { password: authPassword() } });
        await page.goto(`${BASE}/?chipLab=${width}`, { waitUntil: "networkidle" });
        await page.waitForSelector(".accounts .acct", { timeout: 20_000 });
        await page.waitForTimeout(1200);
        const strip = await readStrip(page);
        report(width, strip);
        clipped = clipped || strip.clipped;
        if (width === args.widths[0]) await page.screenshot({ path: shot, clip: { x: 0, y: 0, width, height: 130 } });
        await page.close();
      }
    } finally {
      await browser.close();
    }
    console.log(`\n  screenshot: ${shot}`);
  } finally {
    killInstance();
    if (args.keep) console.log(`  kept ${dataDir}`);
    else fs.rmSync(dataDir, { recursive: true, force: true });
  }
  if (clipped) {
    console.error("\nFAIL — the strip is clipped at one or more widths (widen the wrap breakpoint in web/src/styles.css).");
    return 1;
  }
  console.log("\nOK — every chip visible at every width.");
  return 0;
}

main().then(
  (code) => process.exit(code),
  (e) => {
    console.error(e);
    killInstance();
    process.exit(1);
  },
);
