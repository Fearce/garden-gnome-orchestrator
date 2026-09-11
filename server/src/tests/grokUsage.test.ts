// Pure parsing + meter-cap tests for SuperGrok usage (winpty text, CLI log, HTTP billing, JWT tier).
// No login, CLI, network, or DB required. Run: npx tsx src/tests/grokUsage.test.ts

import assert from "node:assert/strict";
import {
  grokUsageCapped,
  noteGrokMonthly,
  noteGrokUsageScrape,
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
