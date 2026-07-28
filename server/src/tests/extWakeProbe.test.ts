// Unit test for the ext-wake short-probe logic and the weekly-reset escape from a 5h stagger hold
// (pure functions + one no-network boot placement — no accounts pinged, no DB).
// Run: npx tsx src/tests/extWakeProbe.test.ts   (or `npm run test:ext-wake`)
//
// A subscription shared with an outside consumer (a second orchestrator / background service on the
// same account) must NOT be parked "idle" — and blind to that consumer's live burn — for the hours
// until its stagger slot. `holdStartAt` bounds a known-shared sub's re-test to a short probe;
// `extWakeAfterProbe` decides whether that probe confirms the consumer (keep) or finds it gone (clear).
//
// A hold also replaces the account's pending weekly-reset ping (one timer per account), so a 7d reset
// landing inside a hold would never be re-read: the chip keeps a spent week's % with no countdown at
// all. `startAtWeeklyReset` + `bootHoldsIdle` are what stop that, on the rollover AND the boot path.

import { holdStartAt, extWakeAfterProbe, startAtWeeklyReset, bootHoldsIdle, AccountManager } from "../accounts/accountManager.js";
import type { PersistedAccountUsage } from "../accounts/accountManager.js";
import { ResetStagger, WINDOW_MS } from "../accounts/resetStagger.js";
import { EventHub } from "../events.js";

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

console.log("weekly reset: a stagger hold cannot hide a renewed 7d window");
const WEEKLY_RESET = NOW + 90 * 60_000;
check("weekly reset before stagger slot → ping just after weekly reset", startAtWeeklyReset(SLOT, WEEKLY_RESET, NOW) === WEEKLY_RESET + 3000);
check("weekly reset after stagger slot → preserve stagger slot", startAtWeeklyReset(SLOT, SLOT + 60_000, NOW) === SLOT);
check("elapsed weekly reset → caller refreshes immediately, no synthetic hold change", startAtWeeklyReset(SLOT, NOW - 1, NOW) === SLOT);

console.log("boot: bootHoldsIdle (may a restored snapshot stay parked instead of pinging?)");
const snapshot = (over: Partial<PersistedAccountUsage>): PersistedAccountUsage => ({
  fiveHour: 0,
  sevenDay: 71,
  fiveHourReset: null,
  sevenDayReset: NOW + 2 * 86_400_000,
  usageAt: NOW - 60_000,
  holdUntil: null,
  extWakeAt: null,
  ...over,
});

check("no snapshot → ping", bootHoldsIdle(null, NOW) === false);
check("live hold → stay parked", bootHoldsIdle(snapshot({ holdUntil: NOW + 3_600_000 }), NOW) === true);
check("recent read, 5h window expired → stay parked", bootHoldsIdle(snapshot({ fiveHourReset: NOW - 1000 }), NOW) === true);
check("stale read, no hold → ping", bootHoldsIdle(snapshot({ usageAt: NOW - 45 * 60_000 }), NOW) === false);
check("5h window still running → ping", bootHoldsIdle(snapshot({ fiveHourReset: NOW + 3_600_000 }), NOW) === false);
// The regression: a week that reset while we were down is invisible until something re-reads it.
check(
  "weekly reset already elapsed → ping despite a live hold",
  bootHoldsIdle(snapshot({ holdUntil: NOW + 3_600_000, sevenDayReset: NOW - 1000 }), NOW) === false,
);

console.log("boot: a restored hold is capped at the account's weekly reset");

// ResetStagger reads this per call, and server/.env is auto-loaded — pin it so the operator's
// kill-switch can never turn this free gate into real pings against api.anthropic.com.
process.env.ACCOUNT_STAGGER = "on";

/** Boot the manager against persisted snapshots only — every account holds, so nothing is pinged.
 *  bootPing is driven directly because `start()` fires it un-awaited (and adds a ping interval). */
async function bootHoldUntil(persisted: Record<string, PersistedAccountUsage>): Promise<Record<string, number | null>> {
  // Empty tokens: pingUsage short-circuits on "no-token" before any fetch, so even an account that
  // declines to hold stays offline here.
  const accounts = Object.keys(persisted).map((id) => ({ id, label: id, token: "" }));
  const manager = new AccountManager(accounts, new EventHub(), 600_000, {
    stagger: new ResetStagger(),
    persist: { load: (id) => persisted[id] ?? null, save: () => {} },
  });
  await (manager as unknown as { bootPing(): Promise<void> }).bootPing();
  const out = Object.fromEntries(manager.dto().map((d) => [d.id, d.holdUntil ?? null]));
  manager.stop();
  return out;
}

const bootNow = Date.now();
const held = await bootHoldUntil({
  // Weekly reset lands INSIDE the restored 4h hold → the hold must break at the reset instead.
  early: snapshot({ holdUntil: bootNow + 4 * 3_600_000, sevenDayReset: bootNow + 90 * 60_000 }),
  // Weekly reset is days out → the stagger placement stands untouched.
  late: snapshot({ holdUntil: bootNow + 3 * 3_600_000, sevenDayReset: bootNow + 3 * 86_400_000 }),
  // Weekly reset is seconds away → no hold at all; the sub-minute remainder pings straight away
  // rather than synthesizing an idle window whose truncated release reads as an ext-wake probe.
  imminent: snapshot({ holdUntil: bootNow + 4 * 3_600_000, sevenDayReset: bootNow + 20_000, extWakeAt: bootNow - 26 * 3_600_000 }),
});
check("hold spanning the weekly reset → shortened to the reset", held.early === bootNow + 90 * 60_000 + 3000);
check("hold ending before the weekly reset → untouched", held.late === bootNow + 3 * 3_600_000);
check("weekly reset inside the minimum hold → ping, no hold", held.imminent === null);

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
