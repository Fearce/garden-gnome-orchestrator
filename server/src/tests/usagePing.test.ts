// Unit test for the usage ping's failure classification and its one timeout retry
// (stubbed global fetch — no network, no accounts, no DB).
// Run: npx tsx src/tests/usagePing.test.ts   (or `npm run test:usage-ping`)
//
// Why this exists. On 2026-08-26 both subscription meters sat frozen and STALE for an hour with the
// chip reading "usage read failed (network)", while the identical request replayed from a standalone
// process returned HTTP 200 in under a second and both tokens were valid. The endpoint was reachable
// (401 in ~190ms) — what actually happened is that the orchestrator shares a busy host with the agents
// it spawns, /api/health was measured stalling past 12s several times in eight minutes, and an aborted
// fetch was being reported as a network failure. That label sends the next investigation at DNS and
// tokens that are fine, and with a ten-minute poll a single miss freezes the meters until the next one.
//
// So two things are pinned here: an abort is classified `timeout`, never `network`, and a timed-out
// attempt is retried once (a genuine failure is NOT retried — no point doubling a real outage).

import { pingUsage } from "../accounts/usagePing.js";

let failures = 0;
function check(name: string, cond: boolean): void {
  if (cond) {
    console.log(`  ✓ ${name}`);
  } else {
    failures++;
    console.error(`  ✗ ${name}`);
  }
}

const realFetch = globalThis.fetch;

/** Response carrying the unified rate-limit headers a real subscription ping returns. */
function usageResponse(fivePct: string, sevenPct: string): Response {
  return new Response("{}", {
    status: 200,
    headers: {
      "anthropic-ratelimit-unified-5h-utilization": fivePct,
      "anthropic-ratelimit-unified-7d-utilization": sevenPct,
      "anthropic-ratelimit-unified-5h-status": "allowed",
    },
  });
}

const timeoutError = (): Error => Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" });
const networkError = (): Error => Object.assign(new TypeError("fetch failed"), { cause: { code: "ENOTFOUND" } });

/** Install a fetch stub that plays `outcomes` in order; returns the call counter. */
function stubFetch(outcomes: Array<Response | Error>): { calls: () => number } {
  let calls = 0;
  globalThis.fetch = (async () => {
    const outcome = outcomes[Math.min(calls, outcomes.length - 1)];
    calls++;
    if (outcome instanceof Error) throw outcome;
    return outcome;
  }) as typeof globalThis.fetch;
  return { calls: () => calls };
}

async function main(): Promise<void> {
  console.log("usage ping: failure classification");

  // An empty token never reaches the network — the chip must say so, not blame the network.
  const stubbed = stubFetch([usageResponse("0.10", "0.20")]);
  const noToken = await pingUsage("");
  check("empty token → reason 'no-token'", !noToken.ok && noToken.reason === "no-token");
  check("empty token → no request sent", stubbed.calls() === 0);

  // A real connection failure stays `network`.
  const net = stubFetch([networkError()]);
  const netResult = await pingUsage("tok");
  check("TypeError('fetch failed') → reason 'network'", !netResult.ok && netResult.reason === "network");
  check("a genuine network failure is NOT retried", net.calls() === 1);

  // A 200 with no unified headers is a rejected/non-subscription token, not a transport problem.
  const auth = stubFetch([new Response("{}", { status: 401 })]);
  const authResult = await pingUsage("tok");
  check("no unified rate-limit headers → reason 'auth'", !authResult.ok && authResult.reason === "auth");
  check("an auth failure is NOT retried", auth.calls() === 1);

  console.log("\nusage ping: the timeout retry (the 2026-08-26 frozen-meters case)");

  // THE REGRESSION: an abort must not be reported as a network failure.
  const bothTimeout = stubFetch([timeoutError(), timeoutError()]);
  const timedOut = await pingUsage("tok");
  check("aborted attempt → reason 'timeout', NOT 'network'", !timedOut.ok && timedOut.reason === "timeout");
  check("a timeout is retried exactly once (2 attempts, not more)", bothTimeout.calls() === 2);

  // The point of the retry: a transient local stall must not cost a whole poll interval.
  const recovers = stubFetch([timeoutError(), usageResponse("0.04", "0.99")]);
  const recovered = await pingUsage("tok");
  check("timeout then success → ok", recovered.ok);
  check("  ...and the retry's reading is used (5h 4%)", recovered.ok && recovered.usage.fiveHour === 4);
  check("  ...and the weekly reading too (7d 99%)", recovered.ok && recovered.usage.sevenDay === 99);
  check("exactly 2 attempts were made", recovers.calls() === 2);

  // A timeout followed by a real network failure must report the failure it ended on.
  const degrades = stubFetch([timeoutError(), networkError()]);
  const degraded = await pingUsage("tok");
  check("timeout then network failure → reason 'network'", !degraded.ok && degraded.reason === "network");
  check("exactly 2 attempts were made", degrades.calls() === 2);

  // A first-attempt success must not spend a second call.
  const clean = stubFetch([usageResponse("0.28", "0.33")]);
  const cleanResult = await pingUsage("tok");
  check("first-attempt success → ok, single request", cleanResult.ok && clean.calls() === 1);

  globalThis.fetch = realFetch;
  console.log(failures === 0 ? "\nusage ping OK" : `\n${failures} check(s) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

void main();
