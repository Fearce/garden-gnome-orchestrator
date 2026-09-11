/**
 * Unit gate - freshness-aware provider usage windows + the Grok/z.ai cap-latch disproof.
 *
 * Live defects found by the 2026-09-11 nightly sweep, pinned here as cases that must stay red without
 * the fix:
 *
 *  1. Grok was offered as a live failover rung for two days while rejecting every run it was handed.
 *     Its weekly + monthly readings had frozen on 2026-09-09, so both stated resets aged into the past
 *     and `grokUsageCapped` read "reset already passed" as "the window rolled over, it is free" —
 *     forever, because a frozen reading's reset only gets older. This is the load-bearing defect: it
 *     turns ANY frozen meter into a phantom rung, whatever froze it.
 *  2. What froze THAT reading was not a code path at all: until `config.ts` grew its implicit test
 *     isolation (`d3e8f38`, 2026-09-09 17:14), a gate run wrote `server/data/grok-usage-cache.json`
 *     itself, and production's copy is byte-for-byte `grokUsage.test.ts`'s final synthetic state
 *     stamped 16:05 that day. A test's clock must therefore be its READING clock, or a gate can only
 *     assert what its own drift happens to allow — see this file's own `now`.
 *  3. Separately, `parseGrokBillingHttp` discarded the endpoint's real `monthlyLimit: 0` answer ("this
 *     plan meters no monthly pool") as unreadable, so a genuinely retired pool could never be retired.
 *     It did not write the 2026-07 snapshot above — the old code returned early, so such a body never
 *     reached the cache — but it is what would have kept a real one pinned.
 *  4. The winpty weekly rescrape was gated on a meter merely EXISTING, so a frozen one permanently
 *     disabled the only source that could refresh it.
 *  5. z.ai was excluded from routing for 6.2 days on a single rejection's stated weekly reset, while
 *     its own quota endpoint read the weekly window 6% used the whole time — and nothing could
 *     disprove the latch, because the latch blocks the very run that would disprove it.
 *
 * Free: synthetic readings only, no DB/network/agent.
 * Run: npm run test:usage-freshness (from server/)
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "usage-window-"));
const dataDir = join(root, "data");
mkdirSync(dataDir, { recursive: true }); // else persistCache() throws into its own catch and the
// restart assertions below would pass against a file that was never written.
process.env.DATA_DIR = dataDir;
process.env.GROK_HOME_DIR = join(root, "grok-home");

const { allowanceReopened, readingIsStale, windowStillSpent } = await import("../agents/usageFreshness.js");
const {
  GROK_SCRAPE_STALE_MS,
  grokAllowanceReopened,
  grokUsageCapped,
  grokWeeklyIsFresh,
  noteGrokMonthly,
  noteGrokUsageScrape,
  parseGrokBillingHttp,
  readGrokUsage,
  __grokUsageTestHooks,
} = await import("../agents/grokUsage.js");
const { ZAI_SCRAPE_STALE_MS, noteZaiUsage, zaiAllowanceReopened, zaiUsageCapped } = await import(
  "../agents/zaiUsage.js"
);

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

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

try {
  // `noteZaiUsage`/`noteGrokUsageScrape` stamp each reading with the real wall clock, so the gate has
  // to reason on that same clock. A fixed synthetic instant silently drifts against it and turns the
  // staleness assertions into whatever the offset happens to be that day.
  const now = Date.now();

  // ---- windowStillSpent: the rollover inference and the guard on it ----

  check(
    "a window under its limit is never spent",
    !windowStillSpent({ atLimit: false, resetAt: now + HOUR, readingAt: now, staleAfterMs: 40 * MIN }, now),
  );
  check(
    "at the limit with the reset still ahead is spent",
    windowStillSpent({ atLimit: true, resetAt: now + HOUR, readingAt: now, staleAfterMs: 40 * MIN }, now),
  );
  check(
    "at the limit with no stated reset is spent - nothing proves it reopened",
    windowStillSpent({ atLimit: true, resetAt: null, readingAt: now, staleAfterMs: 40 * MIN }, now),
  );
  check(
    "a FRESH reading whose reset has passed clears the window (the rollover inference, intact)",
    !windowStillSpent({ atLimit: true, resetAt: now - HOUR, readingAt: now - MIN, staleAfterMs: 40 * MIN }, now),
  );
  // The defect: a frozen reading's reset only ever gets older, so this case granted free passage forever.
  check(
    "a STALE reading may NOT clear a spent window on a reset it never witnessed",
    windowStillSpent(
      { atLimit: true, resetAt: now - 50 * DAY, readingAt: now - 35 * HOUR, staleAfterMs: 40 * MIN },
      now,
    ),
  );
  check("a reading timestamped in the future (clock skew) is not stale", !readingIsStale(now + MIN, 40 * MIN, now));
  check("a reading with no timestamp at all (at=0) is stale", readingIsStale(0, 40 * MIN, now));

  // ---- Grok: the exact live state that produced the phantom rung ----

  // Reproduces data/grok-usage-cache.json as of the sweep: weekly at 100% with a reset 46 days past,
  // monthly credits 15000/15000 with a reset 53 days past.
  noteGrokUsageScrape(100, now - 46 * DAY, { plan: "SuperGrok", source: "log" });
  noteGrokMonthly(15_000, 15_000, now - 53 * DAY);
  check(
    "a FRESH exhausted-weekly reading whose reset has passed is correctly free",
    !grokUsageCapped(now),
    "just-noted readings are fresh, so the rollover inference should still apply",
  );

  // Age the readings past the staleness bound by moving `now` forward rather than faking timestamps.
  const later = now + GROK_SCRAPE_STALE_MS + HOUR;
  check(
    "once the reading goes stale, the exhausted windows read as spent again",
    grokUsageCapped(later),
    "this is the phantom-rung case: Grok reported available while rejecting every run",
  );
  check("a stale weekly meter is not fresh", !grokWeeklyIsFresh(later));
  check("a just-noted weekly meter is fresh", grokWeeklyIsFresh(now));

  // ---- Grok billing: a stated `monthlyLimit: 0` is an ANSWER, not a failed read ----

  const liveBody = {
    config: {
      monthlyLimit: { val: 0 },
      used: { val: 1669 },
      billingPeriodEnd: "2026-10-01T00:00:00+00:00",
    },
  };
  const parsed = parseGrokBillingHttp(liveBody);
  check("a monthlyLimit of 0 parses instead of being discarded", parsed?.monthlyLimit === 0, JSON.stringify(parsed));
  check("an unreadable body is still a failure", parseGrokBillingHttp({ nope: 1 }) === null);
  check(
    "a real metered pool still parses",
    parseGrokBillingHttp({ config: { monthlyLimit: { val: 15_000 }, used: { val: 900 } } })?.monthlyLimit === 15_000,
  );

  // Retiring the pool is the point: a fresh weekly plus no monthly pool must read as free, which the
  // pinned 2026-07 "15000/15000" snapshot would have prevented.
  noteGrokUsageScrape(12, now + 3 * DAY, { plan: "SuperGrok", source: "log" });
  noteGrokMonthly(parsed!.monthlyUsed, parsed!.monthlyLimit, parsed!.monthlyReset);
  check(
    "an answered 'no metered monthly pool' RETIRES the stale pool rather than leaving it pinned",
    readGrokUsage().monthlyLimit === null,
    `monthlyLimit=${readGrokUsage().monthlyLimit}`,
  );
  check("and with no pinned pool, a fresh 12% weekly reads as free", !grokUsageCapped(now));

  // ---- z.ai: the 6.2-day exclusion, and the telemetry that must lift it ----

  const capRecordedAt = now - 6.2 * DAY;
  noteZaiUsage({ plan: "lite", fiveHour: 100, fiveHourReset: now + HOUR, sevenDay: 6, sevenDayReset: now + 6 * DAY });
  check("z.ai genuinely 5h-spent reads as capped", zaiUsageCapped(now));
  check(
    "a still-spent reading does NOT lift the latch",
    !zaiAllowanceReopened(capRecordedAt, now).reopened,
    zaiAllowanceReopened(capRecordedAt, now).reason,
  );

  // The 5h window resets; the weekly was never the problem. This is the reading that should have
  // lifted the latch six days earlier.
  noteZaiUsage({ plan: "lite", fiveHour: 3, fiveHourReset: now + 5 * HOUR, sevenDay: 6, sevenDayReset: now + 6 * DAY });
  const lifted = zaiAllowanceReopened(capRecordedAt, now);
  check("fresh telemetry showing headroom lifts a stale z.ai latch", lifted.reopened, lifted.reason);
  check("the lift explains itself with the real numbers", /6% used/.test(lifted.reason), lifted.reason);
  check("z.ai with headroom is no longer capped", !zaiUsageCapped(now));

  // Every veto, because the default must stay "no".
  check("no recorded cap time is a veto", !zaiAllowanceReopened(undefined, now).reopened);
  // A cap recorded AFTER the reading was taken: the reading predates the rejection, so it says nothing
  // about whether the allowance reopened since.
  check(
    "a reading older than the recorded cap is a veto",
    !zaiAllowanceReopened(now + HOUR, now).reopened,
    zaiAllowanceReopened(now + HOUR, now).reason,
  );
  check(
    "a stale reading is a veto even when it shows headroom",
    !zaiAllowanceReopened(capRecordedAt, now + ZAI_SCRAPE_STALE_MS + MIN).reopened,
  );
  check(
    "a reading with no metered window is a veto",
    !allowanceReopened(
      "test",
      capRecordedAt,
      { meters: [{ usedPct: null, readingAt: now }, { usedPct: undefined, readingAt: now }], staleAfterMs: HOUR, maxUsedPct: 50 },
      now,
    ).reopened,
  );
  check(
    "a busy-but-not-capped window is still a veto above the threshold",
    !allowanceReopened("test", capRecordedAt, { meters: [{ usedPct: 80, readingAt: now }], staleAfterMs: HOUR, maxUsedPct: 50 }, now)
      .reopened,
  );

  // ---- Grok's own disproof path, same discipline ----

  noteGrokUsageScrape(4, now + 3 * DAY, { plan: "SuperGrok", source: "log" });
  const grokLift = grokAllowanceReopened(capRecordedAt, now);
  check("fresh Grok telemetry showing headroom lifts its latch", grokLift.reopened, grokLift.reason);
  noteGrokUsageScrape(100, now + 3 * DAY, { plan: "SuperGrok", source: "log" });
  check("a spent Grok weekly does not lift the latch", !grokAllowanceReopened(capRecordedAt, now).reopened);

  // A FRESH monthly beside a FROZEN weekly must not carry the lift on its own — the busiest-window
  // percentage would come from a meter that stopped describing anything hours ago.
  __grokUsageTestHooks.clearWeekly(); // a reading never travels backwards, so drop the newer one first
  noteGrokUsageScrape(9, now + 3 * DAY, { plan: "SuperGrok", source: "log", at: now - 2 * GROK_SCRAPE_STALE_MS });
  noteGrokMonthly(2_000, 15_000, now + 20 * DAY); // read just now, and well under the threshold
  const mixed = grokAllowanceReopened(capRecordedAt, now);
  check(
    "a stale weekly beside a fresh monthly is a veto, not a lift",
    !mixed.reopened && mixed.reason.includes("stale"),
    mixed.reason,
  );
  noteGrokMonthly(0, 0, null); // retire the pool again for the assertions below

  // Monthly credits alone are never the disproof: the weekly is the window Grok gates on.
  __grokUsageTestHooks.clearWeekly();
  noteGrokMonthly(1_000, 15_000, now + 20 * DAY);
  const monthlyOnly = grokAllowanceReopened(capRecordedAt, now);
  check("monthly credits with no weekly reading at all is a veto", !monthlyOnly.reopened, monthlyOnly.reason);

  // ---- the cache must carry the READING clock across a restart ----
  //
  // A write-clock stamp is the same bug wearing a disguise: the meter comes back looking brand new,
  // `grokWeeklyIsFresh` disables the rescrape that would refresh it, and the rollover inference is
  // re-applied to frozen numbers. The retire branch writes the cache on every billing poll, so this
  // would have re-dated a frozen weekly once a minute.
  const frozenAt = now - 2 * GROK_SCRAPE_STALE_MS;
  noteGrokUsageScrape(100, now - 40 * DAY, { plan: "SuperGrok", source: "log", at: frozenAt });
  noteGrokMonthly(0, 0, null); // the live plan's answer - and the call that rewrites the cache
  const cached = JSON.parse(readFileSync(join(dataDir, "grok-usage-cache.json"), "utf8")) as { weeklyAt?: number; at?: number };
  check("the cache records when the weekly was READ, not when it was written", cached.weeklyAt === frozenAt, JSON.stringify(cached));

  const restarted = await import(`../agents/grokUsage.js?restart=${Date.now()}`);
  check("a restart reloads that frozen reading as STALE", !restarted.grokWeeklyIsFresh(now), String(cached.weeklyAt));
  check("and the rollover inference is not re-applied to it", restarted.grokUsageCapped(now));

  // A cache written by the PREVIOUS build carries only `at`, and that `at` was `max(..., Date.now())` —
  // a write clock. Inheriting it as a read clock would resurrect every frozen meter as brand new on the
  // first boot after this ships, which is the one moment the fix most needs to hold.
  writeFileSync(
    join(dataDir, "grok-usage-cache.json"),
    JSON.stringify({ sevenDay: 100, sevenDayReset: now - 40 * DAY, plan: "SuperGrok", at: now }),
    "utf8",
  );
  const legacy = await import(`../agents/grokUsage.js?legacy=${Date.now()}`);
  check("a legacy cache's write clock is NOT adopted as a reading clock", !legacy.grokWeeklyIsFresh(now));
  check("so its frozen rollover stays capped too", legacy.grokUsageCapped(now));

  console.log(`\n=== RESULT: ${failed === 0 ? "PASS" : "FAIL"} - ${passed} passed, ${failed} failed ===`);
  if (failures.length) {
    for (const failure of failures) console.error(`  - ${failure}`);
  }
  process.exitCode = failed === 0 ? 0 : 1;
} finally {
  rmSync(root, { recursive: true, force: true });
}
