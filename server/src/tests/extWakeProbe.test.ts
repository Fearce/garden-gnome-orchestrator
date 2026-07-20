// Unit test for the ext-wake short-probe logic (pure — no accounts, no DB, no network).
// Run: npx tsx src/tests/extWakeProbe.test.ts   (or `npm run test:ext-wake`)
//
// A subscription shared with an outside consumer (a second orchestrator / background service on the
// same account) must NOT be parked "idle" — and blind to that consumer's live burn — for the hours
// until its stagger slot. `holdStartAt` bounds a known-shared sub's re-test to a short probe;
// `extWakeAfterProbe` decides whether that probe confirms the consumer (keep) or finds it gone (clear).

import { holdStartAt, extWakeAfterProbe } from "../accounts/accountManager.js";
import { WINDOW_MS } from "../accounts/resetStagger.js";

let failures = 0;
function check(name: string, cond: boolean): void {
  if (cond) {
    console.log(`  ✓ ${name}`);
  } else {
    failures++;
    console.error(`  ✗ ${name}`);
  }
}

const NOW = 1_700_000_000_000;
const SLOT = NOW + 4 * 3_600_000; // a far stagger slot ~4h out

console.log("ext-wake: holdStartAt (where an idle 5h window's restart is placed)");

// No staggering → always the plain slot, even with ext-wake history.
check("not staggered → slot", holdStartAt(false, NOW - 1000, NOW, SLOT) === SLOT);

// Staggered, never seen an outside consumer → full stagger slot (spread the reset out).
check("staggered, no history → slot", holdStartAt(true, null, NOW, SLOT) === SLOT);

// Staggered, lapsed ext-wake history → a SHORT probe, well before the far slot.
const probe = holdStartAt(true, NOW - 25 * 3_600_000, NOW, SLOT);
check("staggered + history → short probe, not the far slot", probe < SLOT && probe > NOW && probe - NOW <= 5 * 60_000);

console.log("ext-wake: extWakeAfterProbe (probe/dispatch-release outcome)");

const sentAt = NOW - 500;
// Window already running well before our ping → an outside consumer woke it; mark it (either caller).
const startedLongAgo = sentAt - 200_000 + WINDOW_MS; // fiveHourReset for a window that started 200s pre-ping
check("consumer present (probe) → now", extWakeAfterProbe({ fiveHourReset: startedLongAgo, sentAt, now: NOW, prev: null, scheduledProbe: true }) === NOW);
check("consumer present (dispatch) → now", extWakeAfterProbe({ fiveHourReset: startedLongAgo, sentAt, now: NOW, prev: 123, scheduledProbe: false }) === NOW);

// Window fresh (started at/after our ping, inside tolerance) — our own request likely started it.
const startedJustNow = sentAt - 10_000 + WINDOW_MS;
check("fresh + scheduled probe → cleared", extWakeAfterProbe({ fiveHourReset: startedJustNow, sentAt, now: NOW, prev: NOW - 3_600_000, scheduledProbe: true }) === null);
check("fresh + dispatch release → unchanged (inconclusive)", extWakeAfterProbe({ fiveHourReset: startedJustNow, sentAt, now: NOW, prev: 999, scheduledProbe: false }) === 999);

// No usable reset in the read → leave the mark untouched.
check("no reset → prev unchanged", extWakeAfterProbe({ fiveHourReset: null, sentAt, now: NOW, prev: 42, scheduledProbe: true }) === 42);

if (failures) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nall ext-wake probe checks passed");
