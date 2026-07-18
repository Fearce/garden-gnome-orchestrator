# E2E-driving a pipeline lane headlessly (isolated instance, no prod)

When you change **pipeline-level server behavior** — a new dispatch lane, a role
config, a routing decision in `runPipeline`, anything that only manifests once a
real agent runs — a typecheck/build/unit-test proves the wiring but NOT that the
lane actually answers. To see it end-to-end you need a running orchestrator with
your new code and real accounts, but prod (`:4317`) is off-limits and its DB
(`server/data/orchestrator.sqlite`) must never be touched.

The move is a **throwaway harness that drives `ThreadManager` directly against an
isolated DB** — no HTTP/WS/auth/director, deterministic, cheap. This is how the
reader lane (`dispatch_read`) was verified: dispatch real questions, poll to a
terminal state, read cost/latency straight from `agent_runs`.

## Why it's safe

- **`DATA_DIR` isolates the DB.** `config.dbPath` = `resolve(DATA_DIR,
  "orchestrator.sqlite")`, and an explicit `DATA_DIR` always wins over the
  dev/prod default (`config.ts`). Point it at a temp dir → a FRESH DB (your new
  schema/migrations included) that never opens prod's file. **Set it on the
  command line** (`DATA_DIR=<tmp> npx tsx …`), not in the script body — `config.ts`
  reads env at import time (imports hoist), so an in-body assignment is too late.
- **`.env` auto-loads** (`import "dotenv/config"` in `config.ts`), so
  `config.accounts` / `CLAUDE_CODE_OAUTH_TOKEN` are populated exactly as prod has
  them — the harness runs real agents without extra setup.
- It **spawns REAL `claude` subprocesses and burns real account quota**, so keep it
  to a cheap model (a Sonnet reader run is ~$0.1–0.2 / ~20–40s) and a couple of
  questions. Prefer the unit test for pure logic (enforcement lists, allowlists);
  use this only for the "does it actually run" question.
- Name the file `_`-prefixed (the deliverable detector ignores `_`-scratch) and
  **delete it + the temp dir when done** — it is not a committed, repeatable test
  (it costs money and needs live accounts). Commit the *unit* test instead.

## The harness (mirror `index.ts`'s object graph, minus the web/timers)

```ts
// server/src/tests/_e2e_scratch.ts — run: DATA_DIR=/tmp/e2e npx tsx src/tests/_e2e_scratch.ts
import { Db } from "../db/db.js";
import { EventHub } from "../events.js";
import { FileMemoryService } from "../memory/memory.js";
import { AccountManager, type PersistedAccountUsage } from "../accounts/accountManager.js";
import { ResetStagger } from "../accounts/resetStagger.js";
import { ThreadManager } from "../orchestrator/threadManager.js";
import { config } from "../config.js";

const db = new Db(config.dbPath);
const hub = new EventHub();
const memory = new FileMemoryService();
const accounts = new AccountManager(config.accounts, hub, config.accountPingMs, {
  stagger: new ResetStagger(),
  persist: {
    load: (id) => { const v = db.kvGet(`account_usage_${id}`); try { return v ? JSON.parse(v) as PersistedAccountUsage : null; } catch { return null; } },
    save: (id, u) => db.kvSet(`account_usage_${id}`, JSON.stringify(u)),
  },
});
const manager = new ThreadManager(db, hub, memory, accounts);
accounts.start();
// NB: skip startModelCatalog/startWebAutoBuild/startUpdatePoll — not needed, they only add timers/network.

const id = await manager.dispatch({ title: "…", workspace: "<abs repo path>", brief: "…", lane: "read" });

const TERMINAL = new Set(["done", "review", "failed", "cancelled"]);
const deadline = Date.now() + 6 * 60_000;
let state = "queued";
while (Date.now() < deadline) {
  await new Promise((r) => setTimeout(r, 3000));
  state = manager.getThread(id)?.state ?? "gone";
  if (TERMINAL.has(state)) break;
}

// Cost + latency are persisted per run straight from the SDK — read them back:
const run = db.raw.prepare(
  "SELECT model, cost_usd, num_turns, started_at, ended_at FROM agent_runs WHERE thread_id=? AND role=? ORDER BY started_at DESC LIMIT 1"
).get(id, "reader"); // role = the lane's agent role
const answer = db.raw.prepare(
  "SELECT summary, severity, detail FROM findings WHERE thread_id=? ORDER BY created_at ASC"
).all(id);
console.log({ state, run, answer });
process.exit(0); // AccountManager timers keep the loop alive — exit explicitly
```

## Reading the results

- **`agent_runs`** (snake_case): `cost_usd` and `num_turns` come straight from the
  SDK's `total_cost_usd`; latency = `ended_at - started_at` (ms epochs). One row
  per agent run, keyed by `thread_id` + `role`.
- **`findings`**: the agent's posted answer(s) — `severity != 'info'` is usually
  the substantive one; an escalation is a `warning`.
- `manager.dispatch()` (`threadManager.ts`) creates the thread with your `lane`
  and calls `enqueueOrRun` → `runPipeline` immediately (a fresh temp DB has no
  competing tasks, so nothing queues). It returns the thread id synchronously.

## Run it as a background job

Each question is ~20–60s; a few questions can exceed a single foreground command
budget. Launch with `run_in_background` (or `… > log 2>&1 &`) writing to a log,
then poll the log for a done-sentinel — don't block a whole turn on it.

Cross-refs: `add-a-setting.md` / `add-a-thread-column.md` (the change patterns this
verifies), CLAUDE.md § "Debugging a failed task" (the `agent_runs` run-trail columns).
