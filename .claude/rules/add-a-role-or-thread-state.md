---
paths:
  - server/src/types.ts
  - server/src/agents/roles.ts
  - server/src/orchestrator/threadManager.ts
  - web/src/types.ts
---

# Adding an agent ROLE or a THREAD STATE (the two seams TypeScript only half-guards)

For a new one-shot agent (the `reviewer` auto-review lane and the `reader` read lane are the
references) and/or a new `ThreadState`. Some spots are `Record<Role|ThreadState, …>` and fail the
build when you miss them — **the ones that bite are the plain Sets, the free-text role arrays, and
the pipeline gates, which all compile fine and break at runtime.** (For a knob use `add-a-setting.md`;
for a persisted entity `add-a-broadcast-collection.md`.)

## A new ROLE
1. `server/src/types.ts` — `Role` union + `ROLE_RANK` (office names). `config.ts` — `models.<role>`.
2. `agents/prompts.ts` — `<ROLE>_PROMPT`. `agents/roles.ts` — `<role>Config()` + its `*_SCHEMA`
   (structured output is how the pipeline reads the verdict; make control-flow fields `required`).
   Read-only = `disallowedTools` under `bypassPermissions` (a HARD block), never prompt-only.
3. `threadManager.ts` — add it to the `StructuredRole` union (`runRole` + `cliRoleKickoff` share it),
   then a `run<Role>()` that calls `runRole` with per-(thread, role) `createBusServer`/`createOfficeServer`.
4. **`NO_CLI_FAILOVER`** — add the role if it needs in-process MCP tools (`post_finding`, `ask_user`).
   Codex/Grok have none, so a cap-failover there silently strips the role's only channel.
5. `dropTerminalBookkeeping` + `retryThread` — both iterate a **hand-written role array** for the
   `checkedIn` office keys. Not typed: a miss leaks one Set entry per finished task, forever.
6. Web mirror: `web/src/types.ts` (`Role` + `ROLE_RANK`), `styles.css` **`--role-<x>`** (`roleColor`
   builds `var(--role-${role})` — a missing var renders unstyled, no error), `Gnome.tsx` `roleProp`
   (default `null` = a propless gnome), `ThreadDetail.tsx` `ROLE_ORDER` + `FILTER_ORDER`,
   `Board.tsx` `pipRoles`.
7. **`scripts/probe-run-errors.cjs` `ROLE_TURN_CEILING`** — if your role sets `maxTurns`. Missing, an
   opaque row at its ceiling degrades to "unclassifiable" and the sweep reports a benign cutoff as
   needing a human (`reviewer` shipped unenrolled). `test:run-classify` pins the map to `roles.ts`;
   an unbounded role (director) must stay OUT — a ceiling it can't hit files a runaway as benign.
8. **Decide what `error_max_turns` does — a bounded role WILL hit its ceiling.** That stop is
   involuntary (the agent was mid-work), so a role whose structured verdict GATES a settle must
   CONTINUE the cut-off session in a fresh query before giving up, or a paid Opus pass is discarded
   and the task lands on the owner for a reason that says nothing about the work. QA
   (`continueCutOffQa`, durable `qaCutoffResumes`) and the reviewer (`reviewToVerdict`, in-process)
   are the references — durable only if the state auto-resumes across a restart. A role that merely
   degrades (planner → brief-only implementor) or whose park IS the design (reader → re-dispatch)
   correctly does nothing. Both gates shipped without this and parked real tasks.
9. **Then decide what an EMPTY run does — the same stop wearing a success suit.** A session the CLI
   loaded and exited without reaching the model returns subtype `success` with 0 turns, $0 and NO
   structured output, so every `isTurnLimitStop`/`isError` branch misses it and the absent verdict reads
   as the role's answer. Detect it from the absence of output (`ranSilently(threadId, role, from, res)`
   over `countAgentMessagesSince`, `from` stamped BEFORE the spawn), stamp the row via `markSilentRun`
   (else the run history keeps a `done` 0-turn row and the sweep can't see the failure), and recover
   FRESH — re-waking the same session is the one thing already known not to work. `retrySilentQa` /
   `reviewToVerdict` are the references. Add the role to `SilentCapableRole`.

## A new THREAD STATE
1. `server/src/types.ts` — the union, then audit **every set** in `threadManager.ts`: `IN_FLIGHT`,
   `AUTO_RESUME_STATES`, `PRE_IMPLEMENTOR`, `CLOSEABLE`, `DONEABLE`. Plain `ReadonlySet`s — silent.
2. **`markInterrupted`** — an `IN_FLIGHT` state with no branch is stamped `failed` + "click Resume",
   which re-enters the implementor pipeline. A state that owns already-finished work needs its own
   branch restoring where it came from.
3. **The inject/resume gates — the one that actually bites.** `injectThread` and `resumeThread` walk
   states in order and FALL THROUGH to a cold resume, which spawns an implementor. If a one-shot
   agent owns the slot in your state, add a gate beside the `qa` ones: hold a `live<Role>` handle
   (set/cleared in `runRole`, cleared in `cancelThread`/`retryThread`/`forceStopThreadRuns`) and
   `send` steering to it — never `interrupt()`, which tears a schema-bound one-shot down into a
   verdict-less error result. Without the gate you get two agents in one slot.
4. Web mirror: `web/src/types.ts`, `Board.tsx` `STATUS_RANK` (a `Record` — the build catches this
   one), and `lib/format.ts` `stateColor` / `stateLabel` / `threadRunning` / `isTerminal` /
   `isDoneable` / `isClosable` (switches with a `default` — all silent).

## Verify
`npm run typecheck && npm run build`, then a **ThreadManager itest** (`threadmanager-itest.md`) that
stubs only `runRole` and proves: the settle paths (including that an errored/verdict-less run never
reads as success), the state gate (assert no implementor spawned), and `markInterrupted`. Do the
revert-check — gates 2 and 3 above were both proven load-bearing that way, and both looked fine
until reverted. Register the gate in `package.json` + `scripts/run-gates.cjs`. Then drive the button
in a browser on a throwaway instance (`browser-test-throwaway-instance`) — a real click spawns a real
agent, so `Cancel` is your stop; and re-seed the row between runs, the drive isn't idempotent.
