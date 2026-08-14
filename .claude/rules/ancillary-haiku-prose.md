---
paths:
  - server/src/orchestrator/titleFromInjection.ts
  - server/src/orchestrator/voiceAnnounce.ts
  - server/src/orchestrator/resumeCompress.ts
  - server/src/bus/directorServer.ts
---

# Prompts whose output becomes an artifact (board titles, spoken lines, handoffs)

Three surfaces call Haiku directly over the raw OAuth fetch — `titleFromBrief`/
`titleFromInjection` (the board lane label), `haikuLine` → `completionAnnouncement` (a
sentence read aloud), `resumeCompress`'s `SUMMARY_PROMPT` (a handoff). They are NOT agent
roles: nobody reviews the reply, and it lands somewhere the owner sees or hears. Two traps,
both paid for on 2026-08-14.

## Never assert what the owner's request IS

The titler asked for "what a **coding task** is being asked to do". Hand that a World of
Warcraft server bug written in game terms and the model disputes the premise instead of doing
the job — the board read `This is not a coding task - it's a gaming bug report about World
of…`, and the owner's reaction ("how is a bug report not a coding task???") is the spec.
A prompt that states a premise the input might contradict invites an argument about the
premise. Describe the JOB ("name what is being asked for, in the requester's own vocabulary"),
never the input's nature — and say outright that however it is worded, it is real work.
The same framing sat in `ANNOUNCE_PROMPT`, where the argument would have been spoken aloud.

## The reply is model output — validate it before it is persisted

A prompt only has to slip once, and a title persists. Every one of these surfaces already has
a correct fallback, so use it: the title falls back to the owner's own first line (via `null`,
after ONE corrective retry that tells the model plainly what it did), the announcement to
`Task complete: <title>.`. A false positive costs the fallback, which is fine; a false
negative is on the board forever. Bias toward rejecting.

**Two predicates, not one** (`titleFromInjection.ts`) — the split is load-bearing:
- `disputesTheWork` — "not a coding task", "a gaming bug report rather than…". Applies to ANY
  model prose about the request, spoken lines included.
- `looksLikeCommentary` — that plus start-anchored openers (`^I`, `^This`, `^Sorry`, `^The
  request`). LABELS only: a natural spoken sentence legitimately opens "I've put the…".
Keep openers start-anchored and never free-float a modal — "Fix crash when players cannot
enter vehicles" is a real title.

## Gate it free — stub `globalThis.fetch`

No SDK, no quota: these helpers use global `fetch`, so a stub returns a canned
`{content:[{type:"text",text}]}` and records the prompt sent (`autoTitle.test.ts`,
`voiceAnnounce.test.ts` — the latter answers the gateway `/api/status` probe too). Assert the
old framing CANNOT come back (`doesNotMatch(/a coding task/)`), and keep the real bad string
verbatim as a dated ledger entry. Revert-check each half separately; they fail differently.

Cross-refs: `tune-a-text-heuristic.md` — the mirror case (a predicate reading the owner's
prose) and the fix-all-three-surfaces rule that applies here too: predicate, role prompt, and
the MCP tool description in `directorServer.ts` that names the title the director picks itself.
