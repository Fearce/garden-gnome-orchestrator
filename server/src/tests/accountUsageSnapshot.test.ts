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
const vota = { id: "acct2", label: "vota", token: "tok-vota" };
const loggedIn = { id: "default", label: "logged-in", token: "" };

console.log("account-usage: accountForToken");
check("matches the account whose token the run uses", accountForToken([personal, vota], "tok-vota")?.id === "acct2");
check("unknown token is not an account", accountForToken([personal, vota], "tok-other") === undefined);
check("no token = inherited CLI login", accountForToken([personal, vota], undefined) === undefined);
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
const manager = new AccountManager([personal, vota], new EventHub());
const snapshot = manager.usageSnapshot();
check("one entry per configured sub, keyed by the id buildEnv publishes",
  Object.keys(snapshot.accounts).sort().join(",") === "acct1,acct2");
check("entries carry the label the warning names", snapshot.accounts.acct2?.label === "vota");
// usageAt 0 is how the gate tells "configured but never read" from a real reading; a snapshot that
// defaulted it to now() would make an unmeasured account look freshly measured at 0%.
check("an unpinged sub reports no reading", snapshot.accounts.acct1?.usageAt === 0);
check("an unpinged sub has no utilization", snapshot.accounts.acct1?.fiveHour === null);
check("cadence rides along so a consumer can size its staleness bound", snapshot.pingIntervalMs > 0);

publishAccountUsage(snapshot);
const written = JSON.parse(readFileSync(snapshotPath(), "utf8"));
check("published to CLAUDE_ACCOUNT_SNAPSHOT_PATH", snapshotPath() === process.env.CLAUDE_ACCOUNT_SNAPSHOT_PATH);
check("names its writer", written.source === "claude-orchestrator");
check("stamps a liveness heartbeat", typeof written.writtenAt === "number" && written.writtenAt > 0);
check("round-trips every account", Object.keys(written.accounts).sort().join(",") === "acct1,acct2");

console.log(failures ? `\n${failures} check(s) failed` : "\nall checks passed");
process.exit(failures ? 1 : 0);
