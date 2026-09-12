// Pure parsing + meter-cap tests for SuperGrok usage (winpty text, CLI log, HTTP billing, JWT tier).
// No login, CLI, network, or DB required. Run: npx tsx src/tests/grokUsage.test.ts

import assert from "node:assert/strict";
import {
  __grokUsageTestHooks,
  grokUsageCapped,
  noteGrokMonthly,
  noteGrokNoCreditAllowance,
  noteGrokUsageScrape,
  readGrokUsage,
  parseGrokBillingHttp,
  parseGrokCreditsLog,
  parseGrokReset,
  parseGrokUsage,
  tierFromAccessToken,
} from "../agents/grokUsage.js";

const local = (year: number, month: number, day: number, hour: number, minute: number): number =>
  new Date(year, month, day, hour, minute, 0, 0).getTime();

const julyNow = local(2026, 6, 20, 4, 0);
const rendered = "Weekly limit: 37% · Next reset: July 27, 01:10";
assert.deepEqual(parseGrokUsage(rendered, julyNow), {
  sevenDay: 37,
  sevenDayReset: local(2026, 6, 27, 1, 10),
});

assert.equal(parseGrokReset("Next reset: Jan 2, 03:04", local(2026, 11, 31, 23, 0)), local(2027, 0, 2, 3, 4));
assert.equal(parseGrokReset("Next reset: February 31, 03:04", julyNow), null);
assert.deepEqual(parseGrokUsage("Weekly limit: 125% · Next reset: July 27, 01:10", julyNow), {
  sevenDay: 100,
  sevenDayReset: local(2026, 6, 27, 1, 10),
});
assert.deepEqual(parseGrokUsage("usage unavailable", julyNow), { sevenDay: null, sevenDayReset: null });

// Multiline TUI capture (the real winpty shape).
const tui = `
     Weekly limit: 4%
     Next reset: July 27, 01:10
`;
assert.deepEqual(parseGrokUsage(tui, julyNow), {
  sevenDay: 4,
  sevenDayReset: local(2026, 6, 27, 1, 10),
});

// CLI unified.jsonl billing line — weekly SuperGrok percent + ISO period end + plan name.
const logLine = JSON.stringify({
  ts: "2026-07-20T02:29:33.080Z",
  src: "shell",
  pid: 1,
  lvl: "info",
  msg: "billing: fetched credits config",
  ctx: {
    config: {
      creditUsagePercent: 8.0,
      currentPeriod: {
        type: "USAGE_PERIOD_TYPE_WEEKLY",
        start: "2026-07-19T23:10:26.537917+00:00",
        end: "2026-07-26T23:10:26.537917+00:00",
      },
      billingPeriodEnd: "2026-07-26T23:10:26.537917+00:00",
    },
    subscriptionTier: "SuperGrok",
  },
});
const fromLog = parseGrokCreditsLog(`${logLine}\n`, julyNow);
assert.ok(fromLog);
assert.equal(fromLog!.sevenDay, 8);
assert.equal(fromLog!.plan, "SuperGrok");
assert.equal(fromLog!.sevenDayReset, Date.parse("2026-07-26T23:10:26.537917+00:00"));
// The line's OWN ts, not the read clock. Everything downstream — the rollover guard, the winpty
// rescrape gate, the cap-latch disproof — is decided on this number. Read an hour later, since this
// fixture's ts sits just after `julyNow` and the parser clamps a forward stamp to the read clock.
const laterRead = parseGrokCreditsLog(`${logLine}\n`, julyNow + 3_600_000);
assert.equal(laterRead!.at, Date.parse("2026-07-20T02:29:33.080Z"));
assert.equal(parseGrokCreditsLog("not json\n", julyNow), null);

// A line that cannot state when it was written is skipped, not dated to the read clock: dating it
// would make a frozen meter permanently fresh, which is exactly the defect the `at` plumbing fixes.
const undated = JSON.parse(logLine) as Record<string, unknown>;
delete undated.ts;
assert.equal(parseGrokCreditsLog(`${JSON.stringify(undated)}\n`, julyNow), null, "no ts -> no reading");

// A forward-skewed stamp is clamped to the read clock. Unclamped it would be permanently fresh AND
// permanently newer than any recorded cap, so one bad line could lift every cap latch on sight.
const skewed = { ...(JSON.parse(logLine) as Record<string, unknown>), ts: "2027-01-01T00:00:00.000Z" };
assert.equal(parseGrokCreditsLog(`${JSON.stringify(skewed)}\n`, julyNow)!.at, julyNow);

// --- The FREE tier's billing line (the shape that shipped a stale SuperGrok meter for weeks) --------
// Verbatim from ~/.grok/logs/unified.jsonl on 2026-09-12: no `creditUsagePercent` at all, a stated
// tier, and zero on-demand cap / prepaid balance. Requiring the percent discarded all 155 of these,
// so `grok-usage-cache.json` kept serving a months-old `SuperGrok · 7d 10%` while the ladder offered
// Grok as a live rung and 13 runs in three days were rejected outright.
const freeLine = JSON.stringify({
  ts: "2026-09-12T01:26:59.150Z",
  src: "shell",
  lvl: "info",
  msg: "billing: fetched credits config",
  ctx: {
    config: {
      currentPeriod: {
        type: "USAGE_PERIOD_TYPE_WEEKLY",
        start: "2026-09-06T23:10:26.537917+00:00",
        end: "2026-09-13T23:10:26.537917+00:00",
      },
      onDemandCap: { val: 0 },
      onDemandUsed: { val: 0 },
      prepaidBalance: { val: 0 },
      isUnifiedBillingUser: true,
      billingPeriodEnd: "2026-09-13T23:10:26.537917+00:00",
      historyLen: 0,
    },
    onDemandEnabled: null,
    subscriptionTier: "Free",
  },
});
const septNow = Date.parse("2026-09-12T02:00:00.000Z");
const free = parseGrokCreditsLog(`${freeLine}\n`, septNow);
assert.ok(free, "a free-tier billing line is a reading, not an unreadable line");
assert.equal(free!.sevenDay, null, "no metered allowance is stated as null, never as a percentage");
assert.equal(free!.plan, "Free");
assert.equal(free!.at, Date.parse("2026-09-12T01:26:59.150Z"), "and it still carries its OWN clock");

// Silence is never a reading: a line that merely omits the percent, without positively stating a tier
// and zero balances, stays unreadable — otherwise a truncated or future log shape reads as "free".
const mute = JSON.parse(freeLine) as { ctx: { config: Record<string, unknown>; subscriptionTier?: unknown } };
delete mute.ctx.subscriptionTier;
assert.equal(parseGrokCreditsLog(`${JSON.stringify(mute)}\n`, septNow), null, "no tier -> not a reading");
const funded = JSON.parse(freeLine) as { ctx: { config: Record<string, unknown> } };
funded.ctx.config.prepaidBalance = { val: 40 };
assert.equal(
  parseGrokCreditsLog(`${JSON.stringify(funded)}\n`, septNow),
  null,
  "a non-zero prepaid balance with no percent is unknown, not 'meters nothing'",
);

// Recording it RETIRES the weekly snapshot, and the DTO says why the meter is gone.
noteGrokUsageScrape(10, septNow + 6 * 86_400_000, { plan: "SuperGrok", source: "log", at: septNow - 1000 });
assert.equal(readGrokUsage().creditAllowance, "metered");
noteGrokNoCreditAllowance(free!.plan, free!.at);
const freeDto = readGrokUsage();
assert.equal(freeDto.creditAllowance, "none");
assert.equal(freeDto.sevenDay, null, "the stale SuperGrok percentage must not survive the free-tier reading");
assert.equal(freeDto.plan, "Free", "…and neither must its plan name");
// An upgrade is readable in the other direction too: a metered reading supersedes the free verdict.
noteGrokUsageScrape(4, septNow + 6 * 86_400_000, { plan: "SuperGrok", source: "log", at: free!.at + 1000 });
assert.equal(readGrokUsage().creditAllowance, "metered");
assert.equal(readGrokUsage().sevenDay, 4);
__grokUsageTestHooks.clearWeekly();
__grokUsageTestHooks.clearUnmetered();
noteGrokMonthly(0, 0, null, septNow);
assert.equal(readGrokUsage().creditAllowance, null, "nothing established yet is not the same as 'meters nothing'");

// HTTP /v1/billing monthly credits body.
const httpBody = {
  config: {
    monthlyLimit: { val: 15000 },
    used: { val: 433 },
    billingPeriodStart: "2026-07-01T00:00:00+00:00",
    billingPeriodEnd: "2026-08-01T00:00:00+00:00",
  },
};
const monthly = parseGrokBillingHttp(httpBody);
assert.ok(monthly);
assert.equal(monthly!.monthlyUsed, 433);
assert.equal(monthly!.monthlyLimit, 15000);
assert.equal(monthly!.monthlyReset, Date.parse("2026-08-01T00:00:00+00:00"));
assert.equal(parseGrokBillingHttp({ config: {} }), null);

// JWT tier claim (header.payload.sig) — only the payload is decoded.
const payload = Buffer.from(JSON.stringify({ tier: 1, email: "x@y.z" })).toString("base64url");
assert.equal(tierFromAccessToken(`aaa.${payload}.sig`), 1);
assert.equal(tierFromAccessToken("not-a-jwt"), null);
assert.equal(tierFromAccessToken(null), null);

// Cap detection: weekly 100% with future reset, or monthly fully spent before period end.
// Every reading is stamped with `julyNow`, so the fixed clock below is also the READING clock: a
// window's rollover only clears a cap while the reading that reported it is still fresh.
const future = julyNow + 7 * 24 * 60 * 60 * 1000;
const read = { plan: "SuperGrok", source: "log" as const, at: julyNow };
noteGrokUsageScrape(11, future, read);
noteGrokMonthly(100, 15000, future, julyNow);
assert.equal(grokUsageCapped(julyNow), false);
noteGrokUsageScrape(100, future, read);
assert.equal(grokUsageCapped(julyNow), true);
// Monthly alone can cap even when weekly is fine.
noteGrokUsageScrape(10, future, read);
noteGrokMonthly(15000, 15000, future, julyNow);
assert.equal(grokUsageCapped(julyNow), true);
// Past monthly reset clears the monthly cap — the reading is still fresh, so the rollover is trusted.
noteGrokMonthly(15000, 15000, julyNow - 1000, julyNow);
assert.equal(grokUsageCapped(julyNow), false);
// A weekly at its limit with NO stated reset stays capped: nothing proves it reopened. (z.ai has always
// read it this way; Grok used to call it uncapped, and `scrapeGrokUsage` can genuinely produce it when
// the winpty buffer ends after "Weekly limit:" but before "Next reset:".)
noteGrokUsageScrape(100, null, read);
assert.equal(grokUsageCapped(julyNow), true, "100% with no stated reset is capped, not free");
// A reading never travels backwards: the CLI log re-offers the same lingering billing line on every
// poll, and without this it would clobber a newer winpty scrape each time.
noteGrokUsageScrape(3, future, { plan: "SuperGrok", source: "log", at: julyNow - 60_000 });
assert.equal(grokUsageCapped(julyNow), true, "an older reading is ignored, not applied");

console.log("All Grok usage parser checks passed.");
