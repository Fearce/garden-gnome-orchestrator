---
paths:
  - server/src/orchestrator/tokenConservation.ts
  - server/src/tests/tokenConservation.test.ts
  - server/scripts/token-conservation-lab.cjs
---

# Token conservation mode — the three traps that bit during review

Read before touching `tokenConservation.ts` or either `modelFor`/`providerRoleModel` call site in
`orchestrator/threadManager.ts`. CLAUDE.md has the feature shape; this is what a `code-reviewer` pass
caught in the shipped diff (all three fixed before commit `4cb4db8` — keep them fixed).

## 1. A permanent pin must opt OUT explicitly, never rely on ordering
`prepareCoworkerRun`'s first Auto Co-work turn resolves a model and FREEZES it as a strict pin for every
later turn in that session (`co-work-sessions.md` — "a pin is strict: fail the turn, never substitute").
A transient conservation downgrade landing there is not transient anymore: it is stuck even after the
window resets, for the rest of the session's life. `modelFor`/`providerRoleModel` both take an
`opts.conserve` flag for exactly this — Co-work's two call sites (`threadManager.ts`, the `account.id` /
`"codex"` implementor branches around the Auto Co-work kickoff) pass `conserve: false`. **Any future
per-role model-selection knob must do the same at those two call sites** — the freeze is a property of
Co-work's session model, not of this feature, so the next knob will hit it too.

## 2. Don't invert an existing predicate whose fail-direction was tuned for the OPPOSITE case
The natural shortcut for "is this model already cheap?" is to negate
`modelRoutingPolicy.isPolicyApprovedFlagship`. Don't: that predicate fails CLOSED (an unreviewed model id
is excluded from flagship-only routing — the safe direction when the risk is "let something unvetted run
as a flagship"). Inverting it here flips the risk the OTHER way: an unreviewed id would read as "already
cheap" and skip conservation, i.e. fail OPEN — a newly released or simply unlisted model would silently
never be conserved. `TOKEN_CONSERVATION_ECONOMY_MODELS` is a separate, explicit allowlist that fails
toward conserving instead: an id it has never seen gets downgraded once, which is cheap insurance against
quietly burning the reserve on a model nobody has reviewed for this feature yet. When two checks look
like the same predicate, check which direction each one fails before reusing either.

## 3. A downgraded model can collide with a DEDICATED pool's own slug
Codex's economy pick (`gpt-5.6-luna`) is a plain string, and a dedicated Codex pool (Spark, etc.) is
keyed by matching a model slug too (`poolForModel`, `agents/codexPools.ts`). If conservation's economy
model ever equals a dedicated pool's slug, resolving to it would silently spend THAT pool's own cap latch
instead of the general 5h/weekly window conservation is meant to protect — a different budget, tracked
and reset independently. `providerRoleModel`'s Codex branch checks `poolForModel(pools,
conserved)?.modelSlug` and falls back to the unconserved `base` model rather than let that happen. Inert
today (no overlap between the two current economy lists), but keep the guard — the two lists are
maintained independently and nothing stops a future one from colliding.

## Also worth knowing
- **No-op under `autoModelSelection`** when the selector actually produces a pick — both resolve before
  this layer runs. This is a per-TASK exemption, not per-setting: if the selector declines (an adaptive
  task with no usable answer), the implementor falls back to `modelFor` and DOES conserve, same as
  planner/QA/reviewer always do via `runRole`'s own `modelFor` call. Judged proportionate, not fixed —
  revisit only if conservation and auto-select are found to matter together in practice.
- Only Claude and Codex have a reviewed flagship/economy split today; Grok ships one model and z.ai has
  none, so `TOKEN_CONSERVATION_MODEL` has no entry for either and both pass through untouched.

## Verify
`npx tsx src/tests/tokenConservation.test.ts` (pure-logic unit gate, registered as
`test:token-conservation` in both `server/package.json` and `GATES` in `scripts/run-gates.cjs`), then
`npm run token-conservation-lab --prefix server` for the Settings-toggle + restart-persistence round trip
against a throwaway instance (never prod). `npm run typecheck && npm run build` for the wiring.
