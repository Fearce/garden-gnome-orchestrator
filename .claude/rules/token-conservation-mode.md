---
paths:
  - server/src/orchestrator/tokenConservation.ts
  - server/src/orchestrator/usageSaving.ts
  - server/src/tests/tokenConservation.test.ts
  - server/src/tests/usageSaving.test.ts
  - server/src/tests/usageSavingResumeDrift.itest.ts
  - server/scripts/token-conservation-lab.cjs
---

# The two model-downgrade features — token conservation's three traps, and usage saving's one

Read before touching `tokenConservation.ts` or either `modelFor`/`providerRoleModel` call site in `orchestrator/threadManager.ts`. CLAUDE.md has the feature shape; this is what a `code-reviewer` pass caught in the shipped diff (all three fixed before commit `4cb4db8` — keep them fixed).

## 1. A permanent pin must opt OUT explicitly, never rely on ordering
`prepareCoworkerRun`'s first Auto Co-work turn resolves a model and FREEZES it as a strict pin for every later turn in that session (`co-work-sessions.md` — "a pin is strict: fail the turn, never substitute"). A transient conservation downgrade landing there is not transient anymore: it is stuck even after the window resets, for the rest of the session's life. `modelFor`/`providerRoleModel` both take an `opts.conserve` flag for exactly this — Co-work's two call sites (`threadManager.ts`, the `account.id` / `"codex"` implementor branches around the Auto Co-work kickoff) pass `conserve: false`. **Any future per-role model-selection knob must do the same at those two call sites** — the freeze is a property of Co-work's session model, not of this feature, so the next knob will hit it too.

## 2. Don't invert an existing predicate whose fail-direction was tuned for the OPPOSITE case
The natural shortcut for "is this model already cheap?" is to negate `modelRoutingPolicy.isPolicyApprovedFlagship`. Don't: that predicate fails CLOSED (an unreviewed model id is excluded from flagship-only routing — the safe direction when the risk is "let something unvetted run as a flagship"). Inverting it here flips the risk the OTHER way: an unreviewed id would read as "already cheap" and skip conservation, i.e. fail OPEN — a newly released or simply unlisted model would silently never be conserved. `TOKEN_CONSERVATION_ECONOMY_MODELS` is a separate, explicit allowlist that fails toward conserving instead: an id it has never seen gets downgraded once, which is cheap insurance against quietly burning the reserve on a model nobody has reviewed for this feature yet. When two checks look like the same predicate, check which direction each one fails before reusing either.

## 3. Conservation must not cross a DEDICATED Codex pool — in EITHER direction
`conservationResolvedModel` only ever compares model IDs, and which BUDGET a Codex model spends is not a property of its id: a model with a dedicated pool (Spark today) is metered by its own independent 5h/weekly windows and its own cap latch (`poolForModel`, `agents/codexPools.ts`), and never touches the general weekly window this feature protects. So the Codex caller must use `conservationResolvedCodexModel`, which injects a live pool predicate and guards both sides:

- **The CONSERVED model is on a dedicated pool** — resolving to it would silently spend THAT pool's own
  cap latch instead of the general window. Falls back to the unconserved `base`. Inert today (no overlap
  between the two current lists), but the lists are maintained independently.
- **The BASE model is already on a dedicated pool** — downgrading it MOVES the run off an independent,
  frequently idle allowance and onto the very window we are conserving. Strictly worse than doing
  nothing. Passes through. This one was NOT inert: it shipped live for one commit when
  `gpt-5.3-codex-spark` was dropped from `TOKEN_CONSERVATION_ECONOMY_MODELS` (correctly, as an id-tier
  judgement) without anyone asking which pool it spends. Reachable via any operator Codex model-matrix
  override or `setting_codex_model` naming a dedicated-pool model.

The lesson generalizes past Spark: **an economy-tier ALLOWLIST answers "is this model cheap?", never "whose budget does it charge?"** — the second question needs the runtime pool map, so it cannot live in this module and must not be inferred from the id.

A caller with no live pool snapshot passes an always-false predicate and conserves, matching `conservationActive`'s "missing data biases toward conserving" contract.

## Also worth knowing
- **No-op under `autoModelSelection`** when the selector actually produces a pick — both resolve before this layer runs. A per-TASK exemption, not per-setting: a selector that declines (an adaptive task with no usable answer) leaves the implementor on `modelFor`, which DOES conserve, same as planner/QA/reviewer always do via `runRole`. Judged proportionate, not fixed — revisit only if the two are found to matter together in practice.
- Only Claude and Codex have a reviewed flagship/economy split today; Grok ships one model and z.ai has none, so `TOKEN_CONSERVATION_MODEL` has no entry for either and both pass through untouched.

## The OTHER downgrade feature: Usage saving — and why a resume has to re-derive its model
`settings.usageSaving` (per-subscription card, `orchestrator/usageSaving.ts`) is a separate control from the toggle above and is the one that is ON in production. It fires on EITHER meter (5h **or** weekly), and while active it outranks the role override matrix, a strict owner pin and an auto-selection pick. Same 90% default and same `claude-sonnet-5` target as conservation, which is exactly why a report naming one usually means the other — check `setting_usage_saving` before `setting_token_conservation_mode`.

Its trap is not activation but **de**activation, because a session id is bound to the model that created
it: a model change can only land by starting a FRESH session, so a drift guard is the only thing that
decides whether a task ever climbs back up a tier. There are two, and both are required — `startResumedImplementor` for the implementor, and one inside `runRole`'s attempt loop for the one-shot roles (QA, reviewer, planner, reader), which resume through a different path entirely. Four rules across them:
- **Compare against what a fresh dispatch would pick, falling through to the ordinary default** — not just saving/pin/pick. Stopping at those three leaves the compared model `undefined` in the ordinary case, so the guard sees a downgrade turning ON but never one turning OFF. One transient dip past the threshold then pins the task to the economy model for the rest of its episode: task 6bf166a5 stayed on Sonnet for 5h after its sub's weekly window had rolled over to 69%.
- **Drift sets `forceFresh`; it does NOT clear the session id.** The id is unusable in place but is still the best context its replacement can have, so keeping it routes the restart through the compressed handoff (or the CLI recovery history) instead of the bare kickoff. Clearing it restarts a long task from zero — the "starting again and again" the owner has already asked to stop.

- **The guard must resolve the model exactly as the DISPATCH will, or it restarts healthy sessions.** The implementor's goes through the shared `implementorDispatchTarget`, and the resume selects the subscription itself and hands it down, because the model depends on the account. Reading the auto-pick without its provider, or guessing the account with a demand-less `dispatchPreview()`, each made a false drift fire on ordinary resumes.
- **A one-shot role's check belongs INSIDE `runRole`'s loop**, after the account is selected — a mid-run failover re-selects it, so nothing earlier can answer without guessing. An unknown session binding means "no drift": discarding a usable session costs a full rediscovery.

Gate: `test:usage-saving-resume-drift`, every fixture revert-checked.

## Verify
`npx tsx src/tests/tokenConservation.test.ts` (pure-logic unit gate, registered as `test:token-conservation` in both `server/package.json` and `GATES` in `scripts/run-gates.cjs`), then `npm run token-conservation-lab --prefix server` for the Settings-toggle + restart-persistence round trip against a throwaway instance (never prod). `npm run typecheck && npm run build` for the wiring.
