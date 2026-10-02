---
paths:
  - server/src/orchestrator/claudeModelRoute.ts
  - server/src/orchestrator/claudeOpusFloor.ts
  - server/src/orchestrator/routeSelection.ts
  - server/src/orchestrator/modelSelector.ts
  - server/src/tests/claudeModelRoute.test.ts
  - server/src/tests/scopedSonnetRouting.itest.ts
---
# Scoped Sonnet routing — which Claude line a task runs

Owner direction 2026-10-02: Sonnet 5.5 "is faster and excels at well-scoped tasks. It scores super low on
agentic coding, but super high on normal coding." It refines the 09-27 "Opus 5.5 only" rule. The Opus
floor still lifts every *configured* Sonnet; the route is the one automatic path to Sonnet.

## Where the decision lives
- `claudeModelRoute.ts` is pure: `routeClaudeModel(evidence)` turns the route classifier's own evidence
  into `{tier, reason, planRefinable}`, persisted as `routeDecision.claudeModel`. Do not add a second
  classifier; extend the evidence `routeSelection.completeDecision` passes in.
- **Locked Opus** (`planRefinable: false`): goal step (detected by `stage.skipQa`, which only goal steps
  set), shotgun lead and its collaborators (`RouteInput.collaborator`: they route their stages on their own
  slice but keep the split's line), duration window, flagship signals, `open-ended/ambiguous`. A tight plan must never move
  these, since a long tool loop on Sonnet is the expensive mistake.
- **Refinable Opus**: structural signals, other risk hits, or a planner route that is not obviously
  contained. `refineClaudeModel` judges the plan ONCE, before the implementor first runs. A plan is tight at
  ≤4 steps and ≤3 named files, with no open questions, no `researcher`, and effort below high. After that
  the line is final, so a session never switches model mid-episode.
- **Sonnet**: narrow scope, or a contained change routed implementor+QA without a planner.
- `ROUTE_POLICY_VERSION` was NOT bumped. A current route lacking `claudeModel` is backfilled
  (`backfillClaudeModel`) only while no implementor has run; one already running keeps its Opus.

## How it applies (threadManager)
- Roles: implementor and QA follow the tier. The reader is Sonnet in the read lane. Director, planner,
  researcher and reviewer always stay on the configured model.
- Precedence, highest first: strict pin (`thread.modelRequest`), usage saving, a per-role Settings matrix
  entry (the sub's row OR the `default` layer, which `claudeRoleConfigured` checks), then the scoped
  Sonnet (`scopedSonnet`), then the configured model with the Opus floor. "Auto" in Settings means
  the matrix row is empty, which is what lets the route choose.
- Auto-selection: `implementorModelRoster({threadId})` offers Claude as the scoped Sonnet ALONE.
  `filterAutoSelectionCandidates` keeps it because no current Opus sits beside it. A saved Sonnet pick
  survives only through `isScopedSonnetPick`; any other Sonnet pick is wiped with a finding.
- Fallback: a Sonnet that is not in the roster, or whose pool is latched capped (`isModelLimited`), runs
  Opus and posts a one-time `Sonnet unavailable: <role> falls back to Opus` finding. A mid-run pool cap goes
  through `modelCapFallback` (`fallbackModelFor` covers Sonnet → `config.sonnetFallbackModel`). A pinned
  Sonnet is exact and parks instead.
- The 🧭 route note carries `Claude model: <id> — <reason>.`. When usage saving or a Settings implementor
  model would overrule the Sonnet, it says so. `scopedSonnetOverruledBy` reads the matrix keys, not
  `accounts.dto()`, because several itest stubs lack `dto`.

## Switch
Settings → Auto model selection → "Sonnet for well-scoped work" (`scopedSonnetRouting`, kv
`setting_scoped_sonnet_routing`, default on). Off = every Claude role on Opus, as before 2026-10-02.

Gates: `test:claude-model-route` (pure, through `selectRoute`), `test:scoped-sonnet` (real ThreadManager).
