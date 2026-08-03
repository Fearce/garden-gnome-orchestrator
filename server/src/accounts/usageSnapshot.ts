import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { logCrash } from "../crashLog.js";

/**
 * Publishes each Claude subscription's live usage where Claude Code's own tooling can read it.
 *
 * The problem it solves: agents run on per-account setup-tokens, but anything OUTSIDE this process
 * that wants to know "is Claude usage high?" can only read the one account in the global
 * `~/.claude/.credentials.json`. A machine-global signal derived from that single account fires in
 * every session on the box — including sessions burning a different subscription entirely. The
 * consumer today is the usage watcher's handoff hook (`~/.claude/usage-watcher/handoff_gate.py`),
 * which pairs this file with the `CLAUDE_ORCH_ACCOUNT_ID` env var `runner.ts` publishes into each run.
 *
 * Setup-tokens 403 on Anthropic's `/api/oauth/usage`, and the only other per-account read is a real
 * `/v1/messages` ping — which STARTS an idle 5h window and would wreck the reset stagger. So a
 * consumer must not measure the subs itself; this is the one non-destructive source, and it carries
 * raw readings (`usageAt`, `stale`) rather than a verdict so each consumer applies its own policy.
 */

export interface AccountUsageEntry {
  label: string;
  /** 5-hour-window utilization 0-100, or null when the account has never been read. */
  fiveHour: number | null;
  /** Weekly-window utilization 0-100, or null when the account has never been read. */
  sevenDay: number | null;
  /** Epoch ms of the reading itself — 0 when never read. NOT the file's write time. */
  usageAt: number;
  /** The last ping failed and the reading has aged out; the numbers are not trustworthy. */
  stale: boolean;
  /** Operator toggle — a disabled account is held out of dispatch, so nothing new burns it. */
  enabled: boolean;
}

export interface AccountUsageSnapshot {
  source: "claude-orchestrator";
  /** Epoch ms this file was written. Doubles as the orchestrator's liveness heartbeat: it is rewritten
   *  on every account-state publish, and the periodic usage ping publishes at least every
   *  `pingIntervalMs`, so a much older file means nobody is maintaining these numbers. */
  writtenAt: number;
  /** The account-usage ping cadence, so a consumer can derive its own staleness bound instead of
   *  guessing one that breaks when the operator flips "Fast usage polling". */
  pingIntervalMs: number;
  /** Keyed by account id — the same id `runner.ts` publishes as `CLAUDE_ORCH_ACCOUNT_ID`. */
  accounts: Record<string, AccountUsageEntry>;
}

/** Inside `~/.claude/state` so a Claude Code hook finds it without knowing where this orchestrator is
 *  installed. `CLAUDE_ACCOUNT_SNAPSHOT_PATH` overrides it (tests, a second instance). */
export function snapshotPath(): string {
  return process.env.CLAUDE_ACCOUNT_SNAPSHOT_PATH || join(homedir(), ".claude", "state", "orchestrator-accounts.json");
}

/**
 * Write the snapshot atomically. Best-effort by design: publishing usage for an external hook must
 * never be able to break account management, so a failure is recorded and swallowed.
 */
export function publishAccountUsage(usage: { accounts: Record<string, AccountUsageEntry>; pingIntervalMs: number }): void {
  const snapshot: AccountUsageSnapshot = {
    source: "claude-orchestrator",
    writtenAt: Date.now(),
    pingIntervalMs: usage.pingIntervalMs,
    accounts: usage.accounts,
  };
  const target = snapshotPath();
  const tmp = `${target}.${process.pid}.tmp`;
  try {
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(tmp, JSON.stringify(snapshot, null, 2));
    renameSync(tmp, target);
  } catch (e) {
    logCrash("accountUsageSnapshot.write", e);
  }
}
