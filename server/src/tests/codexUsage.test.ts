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

import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
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
  noteCodexUsageError,
  noteCodexWake,
  readCodexUsage,
  readCodexUsageForSnapshot,
} = await import("../agents/codexUsage.js");
const { limitStateOf } = await import("../agents/codexUsagePing.js");

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

  // --- the presentation snapshot must never render a silent blank: with nothing read yet (no live
  // ping, no cache, no scan performed), it carries an explicit, honest reason instead of a bare null. ---
  const neverRead = readCodexUsageForSnapshot();
  check(
    "with nothing read yet, the snapshot is a real DTO (never null) carrying a default reason",
    neverRead != null && neverRead.error === "Codex usage has not been read yet",
    JSON.stringify(neverRead),
  );
  check(
    "the never-read snapshot carries no fabricated meter data",
    neverRead?.fiveHour == null && neverRead?.sevenDay == null,
    JSON.stringify(neverRead),
  );
  noteCodexUsageError("Codex CLI not found at /fake/path/codex.js (install it globally: npm install -g @openai/codex)");
  const cliMissing = readCodexUsageForSnapshot();
  check(
    "a recorded ping failure surfaces its EXACT reason on the snapshot",
    cliMissing?.error === "Codex CLI not found at /fake/path/codex.js (install it globally: npm install -g @openai/codex)",
    JSON.stringify(cliMissing),
  );
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

  // Simulate an earlier failed ping so the next assertion proves a SUCCESSFUL one clears it.
  noteCodexUsageError("simulated transient failure");
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
  const snapshotUsage = readCodexUsageForSnapshot();
  check(
    "dashboard snapshot uses the live ping without scanning rollouts",
    snapshotUsage?.fiveHour === 4 && __codexUsageTestHooks.rolloutScanCount() === afterPingScanCount,
    JSON.stringify(snapshotUsage),
  );
  check(
    "a successful ping clears an earlier recorded error off the snapshot",
    !snapshotUsage?.error,
    JSON.stringify(snapshotUsage),
  );
  const live = readCodexUsage();
  check("live pings invalidate and replace a cached rollout reading", live?.fiveHour === 4 && live.pools?.length === 1, JSON.stringify(live));

  check(
    "capacity reads still refresh from both rollout homes after a ping",
    __codexUsageTestHooks.rolloutScanCount() === afterPingScanCount + 2,
    `${__codexUsageTestHooks.rolloutScanCount()} vs ${afterPingScanCount}`,
  );

  // ---- banked resets survive a NEWER rollout ----
  //
  // `rateLimitResetCredits` rides the live app-server ping; a rollout snapshot has no such field. The
  // rollout is also the newer reading most of the time Codex is actually working, so spreading the
  // winning snapshot alone made a granted reset vanish from the chip the moment a turn ran. Same trap
  // `pools` already documents, and the reason both are attached independently of who won.
  {
    const creditAt = Date.now() + 2_000;
    noteCodexPing({
      fiveHour: 4,
      sevenDay: 5,
      fiveHourReset: creditAt + 2 * 3_600_000,
      sevenDayReset: creditAt + 3 * 24 * 3_600_000,
      planType: "pro",
      updatedAt: creditAt,
      resetCredits: { available: 1, pending: 0, expiresAt: creditAt + 30 * 86_400_000, title: "Full reset", readAt: creditAt },
    });
    check("a ping carrying banked resets reports them", readCodexUsage()?.resetCredits?.available === 1, JSON.stringify(readCodexUsage()?.resetCredits));
    // A real turn lands afterwards: newer, and carrying only the plan-wide windows.
    writeRollout(home, creditAt + 60_000, 77, 88);
    // clearReadCache, NOT reset() — reset() drops `livePing` itself, which would make this assertion
    // pass or fail for a reason that has nothing to do with the merge under test.
    __codexUsageTestHooks.clearReadCache();
    const afterTurn = readCodexUsage();
    check("the newer rollout really did win the meters", afterTurn?.fiveHour === 77, JSON.stringify(afterTurn));
    check(
      "…and the banked reset SURVIVES it instead of being blanked by a reading that never had the field",
      afterTurn?.resetCredits?.available === 1,
      JSON.stringify(afterTurn?.resetCredits),
    );
  }

  // --- the provider's own limit-reached verdict (`limitStateOf`) ---
  // This mapping is what lets fresh telemetry overturn a provider-STATED cap, so the ABSENT case has
  // to stay distinguishable from the explicit-null one. Field shapes verified live on codex-cli
  // 0.142.4: an unblocked plan answers `rateLimitReachedType: null` + `spendControlReached: false`.
  check('an explicit no-limit-reached reading maps to "none"', limitStateOf({ rateLimitReachedType: null, spendControlReached: false }) === "none");
  check('a named reached limit maps to "reached"', limitStateOf({ rateLimitReachedType: "usage_limit", spendControlReached: false }) === "reached");
  check('a spend-control block maps to "reached" even with no named limit', limitStateOf({ rateLimitReachedType: null, spendControlReached: true }) === "reached");
  check('a response omitting the field stays UNKNOWN rather than "none"', limitStateOf({}) === undefined);
  check("an unknown spend-control state stays UNKNOWN", limitStateOf({ rateLimitReachedType: null }) === undefined);
  // A blank string is malformed, not an answer — it names no reached limit and is not the explicit
  // null that means "nothing is reached", so it fails closed to UNKNOWN like any other value we
  // cannot interpret.
  check("a blank reached-type is UNKNOWN, neither reached nor clear", limitStateOf({ rateLimitReachedType: "   ", spendControlReached: false }) === undefined);

  // ---- a big rollout must not be read whole ----
  //
  // This is the 2026-09-16 server-restart bug in miniature. A real implementor session writes a
  // 15-96MB rollout; the newest 40 came to 415MB. Read whole, on the main event loop, behind a 2s cache,
  // on a path that capacity and routing decisions call — one scan froze the live server for 9.3s at
  // 0.4s of CPU, which timed out script-hub's health probe and got the process restarted under its own
  // running agents. The snapshot it wants is APPENDED per turn, so it is always in the tail.
  console.log("\n=== big rollout: tail, not the whole file ===\n");
  {
    // Same home as the rest of the gate, on a NEWER date partition, so the scan reaches it first —
    // config.ts reads env at import, so a second CODEX_HOME_DIR cannot be introduced mid-file.
    const dir = join(home, "sessions", "2026", "09", "16");
    mkdirSync(dir, { recursive: true });
    const at = Date.now();
    const snapshotLine = JSON.stringify({
      timestamp: new Date(at).toISOString(),
      payload: {
        type: "token_count",
        rate_limits: {
          primary: { used_percent: 55, window_minutes: 300, resets_at: Math.floor((at + 3_600_000) / 1000) },
          secondary: { used_percent: 66, window_minutes: 7 * 24 * 60, resets_at: Math.floor((at + 86_400_000) / 1000) },
          plan_type: "pro",
        },
      },
    });
    // ~12MB of turn transcript ahead of the snapshot, the way a long session actually looks.
    const filler = `${JSON.stringify({ payload: { type: "agent_message", text: "x".repeat(4000) } })}\n`;
    const file = join(dir, `rollout-${at}.jsonl`);
    writeFileSync(file, filler.repeat(3000) + snapshotLine + "\n", "utf8");
    const size = statSync(file).size;
    check("the fixture is genuinely large", size > 10 * 1024 * 1024, `${(size / 1048576).toFixed(1)}MB`);

    __codexUsageTestHooks.reset();
    const big = readCodexUsage();
    check("the newest snapshot is still found in the tail", big?.fiveHour === 55 && big.sevenDay === 66, JSON.stringify(big));
    const bytes = __codexUsageTestHooks.rolloutBytesRead();
    check(
      "and the whole file was NOT pulled off disk",
      bytes > 0 && bytes < size / 2,
      `read ${(bytes / 1048576).toFixed(1)}MB of a ${(size / 1048576).toFixed(1)}MB rollout`,
    );
  }

  console.log(`\n=== RESULT: ${failed === 0 ? "PASS" : "FAIL"} - ${passed} passed, ${failed} failed ===`);
  if (failures.length) {
    for (const failure of failures) console.error(`  - ${failure}`);
  }
  process.exitCode = failed === 0 ? 0 : 1;
} finally {
  rmSync(root, { recursive: true, force: true });
}
