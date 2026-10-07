// Unit test for per-subscription usage routing in AccountManager (no network, no DB).
// Run: npx tsx src/tests/accountUsageSnapshot.test.ts   (or `npm run test:account-usage`)

const { buildEnv } = await import("../agents/runner.js");
const { AccountManager } = await import("../accounts/accountManager.js");
const { EventHub } = await import("../events.js");

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) {
    console.log(`  ✓ ${name}`);
  } else {
    failures++;
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

const personal = { id: "acct1", label: "personal", token: "tok-personal" };
const secondary = { id: "acct2", label: "secondary", token: "tok-secondary" };

console.log("account-usage: subscription token safety gate");
const safetyManager = new AccountManager([personal, secondary], new EventHub());
const safetyStates = (safetyManager as any).states;
const safetyClock = Date.now();
Object.assign(safetyStates.get(personal.id), { fiveHour: 85, sevenDay: 10, fiveHourReset: safetyClock + 60_000, sevenDayReset: safetyClock + 120_000 });
Object.assign(safetyStates.get(secondary.id), { fiveHour: 10, sevenDay: 10, fiveHourReset: safetyClock + 60_000, sevenDayReset: safetyClock + 240_000 });
safetyManager.setTokenSafetyLimit(80);
check("only the subscription over its limit is blocked", safetyManager.tokenSafetyBlockedAccounts().map((a) => a.id).join() === personal.id);
check("preview switches to the other subscription", safetyManager.dispatchPreview().account.id === secondary.id);
check("dispatch switches to the other subscription", safetyManager.select().account.id === secondary.id);
check("failover refuses an over-limit subscription", safetyManager.selectFailover(secondary.id) === null);
check("ancillary calls use the safe subscription", safetyManager.auxToken() === secondary.token);
safetyManager.setResetBurn(personal.id, safetyClock + 120_000);
check("reset burn cannot bypass token safety", safetyManager.select().account.id === secondary.id);
const safetyDemand = { label: "tiny turn", expectedDurationMs: 1, expectedBurnPct: 1, reservePct: 0, substantial: false };
const blockedOption = safetyManager.capacityOptions(safetyDemand).find((o) => o.account.id === personal.id);
check("capacity reports the blocked subscription without headroom", blockedOption?.hasHeadroom === false);
check("capacity waits for the safety window reset", blockedOption?.nextViableAt === safetyClock + 60_000);
safetyStates.get(secondary.id).sevenDay = 90;
check("all over-limit subscriptions report no headroom", !safetyManager.hasHeadroom() && !safetyManager.dispatchPreview().hasHeadroom);
let safetyRefused = false;
try { safetyManager.select(); } catch (error) { safetyRefused = String(error).includes("Token safety limit"); }
check("dispatch refuses when every subscription is blocked", safetyRefused);
check("ancillary calls refuse when every subscription is blocked", safetyManager.auxToken() === undefined);
safetyStates.get(personal.id).fiveHourReset = safetyClock - 1;
check("a reset releases only its subscription", safetyManager.tokenSafetyBlockedAccounts().map((a) => a.id).join() === secondary.id && safetyManager.hasHeadroom());
safetyStates.get(personal.id).sevenDay = 90;
check("a weekly blocker survives the 5h reset", !safetyManager.hasHeadroom());
safetyManager.setTokenSafetyLimit(null);
check("turning safety off restores ordinary headroom", safetyManager.hasHeadroom());
safetyManager.setTokenSafetyLimit(80);
safetyStates.get(personal.id).fiveHour = null;
safetyStates.get(personal.id).sevenDay = null;
check("missing telemetry does not block an unmeasured alternative", safetyManager.hasHeadroom() && safetyManager.select().account.id === personal.id);
safetyManager.applyEnabled(personal.id, false);
let disabledRefused = false;
try { safetyManager.select(); } catch { disabledRefused = true; }
check("a disabled safe subscription cannot bypass the gate", disabledRefused);
const loneSafetyManager = new AccountManager([personal], new EventHub());
Object.assign((loneSafetyManager as any).states.get(personal.id), { fiveHour: 80, fiveHourReset: safetyClock + 60_000 });
loneSafetyManager.setTokenSafetyLimit(80);
let loneRefused = false;
try { loneSafetyManager.select(); } catch { loneRefused = true; }
check("single-account dispatch observes the same limit", loneRefused && !loneSafetyManager.hasHeadroom());

console.log("account-usage: buildEnv");
const zaiEnv = buildEnv({ baseUrl: "https://api.z.ai/api/anthropic", authToken: "zai-key" });
check("z.ai run drops the subscription token", zaiEnv.CLAUDE_CODE_OAUTH_TOKEN === undefined);

console.log("account-usage: preparing a sub for its reset");
const priorityManager = new AccountManager([personal, secondary], new EventHub());
const priorityStates = (priorityManager as any).states;
const priorityReset = Date.now() + 12 * 60 * 60_000;
Object.assign(priorityStates.get("acct1"), { fiveHour: 10, sevenDay: 54, sevenDayReset: priorityReset });
Object.assign(priorityStates.get("acct2"), { fiveHour: 10, sevenDay: 38, sevenDayReset: Date.now() + 60 * 60_000 });
check("ordinary routing spends the sooner-resetting account", priorityManager.dispatchPreview().account.id === "acct2");
priorityManager.setResetBurn("acct1", priorityReset);
check("a burn changes the preview", priorityManager.dispatchPreview().account.id === "acct1");
check("a burn changes the actual dispatch", priorityManager.select().account.id === "acct1");
check("the dispatch reason names the burn", priorityManager.select().reason.includes("preparing this sub for its reset"));
check("a burn steers failover from another sub to the target", priorityManager.selectFailover("acct2")?.id === "acct1");
priorityStates.get("acct1").rateLimited = true;
priorityStates.get("acct1").rateLimitResetAt = Date.now() + 60 * 60_000;
check("a rate-limited burn target falls back", priorityManager.dispatchPreview().account.id === "acct2");
priorityStates.get("acct1").rateLimited = false;
priorityStates.get("acct1").sevenDay = 98;
check("the hard limit still excludes the burn target", priorityManager.dispatchPreview().account.id === "acct2");
priorityStates.get("acct1").sevenDay = 85;
priorityStates.get("acct1").weeklySafetyPct = 50;
check("the soft weekly ceiling does not hold a burn back", priorityManager.dispatchPreview().account.id === "acct1");
const longDemand = { label: "long task", expectedDurationMs: 6 * 60 * 60_000, expectedBurnPct: 40, reservePct: 10, substantial: true };
check("a runway forecast does not hold a burn back", priorityManager.dispatchPreview(longDemand).account.id === "acct1");
priorityStates.get("acct1").weeklySafetyPct = 100;
priorityManager.setResetBurn("acct1", Date.now() - 1);
check("the burn expires at its captured reset", priorityManager.dispatchPreview().account.id === "acct2");
priorityManager.setResetBurn("acct1", priorityReset);
priorityManager.setResetBurn(null);
check("stopping the burn restores ordinary routing", priorityManager.dispatchPreview().account.id === "acct2");

// A dashboard can open before AccountManager.start() begins its asynchronous boot pings. It must show
// the last known readings during that short gap rather than flashing both Claude cards as "—" after
// every server restart.
const persistedUsage = {
  fiveHour: 31,
  sevenDay: 42,
  fiveHourReset: Date.now() + 60 * 60_000,
  sevenDayReset: Date.now() + 24 * 60 * 60_000,
  usageAt: Date.now() - 5_000,
  holdUntil: null,
  extWakeAt: null,
  modelLimits: {},
  rateLimited: false,
  rateLimitWindow: null,
  rateLimitResetAt: null,
};
const hydratedManager = new AccountManager([secondary], new EventHub(), 600_000, {
  persist: { load: () => persistedUsage, save: () => undefined },
});
const hydrated = hydratedManager.dto()[0];
check("a restart hydrates persisted meters before async boot pings", hydrated?.fiveHour === 31 && hydrated.sevenDay === 42);

console.log("account-usage: reset-aware hard headroom and stale routing evidence");
const rolloverManager = new AccountManager([{ id: "rollover", label: "rollover", token: "" }], new EventHub());
const rolloverState = (rolloverManager as any).states.get("rollover");
rolloverState.fiveHour = 100;
rolloverState.fiveHourReset = Date.now() - 1_000;
rolloverState.sevenDay = 20;
rolloverState.sevenDayReset = Date.now() + 24 * 60 * 60_000;
check("an expired 100% window is dispatchable even before its cached percentage refreshes", rolloverManager.hasHeadroom());
rolloverState.fiveHourReset = Date.now() + 60_000;
check("the same 100% window stays blocked while its reset is still future", !rolloverManager.hasHeadroom());
rolloverState.fiveHour = 70;
rolloverState.sevenDay = 70;
rolloverState.usageStale = true;
check("stale apparent headroom is reported as unknown instead of fresh capacity", rolloverManager.dispatchPreview().capacity.status === "unknown");

console.log("account-usage: token-safety reset follows the blocking window");
const safetyNow = Date.now();
rolloverState.usageStale = false;
rolloverState.fiveHour = 90;
rolloverState.fiveHourReset = safetyNow + 60 * 60_000;
rolloverState.sevenDay = 95;
rolloverState.sevenDayReset = safetyNow + 3 * 24 * 60 * 60_000;
check(
  "a weekly safety exhaustion is not released by the earlier 5h reset",
  rolloverManager.tokenSafetyResetAt(80, safetyNow) === rolloverState.sevenDayReset,
);
rolloverState.sevenDay = 20;
check(
  "a 5h-only safety exhaustion releases at the 5h reset",
  rolloverManager.tokenSafetyResetAt(80, safetyNow) === rolloverState.fiveHourReset,
);

// A run-observed cap can arrive before (or independently of) the usage dashboard headers. It must be
// durable: a deploy between the cap and its stated reset must not let the boot selector route a parked
// task straight back onto the same subscription. Empty tokens make bootPing's probe deterministic
// (`no-token`, no network) while still exercising the real snapshot restore path.
console.log("account-usage: durable provider cap latch");
const capSnapshots = new Map<string, any>();
const capPersist = {
  load(id: string) {
    return capSnapshots.get(id) ?? null;
  },
  save(id: string, usage: any) {
    capSnapshots.set(id, structuredClone(usage));
  },
};
const capAccount = { id: "cap-acct", label: "capped", token: "" };
const capUntil = Date.now() + 60 * 60_000;
const beforeRestart = new AccountManager([capAccount], new EventHub(), 600_000, { persist: capPersist });
beforeRestart.updateFromRateLimit(capAccount.id, { status: "rejected", rateLimitType: "five_hour", resetsAt: capUntil });
const savedCap = capSnapshots.get(capAccount.id);
check("a rejected run persists its cap flag", savedCap?.rateLimited === true);
check("a rejected run persists the provider reset", savedCap?.rateLimitResetAt === capUntil);
const afterRestart = new AccountManager([capAccount], new EventHub(), 600_000, { persist: capPersist });
check("a persisted cap blocks dispatch before asynchronous boot pings", afterRestart.isRateLimited(capAccount.id) && !afterRestart.hasHeadroom());
await (afterRestart as any).bootPing();
check("boot restores a still-active run cap", afterRestart.isRateLimited(capAccount.id));
check("a restored cap holds the account out of dispatch", !afterRestart.hasHeadroom());
check("the restored cap keeps its provider reset", afterRestart.dto()[0]?.resetsAt === capUntil);
beforeRestart.updateFromRateLimit(capAccount.id, { status: "allowed", rateLimitType: "five_hour" });
check("an allowed signal clears the persisted cap", capSnapshots.get(capAccount.id)?.rateLimited === false);
const afterClear = new AccountManager([capAccount], new EventHub(), 600_000, { persist: capPersist });
await (afterClear as any).bootPing();
check("a cleared cap stays clear across restart", !afterClear.isRateLimited(capAccount.id) && afterClear.hasHeadroom());

// A cap with no window type came from the CLI's plain session-limit text, so it is scoped to the 5h
// session window. Such a hold is preserved through every usage ping (it is invisible to the unified
// headers), so a reset misread as ~24h out freezes a subscription the headers report as free.
const sessionAccount = { id: "session-acct", label: "session", token: "" };
const overlongReset = Date.now() + 23 * 60 * 60_000;
const sessionManager = new AccountManager([sessionAccount], new EventHub(), 600_000, { persist: capPersist });
sessionManager.updateFromRateLimit(sessionAccount.id, { status: "rejected", resetsAt: overlongReset });
check(
  "a window-less session cap is clamped to the session cadence",
  (capSnapshots.get(sessionAccount.id)?.rateLimitResetAt ?? 0) <= Date.now() + 5 * 60 * 60_000,
  String(capSnapshots.get(sessionAccount.id)?.rateLimitResetAt),
);
capSnapshots.set(sessionAccount.id, { ...capSnapshots.get(sessionAccount.id), rateLimited: true, rateLimitWindow: null, rateLimitResetAt: overlongReset });
const afterOverlong = new AccountManager([sessionAccount], new EventHub(), 600_000, { persist: capPersist });
check(
  "a persisted session cap outlasting its own window is dropped, not re-held for a day",
  !afterOverlong.isRateLimited(sessionAccount.id) && afterOverlong.hasHeadroom(),
  String(afterOverlong.dto()[0]?.resetsAt),
);
capSnapshots.set(sessionAccount.id, { ...capSnapshots.get(sessionAccount.id), rateLimited: true, rateLimitWindow: null, rateLimitResetAt: Date.now() + 60 * 60_000 });
const afterCredible = new AccountManager([sessionAccount], new EventHub(), 600_000, { persist: capPersist });
check("a session cap inside its own window is still re-held across a restart", afterCredible.isRateLimited(sessionAccount.id));
// A run launched at the reset instant is rejected a second AFTER the reset it names. That stated reset is
// already past, so the window just rolled over: hold briefly, never for the 5h fallback (2026-09-18).
const justRolledAccount = { id: "just-rolled-acct", label: "just rolled", token: "" };
const justRolledManager = new AccountManager([justRolledAccount], new EventHub(), 600_000, { persist: capPersist });
justRolledManager.updateFromRateLimit(justRolledAccount.id, { status: "rejected", resetsAt: Date.now() - 2_000 });
check(
  "a rejection naming a reset that just passed is held for minutes, not 5 hours",
  (capSnapshots.get(justRolledAccount.id)?.rateLimitResetAt ?? Infinity) <= Date.now() + 5 * 60_000,
  String(capSnapshots.get(justRolledAccount.id)?.rateLimitResetAt),
);
const weeklyAccount = { id: "weekly-acct", label: "weekly", token: "" };
const weeklyReset = Date.now() + 3 * 24 * 60 * 60_000;
const weeklyManager = new AccountManager([weeklyAccount], new EventHub(), 600_000, { persist: capPersist });
weeklyManager.updateFromRateLimit(weeklyAccount.id, { status: "rejected", rateLimitType: "seven_day", resetsAt: weeklyReset });
check("a real weekly cap keeps its full provider reset", weeklyManager.dto()[0]?.resetsAt === weeklyReset, String(weeklyManager.dto()[0]?.resetsAt));

// A 429 response should include a reset header, but a proxy can strip it. The rejection must still
// survive a deploy; otherwise the selector starts a parked task straight back on the same account.
console.log("account-usage: rejected header without reset");
const headerSnapshots = new Map<string, any>();
const headerPersist = {
  load(id: string) {
    return headerSnapshots.get(id) ?? null;
  },
  save(id: string, usage: any) {
    headerSnapshots.set(id, structuredClone(usage));
  },
};
const headerAccount = { id: "header-cap", label: "header capped", token: "test-token" };
const originalFetch = globalThis.fetch;
globalThis.fetch = async () => new Response("", {
  status: 429,
  headers: {
    "anthropic-ratelimit-unified-5h-utilization": "1",
    "anthropic-ratelimit-unified-7d-utilization": "0",
    "anthropic-ratelimit-unified-5h-status": "rejected",
  },
});
try {
  const beforeHeaderRestart = new AccountManager([headerAccount], new EventHub(), 600_000, { persist: headerPersist });
  await (beforeHeaderRestart as any).pingOne(headerAccount);
  const savedHeaderCap = headerSnapshots.get(headerAccount.id);
  check("a rejected header without reset persists a fallback cap", savedHeaderCap?.rateLimited === true && (savedHeaderCap?.rateLimitResetAt ?? 0) > Date.now() + 4 * 60 * 60_000);
  const afterHeaderRestart = new AccountManager([headerAccount], new EventHub(), 600_000, { persist: headerPersist });
  check("the fallback header cap survives restart and blocks dispatch", afterHeaderRestart.isRateLimited(headerAccount.id) && !afterHeaderRestart.hasHeadroom());
} finally {
  globalThis.fetch = originalFetch;
}

console.log("account-usage: looking for ancillary room leaves a held window alone");
const heldManager = new AccountManager([personal], new EventHub());
const heldState = (heldManager as any).states.get(personal.id);
heldState.holdUntil = Date.now() + 60 * 60_000;
check("a held subscription still counts as room for an ancillary call", heldManager.hasAuxAccount("claude-haiku-4-5-20251001"));
check("asking does not release the hold", heldState.holdUntil != null);
heldState.enabled = false;
check("a disabled subscription is not room", !heldManager.hasAuxAccount());

console.log("account-usage: promotional cloud credits stay separate and identity-bound");
const { parseCloudCredits } = await import("../accounts/cloudCredits.js");
// Field names and dollar units verified against a live OAuth usage response; values are neutral.
const cloudWire = { utilization: 10, resets_at: "2027-01-01T00:00:00Z", limit_dollars: 100, used_dollars: 10, remaining_dollars: 90, locked_reason: null };
check("cloud values stay in dollars", parseCloudCredits(cloudWire)?.remaining === 90);
check("reported remaining wins over subtraction", parseCloudCredits({ ...cloudWire, remaining_dollars: 88 })?.remaining === 88);
check("missing remaining derives from allowance", parseCloudCredits({ ...cloudWire, remaining_dollars: undefined })?.remaining === 90);
check("exhaustion is known zero", parseCloudCredits({ ...cloudWire, remaining_dollars: 0 })?.remaining === 0);
check("expiry is absolute and retained", parseCloudCredits({ ...cloudWire, resets_at: "2020-01-01T00:00:00Z" })?.expiresAt === Date.parse("2020-01-01T00:00:00Z"));
check("locked credits are unavailable", parseCloudCredits({ ...cloudWire, locked_reason: "account_paused" })?.locked === true);
check("missing block is unknown", parseCloudCredits(null) === null);
check("invalid numbers are rejected", parseCloudCredits({ ...cloudWire, remaining_dollars: -1 }) === null && parseCloudCredits({ ...cloudWire, limit_dollars: Infinity }) === null);
check("malformed expiry is rejected", parseCloudCredits({ ...cloudWire, resets_at: "invalid" }) === null);
const cloudAccount = { id: "cloud-acct", label: "Cloud test", token: "inference-token", profileToken: "profile-token" };
const cloudManager = new AccountManager([cloudAccount], new EventHub());
const cloudState = (cloudManager as any).states.get(cloudAccount.id);
cloudState.organizationId = "11111111-1111-4111-8111-111111111111";
let identity: string | null = cloudState.organizationId;
globalThis.fetch = async (input) => {
  const url = String(input);
  if (url.endsWith("/profile")) return Response.json({ organization: { uuid: identity } });
  if (url.includes("/prepaid/credits")) return Response.json({ amount: 0, currency: "USD", auto_reload_settings: { enabled: false } });
  return Response.json({ cedar_ember: { eligible: false }, iguana_necktie: cloudWire });
};
try {
  await (cloudManager as any).readResetCredits(cloudState);
  check("matching profile publishes cloud money", cloudManager.dto()[0]?.cloudCredits?.remaining === 90);
  check("cloud money does not become local prepaid funds", cloudManager.dto()[0]?.prepaidCredits?.balance === 0);
  cloudState.fiveHour = 100;
  cloudState.fiveHourReset = Date.now() + 60_000;
  check("cloud money cannot make an exhausted local account dispatchable", !cloudManager.hasHeadroom());
  identity = "22222222-2222-4222-8222-222222222222";
  await (cloudManager as any).readResetCredits(cloudState);
  check("wrong identity clears old cloud balance", cloudManager.dto()[0]?.cloudCredits === undefined);
  identity = null;
  await (cloudManager as any).readResetCredits(cloudState);
  check("unproven identity never publishes money", cloudManager.dto()[0]?.cloudCredits === undefined);
  identity = cloudState.organizationId;
  await (cloudManager as any).readResetCredits(cloudState);
  cloudManager.setProfileToken(cloudAccount.id, "");
  check("removing profile token clears its cloud balance", cloudManager.dto()[0]?.cloudCredits === undefined);
} finally { globalThis.fetch = originalFetch; }

console.log(failures ? `\n${failures} check(s) failed` : "\nall checks passed");
process.exit(failures ? 1 : 0);
