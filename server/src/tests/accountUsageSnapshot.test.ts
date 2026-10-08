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

console.log("account-usage: concurrent dispatch balancing");
const balanceManager = new AccountManager([personal, secondary], new EventHub());
const balanceStates = (balanceManager as any).states;
const balanceNow = Date.now();
Object.assign(balanceStates.get(personal.id), { fiveHour: 10, sevenDay: 10, sevenDayReset: balanceNow + 60_000 });
Object.assign(balanceStates.get(secondary.id), { fiveHour: 20, sevenDay: 30, sevenDayReset: balanceNow + 600_000 });
const loads = new Map([[personal.id, 0], [secondary.id, 0]]);
balanceManager.setDispatchLoadReader((id) => loads.get(id) ?? 0);
const launches: string[] = [];
for (let i = 0; i < 12; i++) {
  const preview = balanceManager.dispatchPreview().account.id;
  check(`preview ${i + 1} does not reserve a slot`, balanceManager.dispatchPreview().account.id === preview);
  const picked = balanceManager.select().account.id;
  check(`launch ${i + 1} matches preview`, picked === preview);
  launches.push(picked);
  loads.set(picked, loads.get(picked)! + 1);
}
check("twelve launches spread six per subscription despite unequal telemetry", loads.get(personal.id) === 6 && loads.get(secondary.id) === 6);
check("reset priority breaks equal-load ties", launches[0] === personal.id);
loads.set(secondary.id, 5);
check("a freed subscription takes the next dispatch", balanceManager.dispatchPreview().account.id === secondary.id);
balanceManager.setSpreadUsage(true);
check("live load outranks stale spread-usage preference", balanceManager.select().account.id === secondary.id);
balanceManager.setResetBurn(personal.id, balanceNow + 600_000);
check("explicit reset burn still overrides balancing", balanceManager.select().account.id === personal.id);
balanceManager.setResetBurn(null);
balanceStates.get(secondary.id).rateLimited = true;
balanceStates.get(secondary.id).rateLimitResetAt = balanceNow + 600_000;
check("an idle capped subscription stays excluded", balanceManager.dispatchPreview().account.id === personal.id);
balanceStates.get(secondary.id).rateLimited = false;
balanceStates.get(secondary.id).weeklySafetyPct = 25;
check("soft weekly safety outranks lighter load", balanceManager.dispatchPreview().account.id === personal.id);
balanceStates.get(secondary.id).weeklySafetyPct = 100;
balanceStates.get(secondary.id).fiveHour = 97;
balanceStates.get(secondary.id).fiveHourReset = balanceNow + 3_600_000;
const burstDemand = { label: "substantial task", expectedDurationMs: 600_000, expectedBurnPct: 15, reservePct: 4, substantial: true };
check("viable runway outranks lighter load", balanceManager.dispatchPreview(burstDemand).account.id === personal.id);
balanceStates.get(secondary.id).fiveHour = 20;
balanceManager.applyEnabled(secondary.id, false);
check("a disabled subscription stays excluded", balanceManager.select().account.id === personal.id);
balanceManager.applyEnabled(secondary.id, true);
const third = { id: "acct3", label: "third", token: "tok-third" };
const failoverBalance = new AccountManager([personal, secondary, third], new EventHub());
failoverBalance.setDispatchLoadReader((id) => id === secondary.id ? 4 : 0);
check("failover uses the less loaded alternative", failoverBalance.selectFailover(personal.id)?.id === third.id);

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
let usageBody: unknown = { cedar_ember: { eligible: false }, iguana_necktie: cloudWire };
globalThis.fetch = async (input) => {
  const url = String(input);
  if (url.endsWith("/profile")) return Response.json({ organization: { uuid: identity } });
  if (url.includes("/prepaid/credits")) return Response.json({ amount: 0, currency: "USD", auto_reload_settings: { enabled: false } });
  return Response.json(usageBody);
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
  usageBody = null;
  await (cloudManager as any).readResetCredits(cloudState);
  check("a null provider response clears cloud money and reports unreadable usage", cloudManager.dto()[0]?.cloudCredits === undefined && !!cloudManager.dto()[0]?.resetCreditsError);
  usageBody = { cedar_ember: { eligible: false }, iguana_necktie: cloudWire };
  await (cloudManager as any).readResetCredits(cloudState);
  check("a valid provider response restores cloud money after unreadable usage", cloudManager.dto()[0]?.cloudCredits?.remaining === 90 && !cloudManager.dto()[0]?.resetCreditsError);
  cloudManager.setProfileToken(cloudAccount.id, "");
  check("removing profile token clears its cloud balance", cloudManager.dto()[0]?.cloudCredits === undefined);
} finally { globalThis.fetch = originalFetch; }

console.log("account-usage: a revoked profile token is not reported as throttling");
{
  // Live behaviour: the usage endpoint answers a revoked token 429 while the profile endpoint says 401.
  const revokedManager = new AccountManager([{ id: "revoked", label: "Revoked", token: "inference-token", profileToken: "revoked-token" }], new EventHub());
  const revokedState = (revokedManager as any).states.get("revoked");
  let profileStatus = 401;
  globalThis.fetch = (async (input: string | URL) => String(input).endsWith("/profile")
    ? new Response(JSON.stringify({ error: { type: "authentication_error", message: "OAuth access token has been revoked." } }), { status: profileStatus })
    : new Response(JSON.stringify({ error: { type: "rate_limit_error" } }), { status: 429 })) as typeof fetch;
  try {
    await (revokedManager as any).readResetCredits(revokedState);
    check("429 + revoked profile reads as a rejected login", /rejected or revoked.*sign in again/i.test(revokedManager.dto()[0]?.resetCreditsError ?? ""), revokedManager.dto()[0]?.resetCreditsError ?? "none");
    profileStatus = 429;
    await (revokedManager as any).readResetCredits(revokedState);
    check("genuine throttling still waits for the next refresh", /rate-limited.*next refresh/i.test(revokedManager.dto()[0]?.resetCreditsError ?? ""));
  } finally { globalThis.fetch = originalFetch; }
}

console.log("account-usage: GGO's own Claude sign-in renews itself");
{
  const org = "11111111-1111-4111-8111-111111111111";
  const saved: Array<{ accessToken: string; refreshToken: string; expiresAt: number } | null> = [];
  const store = {
    load: () => ({ accessToken: "access-old", refreshToken: "refresh-1", expiresAt: Date.now() - 1_000 }),
    save: (_id: string, login: { accessToken: string; refreshToken: string; expiresAt: number } | null) => { saved.push(login); },
  };
  const loginAccount = { id: "signed-in", label: "Signed in", token: "inference-token" };
  const loginManager = new AccountManager([loginAccount], new EventHub(), 600_000, { profileLogins: store });
  const loginState = (loginManager as any).states.get(loginAccount.id);
  loginState.organizationId = org;
  check("a stored sign-in is restored at construction", loginManager.dto()[0]?.profileTokenPresent === true && loginManager.dto()[0]?.profileLoginRenews === true);

  let tokenCalls = 0;
  let tokenAnswer: () => Response = () => Response.json({ access_token: `access-${tokenCalls}`, refresh_token: `refresh-${tokenCalls + 1}`, expires_in: 28_800, scope: "user:profile user:inference" });
  const tokenBodies: Array<Record<string, string>> = [];
  const usedTokens: string[] = [];
  let revokedToken: string | null = null;
  globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/v1/oauth/token")) {
      tokenCalls++;
      tokenBodies.push(JSON.parse(String(init?.body)));
      await new Promise((r) => setTimeout(r, 5));
      return tokenAnswer();
    }
    const bearer = String((init?.headers as Record<string, string>)?.Authorization ?? "").replace("Bearer ", "");
    usedTokens.push(bearer);
    if (bearer === revokedToken) return new Response("{}", { status: 401 });
    if (url.endsWith("/profile")) return Response.json({ organization: { uuid: org } });
    if (url.includes("/prepaid/credits")) return Response.json({ amount: 0, currency: "USD", auto_reload_settings: { enabled: false } });
    return Response.json({ cedar_ember: { eligible: false }, iguana_necktie: cloudWire });
  }) as typeof fetch;
  try {
    await Promise.all([(loginManager as any).readResetCredits(loginState), (loginManager as any).readResetCredits(loginState)]);
    check("an expired sign-in renews once, even under concurrent reads", tokenCalls === 1, `token calls: ${tokenCalls}`);
    check("renewal spends the stored refresh token", tokenBodies[0]?.grant_type === "refresh_token" && tokenBodies[0]?.refresh_token === "refresh-1");
    check("the rotated login is persisted", saved.at(-1)?.refreshToken === "refresh-2" && saved.at(-1)?.accessToken === "access-1");
    check("reads use the renewed token, never the expired one", usedTokens.length > 0 && !usedTokens.includes("access-old"));
    check("the renewed login publishes cloud money", loginManager.dto()[0]?.cloudCredits?.remaining === 90);

    revokedToken = "access-1";
    await (loginManager as any).readResetCredits(loginState);
    check("a login revoked before its expiry renews and reads again", tokenCalls === 2 && loginManager.dto()[0]?.cloudCredits?.remaining === 90 && !loginManager.dto()[0]?.resetCreditsError);

    tokenAnswer = () => new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 });
    loginState.profileRefresh.expiresAt = Date.now() - 1;
    await (loginManager as any).readResetCredits(loginState);
    const dropped = loginManager.dto()[0];
    check("a refused renewal drops the login and asks for a new sign-in", !dropped?.profileTokenPresent && !dropped?.profileLoginRenews && /sign in again/i.test(dropped?.resetCreditsError ?? "") && saved.at(-1) === null);
    check("a dropped login shows no cloud money", dropped?.cloudCredits === undefined);

    console.log("account-usage: the sign-in flow is bound to its attempt and its subscription");
    const begun = loginManager.beginProfileLogin(loginAccount.id);
    const url = begun.ok ? new URL(begun.url) : null;
    const state = url?.searchParams.get("state") ?? "";
    check("sign-in starts a PKCE authorize link with the profile scope", !!url && url.searchParams.get("code_challenge_method") === "S256"
      && !!url.searchParams.get("code_challenge") && (url.searchParams.get("scope") ?? "").split(" ").includes("user:profile"));
    const callsBefore = tokenCalls;
    const wrongState = await loginManager.completeProfileLogin(loginAccount.id, "the-code#another-attempt");
    check("a code from another attempt is refused without a token request", !wrongState.ok && tokenCalls === callsBefore);
    tokenAnswer = () => Response.json({ access_token: "access-other", refresh_token: "refresh-other", expires_in: 28_800, organization: { uuid: "22222222-2222-4222-8222-222222222222" } });
    const otherOrg = await loginManager.completeProfileLogin(loginAccount.id, `the-code#${state}`);
    check("signing in to a different Claude account is refused", !otherOrg.ok && /not the one/i.test(otherOrg.message) && !loginManager.dto()[0]?.profileTokenPresent);
    const again = loginManager.beginProfileLogin(loginAccount.id);
    const againState = again.ok ? new URL(again.url).searchParams.get("state") : "";
    tokenAnswer = () => Response.json({ access_token: "access-new", refresh_token: "refresh-new", expires_in: 28_800, scope: "user:profile user:inference", organization: { uuid: org } });
    const ok = await loginManager.completeProfileLogin(loginAccount.id, `https://platform.claude.com/oauth/code/callback?code=the-code&state=${againState}`);
    check("a matching sign-in connects, persists and reads credits", ok.ok && /\$90\.00/.test(ok.message) && saved.at(-1)?.refreshToken === "refresh-new"
      && loginManager.dto()[0]?.profileLoginRenews === true && loginManager.dto()[0]?.cloudCredits?.remaining === 90, ok.message);
    check("the exchange sends the attempt's verifier to the manual redirect", tokenBodies.at(-1)?.grant_type === "authorization_code"
      && !!tokenBodies.at(-1)?.code_verifier && tokenBodies.at(-1)?.redirect_uri === "https://platform.claude.com/oauth/code/callback");
    const reused = await loginManager.completeProfileLogin(loginAccount.id, `the-code#${againState}`);
    check("a finished attempt cannot be completed twice", !reused.ok && /expired/i.test(reused.message));
    loginManager.setProfileToken(loginAccount.id, "");
    check("disconnecting removes the stored sign-in", saved.at(-1) === null && !loginManager.dto()[0]?.profileTokenPresent);
  } finally { globalThis.fetch = originalFetch; }
}

console.log("account-usage: weekly resets between two reads");
{
  const { weeklyResetBetween } = await import("../accounts/accountManager.js");
  const now = Date.parse("2026-10-08T19:40:00Z");
  const H = 3_600_000, D = 24 * H;
  const before = { sevenDay: 84, sevenDayReset: now + 2 * D };
  const reanchored = weeklyResetBetween(before, { sevenDay: 6, sevenDayReset: now + 6 * D }, now);
  check("an end moved days later before the old end passed is an early reset", reanchored?.early === true && reanchored.fromPct === 84);
  const refilled = weeklyResetBetween(before, { sevenDay: 0, sevenDayReset: before.sevenDayReset }, now);
  check("a sharp fall under the same end is an early refill", refilled?.early === true);
  const onTime = weeklyResetBetween({ sevenDay: 90, sevenDayReset: now - 60_000 }, { sevenDay: 1, sevenDayReset: now + 7 * D - 60_000 }, now);
  check("a reset after the stated end is on schedule, not early", onTime !== null && onTime.early === false);
  check("the hourly rounding of the stated end is not a reset", weeklyResetBetween(before, { sevenDay: 84, sevenDayReset: before.sevenDayReset + 30 * 60_000 }, now) === null);
  check("ordinary growth is not a reset", weeklyResetBetween(before, { sevenDay: 86, sevenDayReset: before.sevenDayReset }, now) === null);
  check("a small fall is noise, not a reset", weeklyResetBetween(before, { sevenDay: 80, sevenDayReset: before.sevenDayReset }, now) === null);
  check("no earlier reading means nothing to compare", weeklyResetBetween({ sevenDay: null, sevenDayReset: null }, { sevenDay: 6, sevenDayReset: now + 6 * D }, now) === null);

  const logs: string[] = [];
  const hub = new EventHub();
  hub.subscribe((e) => { if (e.type === "log") logs.push(e.message); });
  const saved: Array<{ weeklyReset?: unknown }> = [];
  const manager = new AccountManager([personal], hub, 600_000, { persist: { load: () => null, save: (_id, usage) => saved.push(usage) } });
  const st = (manager as any).states.get(personal.id);
  Object.assign(st, { sevenDay: 84, sevenDayReset: now + 2 * D });
  (manager as any).noteWeeklyReset(st, { fiveHour: 0, sevenDay: 6, fiveHourReset: null, sevenDayReset: now + 6 * D }, now);
  (manager as any).persistState(st, now);
  check("an early reset is logged with the old and new readings", logs.some((m) => /weekly usage reset early \(84% → 6%\)/.test(m)));
  check("the console sees the reset", manager.dto()[0]?.weeklyReset?.early === true && manager.dto()[0]?.weeklyReset?.fromPct === 84);
  check("the reset survives a restart", (saved.at(-1)?.weeklyReset as { early?: boolean } | undefined)?.early === true);
}

console.log("account-usage: an early reset replaces the cached window used for pacing");
{
  const { burnBudgetPct } = await import("../orchestrator/goals.js");
  const now = Date.now(), D = 86_400_000;
  const oldEnd = now + 2 * D, newEnd = now + 6 * D;
  let persisted: import("../accounts/accountManager.js").PersistedAccountUsage | null = null;
  const persist = { load: () => persisted, save: (_id: string, usage: import("../accounts/accountManager.js").PersistedAccountUsage) => { persisted = usage; } };
  const manager = new AccountManager([personal], new EventHub(), 600_000, { persist });
  Object.assign((manager as any).states.get(personal.id), { sevenDay: 84, sevenDayReset: oldEnd });
  const fetchBefore = globalThis.fetch;
  globalThis.fetch = async () => new Response("{}", { headers: {
    "anthropic-ratelimit-unified-5h-utilization": "0.01",
    "anthropic-ratelimit-unified-7d-utilization": "0.03",
    "anthropic-ratelimit-unified-7d-reset": String(Math.floor(newEnd / 1000)),
  } });
  try {
    await (manager as any).pingOne(personal);
    const dto = manager.dto()[0]!;
    check("the real header path replaces the old utilization", dto.sevenDay === 3);
    check("the next reset follows the provider's new deadline", dto.sevenDayReset === Math.floor(newEnd / 1000) * 1000);
    const beforeBudget = burnBudgetPct(oldEnd, 100, now);
    const afterBudget = burnBudgetPct(dto.sevenDayReset!, 100, now);
    check("allowed usage follows the re-anchored window, not the previous week", beforeBudget > 76 && afterBudget > 19 && afterBudget < 20);
    check("the newly reset pool is under pace", dto.sevenDay! < afterBudget);
    manager.stop();
    const restored = new AccountManager([personal], new EventHub(), 600_000, { persist });
    const saved = restored.dto()[0]!;
    check("restart restores the new percentage, deadline and inferred reset", saved.sevenDay === 3 && saved.sevenDayReset === dto.sevenDayReset && saved.weeklyReset?.early === true);
    restored.stop();
  } finally { globalThis.fetch = fetchBefore; manager.stop(); }
}

console.log(failures ? `\n${failures} check(s) failed` : "\nall checks passed");
process.exit(failures ? 1 : 0);
