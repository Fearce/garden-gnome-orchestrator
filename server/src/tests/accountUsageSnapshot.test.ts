// Unit test for the per-subscription usage published OUT of this process (no network, no DB).
// Run: npx tsx src/tests/accountUsageSnapshot.test.ts   (or `npm run test:account-usage`)
//
// Both halves are a contract with `~/.claude/usage-watcher/handoff_gate.py`, which uses them to warn a
// session about the sub IT is burning instead of whichever account happens to be in the global
// credentials file. The var NAMES and the snapshot FIELDS are the interface — a rename that only
// typechecks would silently stop identifying sessions, so it has to fail here instead.

import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const sandbox = mkdtempSync(join(tmpdir(), "account-usage-"));
process.env.CLAUDE_ACCOUNT_SNAPSHOT_PATH = join(sandbox, "orchestrator-accounts.json");

const { accountForToken, buildEnv } = await import("../agents/runner.js");
const { publishAccountUsage, snapshotPath } = await import("../accounts/usageSnapshot.js");
const { AccountManager } = await import("../accounts/accountManager.js");
const { EventHub } = await import("../events.js");

let failures = 0;
function check(name: string, cond: boolean): void {
  if (cond) {
    console.log(`  ✓ ${name}`);
  } else {
    failures++;
    console.error(`  ✗ ${name}`);
  }
}

const personal = { id: "acct1", label: "personal", token: "tok-personal" };
const secondary = { id: "acct2", label: "secondary", token: "tok-secondary" };
const loggedIn = { id: "default", label: "logged-in", token: "" };

console.log("account-usage: accountForToken");
check("matches the account whose token the run uses", accountForToken([personal, secondary], "tok-secondary")?.id === "acct2");
check("unknown token is not an account", accountForToken([personal, secondary], "tok-other") === undefined);
check("no token = inherited CLI login", accountForToken([personal, secondary], undefined) === undefined);
// The synthetic single-account entry carries an empty token; matching on it would label EVERY
// tokenless run as that account and send the gate looking for usage nobody publishes.
check("empty token never matches the synthetic entry", accountForToken([loggedIn], "") === undefined);

console.log("account-usage: buildEnv publishes the run identity");
const zaiEnv = buildEnv({ baseUrl: "https://api.z.ai/api/anthropic", authToken: "zai-key" });
check("z.ai run declares its backend", zaiEnv.CLAUDE_ORCH_PROVIDER === "zai");
check("z.ai run claims no Claude subscription", zaiEnv.CLAUDE_ORCH_ACCOUNT_ID === undefined);
check("z.ai run drops the subscription token", zaiEnv.CLAUDE_CODE_OAUTH_TOKEN === undefined);

// This server can itself be started from an agent shell, so a stale inherited identity must never
// survive into a run it spawns — it would mislabel every session as whatever spawned the server.
process.env.CLAUDE_ORCH_ACCOUNT_ID = "stale-acct";
process.env.CLAUDE_ORCH_ACCOUNT_LABEL = "stale-label";
check("inherited account id is cleared", buildEnv({}).CLAUDE_ORCH_ACCOUNT_ID === undefined);
check("inherited account label is cleared", buildEnv({}).CLAUDE_ORCH_ACCOUNT_LABEL === undefined);
check("z.ai run clears it too", buildEnv({ baseUrl: "u", authToken: "k" }).CLAUDE_ORCH_ACCOUNT_LABEL === undefined);
delete process.env.CLAUDE_ORCH_ACCOUNT_ID;
delete process.env.CLAUDE_ORCH_ACCOUNT_LABEL;

check("a Claude run always declares its backend", buildEnv({}).CLAUDE_ORCH_PROVIDER === "claude");

console.log("account-usage: snapshot");
const manager = new AccountManager([personal, secondary], new EventHub());
const snapshot = manager.usageSnapshot();
check("one entry per configured sub, keyed by the id buildEnv publishes",
  Object.keys(snapshot.accounts).sort().join(",") === "acct1,acct2");
check("entries carry the label the warning names", snapshot.accounts.acct2?.label === "secondary");
// usageAt 0 is how the gate tells "configured but never read" from a real reading; a snapshot that
// defaulted it to now() would make an unmeasured account look freshly measured at 0%.
check("an unpinged sub reports no reading", snapshot.accounts.acct1?.usageAt === 0);
check("an unpinged sub has no utilization", snapshot.accounts.acct1?.fiveHour === null);
check("cadence rides along so a consumer can size its staleness bound", snapshot.pingIntervalMs > 0);

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

publishAccountUsage(snapshot);
const written = JSON.parse(readFileSync(snapshotPath(), "utf8"));
check("published to CLAUDE_ACCOUNT_SNAPSHOT_PATH", snapshotPath() === process.env.CLAUDE_ACCOUNT_SNAPSHOT_PATH);
check("names its writer", written.source === "claude-orchestrator");
check("stamps a liveness heartbeat", typeof written.writtenAt === "number" && written.writtenAt > 0);
check("round-trips every account", Object.keys(written.accounts).sort().join(",") === "acct1,acct2");

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

console.log(failures ? `\n${failures} check(s) failed` : "\nall checks passed");
process.exit(failures ? 1 : 0);
