/**
 * Unit gate - Codex usage reader cache.
 *
 * `readCodexUsage()` is on the dispatch hot path. A single uncached read recursively scans both Codex
 * session homes and parses recent rollout JSONL files, so routing must not repeat that work once per
 * provider/model while building a roster.
 *
 * Free: synthetic rollout files only, no DB/network/agent.
 * Run: npm run test:codex-usage (from server/)
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "codex-usage-"));
const home = join(root, "codex-home");
const sourceHome = join(root, "source-codex-home");
process.env.DATA_DIR = join(root, "data");
process.env.CODEX_HOME_DIR = home;
process.env.CODEX_SOURCE_HOME = sourceHome;

const {
  __codexUsageTestHooks,
  codexUsageCapped,
  noteCodexPing,
  noteCodexWake,
  readCodexUsage,
} = await import("../agents/codexUsage.js");

let passed = 0;
let failed = 0;
const failures: string[] = [];
function check(label: string, condition: boolean, detail?: string): void {
  if (condition) {
    passed++;
    console.log(`  PASS ${label}`);
  } else {
    failed++;
    failures.push(`${label}${detail ? ` - ${detail}` : ""}`);
    console.error(`  FAIL ${label}${detail ? ` - ${detail}` : ""}`);
  }
}

function writeRollout(targetHome: string, at: number, fiveHour: number, sevenDay: number): void {
  const dir = join(targetHome, "sessions", "2026", "08", "27");
  mkdirSync(dir, { recursive: true });
  const body = {
    timestamp: new Date(at).toISOString(),
    payload: {
      type: "token_count",
      rate_limits: {
        primary: {
          used_percent: fiveHour,
          window_minutes: 300,
          resets_at: Math.floor((at + 3_600_000) / 1000),
        },
        secondary: {
          used_percent: sevenDay,
          window_minutes: 7 * 24 * 60,
          resets_at: Math.floor((at + 24 * 3_600_000) / 1000),
        },
        plan_type: "pro",
      },
    },
  };
  writeFileSync(join(dir, `rollout-${at}.jsonl`), `${JSON.stringify(body)}\n`, "utf8");
}

try {
  console.log("\n=== Codex usage reader cache ===\n");
  const now = Date.now();
  writeRollout(home, now, 12, 34);
  __codexUsageTestHooks.reset();

  const first = readCodexUsage();
  const firstScanCount = __codexUsageTestHooks.rolloutScanCount();
  check("synthetic rollout is parsed", first?.fiveHour === 12 && first.sevenDay === 34, JSON.stringify(first));
  check("one cold read scans each configured home once", firstScanCount === 2, String(firstScanCount));

  for (let i = 0; i < 8; i++) {
    readCodexUsage();
    codexUsageCapped(Date.now());
  }
  check(
    "repeated route-style reads reuse the cached rollout scan",
    __codexUsageTestHooks.rolloutScanCount() === firstScanCount,
    `${__codexUsageTestHooks.rolloutScanCount()} vs ${firstScanCount}`,
  );

  if (first) first.fiveHour = 99;
  check("cached results are cloned before returning to callers", readCodexUsage()?.fiveHour === 12);

  const wakeAt = Date.now() + 60_000;
  noteCodexWake(wakeAt);
  const withWake = readCodexUsage();
  const afterWakeScanCount = __codexUsageTestHooks.rolloutScanCount();
  check("wake-plan changes invalidate the read cache", withWake?.wakeAt === wakeAt, JSON.stringify(withWake));
  check("the wake invalidation caused exactly one new two-home scan", afterWakeScanCount === firstScanCount + 2, String(afterWakeScanCount));
  readCodexUsage();
  check("reads after the wake invalidation are cached again", __codexUsageTestHooks.rolloutScanCount() === afterWakeScanCount);

  const liveAt = Date.now() + 1_000;
  noteCodexPing({
    fiveHour: 4,
    sevenDay: 5,
    fiveHourReset: liveAt + 2 * 3_600_000,
    sevenDayReset: liveAt + 3 * 24 * 3_600_000,
    planType: "pro",
    updatedAt: liveAt,
    pools: [{
      limitId: "codex",
      limitName: null,
      modelSlug: null,
      fiveHour: 4,
      sevenDay: 5,
      fiveHourReset: liveAt + 2 * 3_600_000,
      sevenDayReset: liveAt + 3 * 24 * 3_600_000,
    }],
  });
  const afterPingScanCount = __codexUsageTestHooks.rolloutScanCount();
  const live = readCodexUsage();
  check("live pings invalidate and replace a cached rollout reading", live?.fiveHour === 4 && live.pools?.length === 1, JSON.stringify(live));
  check("the live-ping persist read is cached for the next caller", __codexUsageTestHooks.rolloutScanCount() === afterPingScanCount);

  console.log(`\n=== RESULT: ${failed === 0 ? "PASS" : "FAIL"} - ${passed} passed, ${failed} failed ===`);
  if (failures.length) {
    for (const failure of failures) console.error(`  - ${failure}`);
  }
  process.exitCode = failed === 0 ? 0 : 1;
} finally {
  rmSync(root, { recursive: true, force: true });
}
