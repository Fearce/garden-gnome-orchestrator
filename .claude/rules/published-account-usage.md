---
paths:
  - server/src/accounts/usageSnapshot.ts
  - server/src/accounts/accountManager.ts
  - server/src/agents/runner.ts
---

# Per-subscription usage published to Claude Code's own hooks

Two things leave this process so tooling OUTSIDE it can tell which subscription a
given agent session is burning. They are a **contract with
`~/.claude/usage-watcher/handoff_gate.py`** — a rename or removal here silently
breaks it, and the failure mode is invisible from this repo.

1. **`buildEnv` (`runner.ts`) publishes the run's identity** as non-secret env
   vars — `CLAUDE_ORCH_PROVIDER` (`claude` | `zai`), and for a configured sub
   `CLAUDE_ORCH_ACCOUNT_ID` + `CLAUDE_ORCH_ACCOUNT_LABEL`. The id is derived from
   the token the run actually authenticates with (`accountForToken`), never
   threaded in separately, so the label can't drift from the credential. Every
   branch of `buildEnv` must state its own identity: this process may itself have
   been started from an agent shell, so an inherited value would mislabel runs.
   No account id = the run rides the inherited CLI login, which is exactly what
   the watcher's machine-global path already measures.
2. **`publishAccountUsage` rewrites `~/.claude/state/orchestrator-accounts.json`**
   on every `accounts` hub event (wired in `index.ts`). It carries raw readings —
   `usageAt`, `stale` — not a verdict, so each consumer applies its own policy,
   and `writtenAt` doubles as this server's liveness heartbeat for them.

## Why nobody else may just measure the subs

Agents run on `claude setup-token` credentials, which **403 on Anthropic's
`/api/oauth/usage`**. The only other per-account read is a real `/v1/messages`
call — which STARTS an idle 5h window, so an external poller would silently
undo the reset stagger `accountManager.ts` works to maintain. `AccountManager`'s
Haiku ping is the one sanctioned reader; this snapshot is how everyone else sees
the result.

We are not the only dispatcher on this contract: `C:\trading_orchestrator` runs its
own concurrent wrappers on saved account snapshots and publishes
`trading-fleet-accounts.json` the same way. The gate never merges the two — a session
reads the file its own dispatcher named via `CLAUDE_ACCOUNT_SNAPSHOT_PATH` — so keys
are ours to choose and **our readings never speak for its wrappers, or the reverse.**

## Before you change it

- Renaming a var or the file? Update `handoff_gate.py` + its README in the same
  change, then re-run `python ~/.claude/usage-watcher/smoke_test.py` (expects
  `18/18 passed`) — it exercises the real gate against a seeded snapshot.
- A cheap end-to-end check that the vars actually reach a hook (Claude Code
  scrubs `CLAUDE_CODE_OAUTH_TOKEN` from child processes, so "it's in the env"
  is not obvious): run `claude -p` with the identity vars +
  `CLAUDE_ACCOUNT_SNAPSHOT_PATH` set to a seeded temp snapshot and ask the model
  whether its context contains `USAGE-LIMIT WARNING`. A capped account must
  answer WARN and a healthy one NONE.
- `usageSnapshot()` is deliberately NOT `dto()`: an external consumer needs the
  time of the READING, where `dto().updatedAt` is the time of the last state
  change.
