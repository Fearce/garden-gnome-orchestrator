---
paths:
  - server/src/orchestrator/director.ts
  - server/src/agents/prompts.ts
  - server/src/bus/directorServer.ts
  - server/src/tools/probeScheduleDetect.ts
  - server/src/tests/scheduleDetect.test.ts
---

# Tuning a heuristic that classifies the owner's prompts

For any rule that reads the owner's natural language and changes what happens —
`looksLikeScheduleRequest` (director.ts) is the reference; the read-lane routing and
the office/CLI extractors are the same shape. These regress in ONE direction: they
over-fire, the owner gets nagged, and "it reads too many things like X" comes back.

## The owner's sentence IS the spec
When they state the bar in words ("it's never a scheduled task unless I specifically
say *schedule* and *task*"), implement THAT literally — don't preserve the old
cleverness underneath it. The 2026-07-26 fix deleted the whole frequency-adverb +
action-verb branch rather than patching one more exception onto it.

## Fix all three surfaces, not just the predicate
The same judgment is usually encoded three times, and the code one is the least
powerful:
1. the predicate in `server/src/orchestrator/*.ts` (fires a note / routes a lane),
2. the ROLE PROMPT that tells the model when to act (`agents/prompts.ts`),
3. the MCP TOOL DESCRIPTION it reads before calling (`bus/directorServer.ts`).
Tighten only #1 and the director keeps creating cron entries off "nightly" — #2/#3
are what actually act. Grep the concept word across all three before you commit.

## Write the failing gate from the REAL message
Paste the owner's actual prompt verbatim into `src/tests/scheduleDetect.test.ts`
(gate `test:schedule-detect`) and watch it fail first. That file is a dated ledger of
every past regression — two so far — so a future "make it catch more" can't silently
undo a fix. Registered in `scripts/run-gates.cjs` like every free gate.

## Then replay it over the real corpus — unit cases only prove the rule you imagined
```
npm run probe:schedule-detect --prefix server                       # 400+ real prompts
npm run probe:schedule-detect --prefix server -- --text "run it nightly"
```
`director_messages` (role='user') is a corpus of everything the owner has ever typed
at this console. The probe (`src/tools/probeScheduleDetect.ts`, read-only, safe while
prod runs) prints FLAGGED (must all be genuine asks) and NEAR MISS (schedule-ish but
not flagged — scan for a real ask you now miss). The schedule fix went 10 → 1 flagged
with 0 newly flagged across 407 prompts; that number is the evidence, not the gate.
Copy the file for another classifier — it's ~60 lines.

**Put a probe like this in `src/tools/*.ts`, not `scripts/*.cjs`.** It must import the
predicate from SOURCE: `scripts/` is outside tsconfig's `rootDir: src` so a `.ts` there
is never typechecked, and a `.cjs` could only `import()` `dist/`, which replays the OLD
rule you just edited — a silent lie exactly when you need the truth.

## Bias and gotchas
- **Precision over recall.** Say the asymmetry out loud in the doc comment: a miss
  costs one absent reminder; a false positive nags on every task that mentions a
  frequency. When torn, don't fire.
- `\bschedule\b` — without the trailing `\b`, "scheduler" matches.
- **Verb proximity is a weak discriminator** in a sentence with several verbs: "add a
  delete button to the scheduled tasks panel" matched a `<change-verb> … scheduled
  task` window via *delete*. Exclude a feature request ABOUT the surface by the noun
  that TRAILS the phrase (panel/view/list/column/button…), not by the verb before it.
- This repo IS the orchestrator, so prompts about the scheduler/office/QA features are
  common — always test your rule against "a feature request about the thing itself".

Verify: `npm run typecheck && npm run test:schedule-detect --prefix server`, then the
probe. Server change ⇒ deploy it yourself (CLAUDE.md § "Deploying a change").
Mirror case — prose the model WRITES rather than reads (titles, spoken lines): the same
three surfaces apply, plus a guard on the reply. See `ancillary-haiku-prose.md`.
