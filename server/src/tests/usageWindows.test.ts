/**
 * Unit gate: the token-shift computation behind the director's `next_token_shift` tool.
 *
 * Free: pure functions, fixed clock, pinned IANA zone, no DB/network/agent.
 * Run: npm run test:usage-windows (from server/)
 *
 * The zone is pinned on every call so the expected wording is deterministic on any box. That is the
 * only reason `TokenShiftSnapshot.timeZone` exists; production omits it and gets the server's own zone,
 * which is what "server-local" means to the person reading the answer.
 */

import {
  formatDistance,
  formatLocalInstant,
  formatTokenShift,
  tokenShiftReport,
  type TokenShiftSnapshot,
} from "../orchestrator/usageWindows.js";
import type { CodexUsageDTO } from "../agents/codexUsage.js";
import type { GrokUsageDTO } from "../agents/grokUsage.js";
import type { ZaiUsageDTO } from "../agents/zaiUsage.js";
import type { AccountDTO } from "../ws/protocol.js";
import { DIRECTOR_TOOLS, T } from "../agents/toolNames.js";
import { DIRECTOR_CLI_PROTOCOL, DIRECTOR_CLI_SCHEMA } from "../orchestrator/directorCliBridge.js";

let passed = 0;
let failed = 0;
const failures: string[] = [];
function check(label: string, condition: boolean, detail?: string): void {
  if (condition) {
    passed++;
    console.log(`  ✅ ${label}`);
  } else {
    failed++;
    failures.push(`${label}${detail ? `: ${detail}` : ""}`);
    console.error(`  ❌ ${label}${detail ? `: ${detail}` : ""}`);
  }
}

const ZONE = "Europe/Copenhagen";
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
// 2026-09-10 14:00 UTC is 16:00 CEST, so the sub's 18:50 local reset is 2h50m out.
const NOW = Date.parse("2026-09-10T14:00:00.000Z");
const SHIFT_1850 = Date.parse("2026-09-10T16:50:00.000Z");

function account(over: Partial<AccountDTO> = {}): AccountDTO {
  return {
    id: "acc-default",
    label: "default",
    fiveHour: 42,
    sevenDay: 17,
    fiveHourReset: SHIFT_1850,
    sevenDayReset: NOW + 4 * DAY,
    stale: false,
    rateLimited: false,
    resetsAt: null,
    active: true,
    enabled: true,
    weeklySafetyPct: 100,
    holdUntil: null,
    modelLimits: [],
    updatedAt: NOW - MINUTE,
    error: null,
    ...over,
  };
}

const NO_BACKENDS: Pick<TokenShiftSnapshot, "codex" | "grok" | "zai"> = {
  codex: { usage: null, enabled: false },
  grok: { usage: null, enabled: false },
  zai: { usage: null, enabled: false },
};

function snapshot(over: Partial<TokenShiftSnapshot> = {}): TokenShiftSnapshot {
  return { accounts: [account()], ...NO_BACKENDS, timeZone: ZONE, ...over };
}

console.log("\n=== token shift: rendering an instant ===\n");

check(
  "a reset renders with weekday, date, 24h clock, IANA zone and numeric offset",
  formatLocalInstant(SHIFT_1850, ZONE) === "Thu 2026-09-10 18:50:00 Europe/Copenhagen (UTC+02:00)",
  formatLocalInstant(SHIFT_1850, ZONE),
);
check(
  "a zone west of UTC renders a negative offset rather than dropping the sign",
  formatLocalInstant(SHIFT_1850, "America/New_York") === "Thu 2026-09-10 12:50:00 America/New_York (UTC-04:00)",
  formatLocalInstant(SHIFT_1850, "America/New_York"),
);
check(
  "exactly UTC still carries an explicit offset, not a bare GMT",
  formatLocalInstant(SHIFT_1850, "UTC") === "Thu 2026-09-10 16:50:00 UTC (UTC+00:00)",
  formatLocalInstant(SHIFT_1850, "UTC"),
);
check(
  "midnight renders as 00, never as a 24th hour",
  formatLocalInstant(Date.parse("2026-09-10T22:00:00.000Z"), ZONE).includes(" 00:00:00 "),
  formatLocalInstant(Date.parse("2026-09-10T22:00:00.000Z"), ZONE),
);

console.log("\n=== token shift: distance wording ===\n");

check("sub-minute reads as imminent, not '0m'", formatDistance(30_000) === "in under a minute", formatDistance(30_000));
check("under an hour is minutes", formatDistance(14 * MINUTE) === "in 14m", formatDistance(14 * MINUTE));
check("hours carry their minutes", formatDistance(2 * HOUR + 50 * MINUTE) === "in 2h 50m", formatDistance(2 * HOUR + 50 * MINUTE));
check("a whole number of hours drops the empty minutes", formatDistance(3 * HOUR) === "in 3h", formatDistance(3 * HOUR));
check("past 48h it switches to days", formatDistance(3 * DAY + 4 * HOUR) === "in 3d 4h", formatDistance(3 * DAY + 4 * HOUR));

console.log("\n=== token shift: which windows count ===\n");

const basic = tokenShiftReport(snapshot(), NOW);
check(
  "the next shift is the soonest FUTURE reset",
  basic.next?.resetAt === SHIFT_1850 && basic.next?.window === "5h session window",
  JSON.stringify(basic.next),
);
check("it is reported in local time with its distance", basic.next?.resetAtLocal === "Thu 2026-09-10 18:50:00 Europe/Copenhagen (UTC+02:00)" && basic.next?.inLabel === "in 2h 50m", JSON.stringify(basic.next));
check("the used percentage travels with the window", basic.next?.usedPct === 42 && basic.next?.durationLabel === "5 hours");
check("shifts come back soonest first", basic.shifts.map((s) => s.resetAt).join() === [SHIFT_1850, NOW + 4 * DAY].join());

// The rule the whole module exists for: a reset in the past is capacity you HAVE.
const rolled = tokenShiftReport(snapshot({ accounts: [account({ fiveHourReset: NOW - 5 * MINUTE })] }), NOW);
check(
  "a reset already in the past is NOT reported as a pending shift",
  rolled.shifts.every((s) => s.resetAt > NOW) && rolled.next?.window === "weekly window",
  JSON.stringify(rolled.shifts.map((s) => s.window)),
);
check(
  "and it is named as capacity already available rather than dropped",
  rolled.notCounted.some((n) => n.subject === "Claude · default · 5h session window" && n.reason.includes("available now")),
  JSON.stringify(rolled.notCounted),
);
check(
  "a reset landing exactly on `now` counts as rolled over, not as a zero-second shift",
  tokenShiftReport(snapshot({ accounts: [account({ fiveHourReset: NOW })] }), NOW).shifts.every((s) => s.window !== "5h session window"),
);

const disabled = tokenShiftReport(snapshot({ accounts: [account({ enabled: false }), account({ id: "b", label: "second", fiveHourReset: NOW + 4 * HOUR })] }), NOW);
check(
  "a disabled subscription contributes no shift",
  disabled.shifts.every((s) => !s.pool.includes("default")),
  JSON.stringify(disabled.shifts.map((s) => s.pool)),
);
check(
  "but is named under not-counted with the reason, never silently dropped",
  disabled.notCounted.some((n) => n.subject === "Claude · default" && n.reason.includes("disabled in Settings")),
  JSON.stringify(disabled.notCounted),
);

check(
  "a window with no reset timestamp is simply absent, since a missing reading is not evidence",
  tokenShiftReport(snapshot({ accounts: [account({ fiveHourReset: null, sevenDayReset: null })] }), NOW).next === null,
);

console.log("\n=== token shift: the states a plain 'soonest reset' would miss ===\n");

const idle = tokenShiftReport(snapshot({ accounts: [account({ fiveHour: 0, fiveHourReset: null, holdUntil: NOW + 40 * MINUTE })] }), NOW);
check(
  "an idle 5h window reports the stagger slot its next window opens at",
  idle.next?.resetAt === NOW + 40 * MINUTE && idle.next?.note?.includes("stagger slot") === true,
  JSON.stringify(idle.next),
);

const latched = tokenShiftReport(snapshot({ accounts: [account({ rateLimited: true, resetsAt: NOW + 20 * MINUTE })] }), NOW);
check(
  "a live cap latch is a shift too, since it is when that subscription becomes usable again",
  latched.next?.window === "usage cap latch" && latched.next?.inLabel === "in 20m",
  JSON.stringify(latched.next),
);

const poolCapped = tokenShiftReport(
  snapshot({ accounts: [account({ modelLimits: [{ model: "claude-fable-5", fallback: "claude-opus-5", resetsAt: NOW + 30 * MINUTE }] })] }),
  NOW,
);
check(
  "a per-model pool cap reports its own reset and the model standing in meanwhile",
  poolCapped.next?.window === "claude-fable-5 pool cap" && poolCapped.next?.note?.includes("claude-opus-5") === true,
  JSON.stringify(poolCapped.next),
);

console.log("\n=== token shift: the failover backends ===\n");

const codex: CodexUsageDTO = {
  fiveHour: 60,
  sevenDay: 30,
  fiveHourReset: NOW + 90 * MINUTE,
  sevenDayReset: NOW + 2 * DAY,
  planType: "plus",
  updatedAt: NOW - MINUTE,
  pools: [
    { limitId: "codex", limitName: "codex", modelSlug: null, fiveHour: 60, sevenDay: 30, fiveHourReset: NOW + 90 * MINUTE, sevenDayReset: NOW + 2 * DAY },
    { limitId: "codex_bengalfox", limitName: "GPT-5.3-Codex-Spark", modelSlug: "gpt-5.3-codex-spark", fiveHour: 5, sevenDay: 2, fiveHourReset: NOW + 25 * MINUTE, sevenDayReset: NOW + 3 * DAY },
  ],
};
const withCodex = tokenShiftReport(snapshot({ codex: { usage: codex, enabled: true } }), NOW);
check(
  "a dedicated Codex pool is reported separately from the general pool, never folded into it",
  withCodex.next?.window === "5h window (GPT-5.3-Codex-Spark pool)" && withCodex.shifts.some((s) => s.window === "5h window (general pool)"),
  JSON.stringify(withCodex.shifts.map((s) => s.window)),
);
check("the plan tier names the pool", withCodex.next?.pool === "Codex (plus)", withCodex.next?.pool);
check(
  "an estimated Codex reset says so, so it is not quoted as a fact",
  tokenShiftReport(snapshot({ codex: { usage: { ...codex, pools: undefined, fiveHourResetEstimated: true }, enabled: true } }), NOW)
    .shifts.find((s) => s.window === "5h window (general pool)")?.note?.includes("ESTIMATED") === true,
);
check(
  "an enabled Codex with no reading yet is reported as such rather than looking uncapped",
  tokenShiftReport(snapshot({ codex: { usage: null, enabled: true } }), NOW).notCounted.some(
    (n) => n.subject === "Codex" && n.reason.includes("no usage reading yet"),
  ),
);

const grok: GrokUsageDTO = {
  signedIn: true,
  email: null,
  tier: null,
  plan: "SuperGrok",
  sevenDay: 12,
  sevenDayReset: NOW + 5 * DAY,
  monthlyUsed: 250,
  monthlyLimit: 1000,
  monthlyReset: NOW + 11 * DAY,
  creditAllowance: "metered",
  capUntil: null,
  stale: true,
  updatedAt: NOW - HOUR,
};
const withGrok = tokenShiftReport(snapshot({ grok: { usage: grok, enabled: true } }), NOW);
const credits = withGrok.shifts.find((s) => s.window === "monthly credits");
check("Grok's monthly credit pool is tracked as its own window", credits?.resetAt === NOW + 11 * DAY && credits?.usedPct === 25, JSON.stringify(credits));
check("a stale reading is flagged on the window it came from", credits?.stale === true);

const zai: ZaiUsageDTO = {
  configured: true,
  plan: "pro",
  fiveHour: 8,
  fiveHourReset: NOW + 10 * MINUTE,
  sevenDay: 4,
  sevenDayReset: NOW + 6 * DAY,
  capUntil: NOW + 45 * MINUTE,
  stale: false,
  updatedAt: NOW,
};
const withZai = tokenShiftReport(snapshot({ zai: { usage: zai, enabled: true } }), NOW);
check("z.ai contributes its 5h, weekly and cap-latch windows", withZai.shifts.filter((s) => s.pool === "z.ai (pro)").length === 3, JSON.stringify(withZai.shifts.map((s) => `${s.pool} ${s.window}`)));
check(
  "an enabled z.ai without an API key is named, not counted",
  tokenShiftReport(snapshot({ zai: { usage: { ...zai, configured: false }, enabled: true } }), NOW).notCounted.some((n) => n.subject === "z.ai" && n.reason.includes("no API key")),
);
check(
  "a disabled backend is named too, since its window rolls over but frees nothing routable",
  basic.notCounted.map((n) => n.subject).join() === "Codex,Grok,z.ai",
  JSON.stringify(basic.notCounted.map((n) => n.subject)),
);

console.log("\n=== token shift: the text the owner reads ===\n");

const full = tokenShiftReport(snapshot({ codex: { usage: codex, enabled: true }, zai: { usage: zai, enabled: true } }), NOW);
const compact = formatTokenShift(full, false);
check(
  "the headline leads with the answer: how long, which pool, and the explicit instant",
  compact.split("\n")[1] === "Next token shift in 10m: z.ai (pro) · 5h window resets Thu 2026-09-10 16:10:00 Europe/Copenhagen (UTC+02:00).",
  compact.split("\n")[1],
);
check("the compact form lists only the next few after it", (compact.match(/^- /gm) ?? []).length <= 8 && compact.includes("Call again with all=true"), compact);
const everything = formatTokenShift(full, true);
check(
  "all=true lists every tracked window and never says there is more",
  (everything.match(/^- /gm) ?? []).length === full.shifts.length - 1 + full.notCounted.length && !everything.includes("all=true"),
  everything,
);
check("both forms open with the instant the question was asked at", compact.startsWith(`Now: ${full.nowLocal}`) && everything.startsWith(`Now: ${full.nowLocal}`));

const empty = formatTokenShift(tokenShiftReport({ accounts: [], ...NO_BACKENDS, timeZone: ZONE }, NOW), true);
check("with nothing tracked it says so instead of inventing a shift", empty.includes("no token shift to report"), empty);

console.log("\n=== token shift: the wiring that fails silently ===\n");

// A director tool the SDK can call but that is missing from the allowlist just no-ops, with nothing
// to see. The CLI bridge fails the same way in its own dialect: an action the schema's enum does not
// name can never be returned, so the Codex/Grok director loses the tool without an error either.
check("the tool is on the director's allowlist, not merely registered", DIRECTOR_TOOLS.includes(T.nextTokenShift), T.nextTokenShift);
check("the allowlisted name matches the tool the server registers", T.nextTokenShift.endsWith("__next_token_shift"), T.nextTokenShift);
const kinds = (DIRECTOR_CLI_SCHEMA.properties?.kind as { enum?: string[] } | undefined)?.enum ?? [];
check("Codex/Grok directors can return the command at all", kinds.includes("next_token_shift"), JSON.stringify(kinds));
check("and its `all` flag is a declared field, not silently dropped", DIRECTOR_CLI_SCHEMA.properties?.all != null);
check("the CLI protocol tells them the command exists", DIRECTOR_CLI_PROTOCOL.includes("- next_token_shift:"));

console.log(`\n=== RESULT: ${failed === 0 ? "PASS ✅" : "FAIL ❌"}: ${passed} passed, ${failed} failed ===`);
if (failures.length) {
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}
