/**
 * Unit gate — TIMED tasks: duration parsing/validation and the round-boundary decision.
 *
 * `timedDecision` is the whole policy of the feature in one pure function: at every work-round boundary
 * it answers "spend another round, or close the window and go to review?". Getting it wrong is expensive
 * in both directions — a false "extend" spends hours of a subscription on a finished task, a false
 * "finalize" throws away the window the owner asked for — so every veto and its precedence is pinned
 * here rather than only observed through an agent run.
 *
 * Free: pure functions, no DB, no agent, no clock of its own (every case injects `now`).
 * Run:  npm run test:timed-tasks   (from server/)
 */

import {
  DEFAULT_MAX_EXTENSIONS,
  MAX_DURATION_MS,
  MIN_DURATION_MS,
  TIMED_COMPLETE_MARKER,
  clampDuration,
  detectTimedComplete,
  formatDuration,
  isHollowRound,
  normalizeDuration,
  parseDuration,
  remainingMs,
  timedDecision,
  timedExtensionMessage,
  timedWindow,
} from "../orchestrator/timedTasks.js";

let passed = 0;
let failed = 0;
const failures: string[] = [];
function check(label: string, cond: boolean, detail?: string): void {
  if (cond) {
    passed++;
    console.log(`  ✅ ${label}`);
  } else {
    failed++;
    failures.push(label + (detail ? ` — ${detail}` : ""));
    console.log(`  ❌ ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

const NOW = Date.parse("2026-08-27T12:00:00.000Z");
const MIN = 60_000;
const HOUR = 3_600_000;

console.log("\n=== timed tasks — duration parsing + the round-boundary decision ===\n");

// -- 1. duration parsing: what the owner and the director may hand us -------------------------------
console.log("1 — parsing owner/director-supplied durations");
check('"8h" → 8 hours', parseDuration("8h") === 8 * HOUR);
check('"90m" → 90 minutes', parseDuration("90m") === 90 * MIN);
check('"2h30m" → 2.5 hours', parseDuration("2h30m") === 2.5 * HOUR);
check('"1d" → 24 hours', parseDuration("1d") === 24 * HOUR);
check('"1d 2h" (spaced) parses', parseDuration("1d 2h") === 26 * HOUR);
check('"8H" is case-insensitive', parseDuration("8H") === 8 * HOUR);
check('a bare number is MINUTES (what the composer field means)', parseDuration("45") === 45 * MIN);
check("a bare NUMBER argument is minutes too", parseDuration(480) === 8 * HOUR);
check('"0.5h" accepts a fraction', parseDuration("0.5h") === 30 * MIN);
// Junk must not silently become a window — the director supplies this from free text.
check('"" → null', parseDuration("") === null);
check("null → null", parseDuration(null) === null);
check("undefined → null", parseDuration(undefined) === null);
check('"soon" → null', parseDuration("soon") === null);
check('"8 bananas" → null', parseDuration("8 bananas") === null);
check('"8h banana" → null (trailing junk rejected, not partially honoured)', parseDuration("8h banana") === null, String(parseDuration("8h banana")));
check('"0h" → null (a zero window is no window)', parseDuration("0h") === null);
check("a negative number → null", parseDuration(-5) === null);

console.log("\n2 — clamping keeps a typo bounded instead of failing the dispatch");
check("under the floor clamps up", clampDuration(1000) === MIN_DURATION_MS);
check("over the ceiling clamps down", clampDuration(400 * 24 * HOUR) === MAX_DURATION_MS);
check("a normal value passes through", clampDuration(8 * HOUR) === 8 * HOUR);
check("normalizeDuration parses AND clamps in one step", normalizeDuration("999d") === MAX_DURATION_MS);
check("normalizeDuration keeps null meaning 'no window'", normalizeDuration("nonsense") === null);
check("normalizeDuration('8h') round-trips", normalizeDuration("8h") === 8 * HOUR);

// -- 3. the window on a thread row ------------------------------------------------------------------
console.log("\n3 — reading the window off a thread");
check("no deadline ⇒ an ordinary task", timedWindow({ durationMs: null, deadlineAt: null }) === null);
check("a deadline ⇒ a window", timedWindow({ durationMs: 8 * HOUR, deadlineAt: NOW })?.deadlineAt === NOW);
check("a deadline with no duration is still a window", timedWindow({ deadlineAt: NOW })?.deadlineAt === NOW);
check("remaining is floored at zero, never negative", remainingMs(NOW - HOUR, NOW) === 0);
check("remaining counts down", remainingMs(NOW + HOUR, NOW) === HOUR);

// -- 4. the decision itself, veto by veto -----------------------------------------------------------
console.log("\n4 — the round-boundary decision");
const decide = (over: Partial<Parameters<typeof timedDecision>[0]> = {}) =>
  timedDecision({ deadlineAt: NOW + 4 * HOUR, now: NOW, extensionsUsed: 0, ...over });

check("time left + budget left ⇒ extend", decide().action === "extend");
check("the extend reason names the round", decide().reason.includes("round 1"), decide().reason);
check("the extend reason states the time left", decide().reason.includes("4h"), decide().reason);

check("deadline passed ⇒ finalize", decide({ deadlineAt: NOW - MIN }).action === "finalize");
check("deadline exactly now ⇒ finalize", decide({ deadlineAt: NOW }).action === "finalize");

// The reserve: a round must not be started with less than one useful slice left, because the closing
// review pass needs that time. Starting one anyway is how a window eats its own verification.
check("less than a full slice left ⇒ finalize (the reserve for the closing review)", decide({ deadlineAt: NOW + 2 * MIN }).action === "finalize");
check("the reserve reason says so", decide({ deadlineAt: NOW + 2 * MIN }).reason.includes("closing review"), decide({ deadlineAt: NOW + 2 * MIN }).reason);
check("exactly one slice left ⇒ extend", decide({ deadlineAt: NOW + 5 * MIN, minSliceMs: 5 * MIN }).action === "extend");
check("a hair under one slice ⇒ finalize", decide({ deadlineAt: NOW + 5 * MIN - 1, minSliceMs: 5 * MIN }).action === "finalize");

check("the extension budget is spent ⇒ finalize", decide({ extensionsUsed: DEFAULT_MAX_EXTENSIONS }).action === "finalize");
check("one under the budget ⇒ extend", decide({ extensionsUsed: DEFAULT_MAX_EXTENSIONS - 1 }).action === "extend");
check("the budget reason names the limit", decide({ extensionsUsed: DEFAULT_MAX_EXTENSIONS }).reason.includes(String(DEFAULT_MAX_EXTENSIONS)));

// Finishing early is a first-class outcome: a window is a budget, not a quota to burn.
check("an early completion ⇒ finalize even with hours left", decide({ completeEarly: true }).action === "finalize");
check("the early-completion reason says it wasn't padded", decide({ completeEarly: true }).reason.includes("padding"), decide({ completeEarly: true }).reason);
check(
  "early completion OUTRANKS every other veto (it is checked first)",
  decide({ completeEarly: true, extensionsUsed: 99, hollowRounds: 99, deadlineAt: NOW - HOUR }).reason.includes("fully complete"),
);

// The runaway guard: a count alone cannot tell 40 useful hours from 40 no-op rounds in 90 seconds.
check("enough hollow rounds ⇒ finalize", decide({ hollowRounds: 3 }).action === "finalize");
check("one under the hollow limit ⇒ extend", decide({ hollowRounds: 2 }).action === "extend");
check("the hollow reason explains itself", decide({ hollowRounds: 3 }).reason.includes("without making progress"), decide({ hollowRounds: 3 }).reason);
check("a custom hollow limit is honoured", decide({ hollowRounds: 1, maxHollowRounds: 1 }).action === "finalize");

check("every decision carries the remaining time", decide().remainingMs === 4 * HOUR);
check("a finalize past the deadline reports 0 remaining", decide({ deadlineAt: NOW - HOUR }).remainingMs === 0);
// Every close must say WHY — the brief's "park transparently with an actionable reason", never silence.
for (const [label, over] of [
  ["deadline", { deadlineAt: NOW - MIN }],
  ["reserve", { deadlineAt: NOW + 2 * MIN }],
  ["budget", { extensionsUsed: DEFAULT_MAX_EXTENSIONS }],
  ["hollow", { hollowRounds: 3 }],
  ["complete", { completeEarly: true }],
] as const) {
  check(`the ${label} close carries a non-empty reason`, decide(over).reason.trim().length > 20, decide(over).reason);
}

// -- 5. the hollow-round test -----------------------------------------------------------------------
console.log("\n5 — what counts as a hollow round (BOTH halves required)");
check("fast AND produced nothing ⇒ hollow", isHollowRound(5_000, false));
check("fast but produced work ⇒ NOT hollow", !isHollowRound(5_000, true));
check("slow and produced nothing ⇒ NOT hollow (it was thinking)", !isHollowRound(10 * MIN, false));
check("slow and produced work ⇒ NOT hollow", !isHollowRound(10 * MIN, true));

// -- 6. the early-completion marker -----------------------------------------------------------------
console.log("\n6 — the implementor's early-completion declaration");
check("a standalone marker line is detected", detectTimedComplete(`work done\n${TIMED_COMPLETE_MARKER}: everything in the brief is built and tested`) === "everything in the brief is built and tested");
check("the marker alone (no reason) still counts", detectTimedComplete(TIMED_COMPLETE_MARKER) === "");
check("a bulleted marker is detected", detectTimedComplete(`- ${TIMED_COMPLETE_MARKER}: done`) === "done");
check("a dash separator works", detectTimedComplete(`${TIMED_COMPLETE_MARKER} - all done`) === "all done");
check("no marker ⇒ null", detectTimedComplete("I think the task is complete now.") === null);
check("empty ⇒ null", detectTimedComplete("") === null);
check("null ⇒ null", detectTimedComplete(null) === null);
// The anchor matters: the extension directive QUOTES the marker at the implementor, so a mid-sentence
// mention must not end the window the moment the agent echoes its own instructions back.
check(
  "a mid-sentence mention does NOT count (the directive quotes the marker at the agent)",
  detectTimedComplete(`I was told to write ${TIMED_COMPLETE_MARKER} when finished, but I am not finished.`) === null,
);
check("the directive text itself does not self-trigger", detectTimedComplete(timedExtensionMessage({ remainingMs: HOUR, round: 1, maxExtensions: 40 })) === null);

// -- 7. formatting, which is the same wording in prompts, findings and the UI -----------------------
console.log("\n7 — duration formatting");
check("8h", formatDuration(8 * HOUR) === "8h", formatDuration(8 * HOUR));
check("1h 30m", formatDuration(90 * MIN) === "1h 30m", formatDuration(90 * MIN));
check("45m", formatDuration(45 * MIN) === "45m", formatDuration(45 * MIN));
check("2d 3h", formatDuration(51 * HOUR) === "2d 3h", formatDuration(51 * HOUR));
check("exactly 1d has no trailing 0h", formatDuration(24 * HOUR) === "1d", formatDuration(24 * HOUR));
check("zero/negative reads 0m rather than a negative", formatDuration(-1) === "0m");

console.log(`\n=== RESULT: ${failed === 0 ? "PASS ✅" : "FAIL ❌"} — ${passed} passed, ${failed} failed ===`);
if (failed > 0) {
  console.log("Failures:");
  for (const f of failures) console.log(`  - ${f}`);
}
process.exit(failed === 0 ? 0 : 1);
