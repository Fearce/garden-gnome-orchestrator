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

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Database = require("better-sqlite3");
const { loadChromium, authPassword, requireBuild, boot, killInstance } = require("./lab-harness.cjs");

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
  const out = { scenario: "lapsed-weekly", widths: [1280, 1440, 1600, 1750, 1800, 1920], keep: false, list: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--list") out.list = true;
    else if (a === "--keep") out.keep = true;
    else if (a === "--scenario") out.scenario = argv[++i];
    else if (a === "--widths") out.widths = argv[++i].split(",").map((s) => parseInt(s.trim(), 10)).filter(Boolean);
  }
  return out;
}

/** The account identities the strip renders. Labels matter here (they're what the chip shows), so this
 *  lab pins them rather than taking the harness's bare bogus-token defaults. */
const ACCOUNT_ENV = {
  ACCOUNT_1_ID: "acct1",
  ACCOUNT_1_LABEL: "personal",
  ACCOUNT_2_ID: "acct2",
  ACCOUNT_2_LABEL: "secondary",
};

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
    await boot({ dataDir, port: PORT, env: ACCOUNT_ENV });
    killInstance(PORT);
    seed(dataDir, args.scenario);
    await boot({ dataDir, port: PORT, env: ACCOUNT_ENV });

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
    killInstance(PORT);
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
    killInstance(PORT);
    process.exit(1);
  },
);
