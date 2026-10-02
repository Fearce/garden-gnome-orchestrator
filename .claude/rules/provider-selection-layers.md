---
paths:
  - server/src/accounts/accountManager.ts
  - server/src/orchestrator/threadManager.ts
---

# "Provider" spans backends AND subs — routing/balancing lives in TWO layers

Read before any task that changes how dispatches are ROUTED or BALANCED ("prefer X",
"spread usage", "route to the least-used one", "fail over differently"). In this app
**"provider" / "platform" means every enabled backend — the Claude subscriptions AND
Codex AND Grok AND z.ai** — NOT just the Claude subs. A brief that says "across all providers"
almost always needs BOTH layers below; touching only one silently half-implements it
(the reason the spread-usage toggle took a correction round).

## The two selection layers

1. **Which Claude SUBSCRIPTION** — `AccountManager` (`accounts/accountManager.ts`).
   `select()` / `dispatchPreview()` / `selectFailover()` all sort the sub pool through
   `primaryOrder(allOverSafety)`, which picks one comparator:
   `bySafetyFallbackPriority` (all over their soft ceiling) → else `bySpreadUsage`
   (spread on) → else `bySelectionPriority` (default: soonest weekly reset first).
2. **Which BACKEND** — `threadManager.preferredImplementorProvider(candidates)`. The
   candidates are `{claude, codex?, grok?, zai?}` `ProviderCandidate`s. It picks a comparator
   the SAME shape: `providerSafetyFallbackPriority` → else `providerSpreadUsage` (spread on)
   → else `providerPriority` (default: soonest reset). There is no per-backend "prefer"
   override — every enabled backend auto-competes on usage (the owner removed the toggles).

**They compose, they don't duplicate.** `dispatchPreview()` yields the Claude candidate
already resolved to its *best sub* (layer 1), then layer 2 compares that sub's usage
against Codex/Grok. So "balance across everything" = layer 1 balances the subs *inside*
Claude, layer 2 balances Claude-vs-Codex-vs-Grok. Add a new routing policy = add a
parallel comparator in BOTH files (`byX` + `providerX`) and flip to it in both places.

## The reset burn sits ABOVE both comparators
"Prepare a sub for reset" (Settings → Usage & limits, kv `setting_reset_burn`, logic in
`orchestrator/resetBurn.ts`) names ONE sub (a Claude account id or `codex`) that takes every
dispatch it has HARD headroom for. It is not a comparator: layer 1 returns the target before
the capacity tier, the soft weekly ceiling and `primaryOrder` (`selectionPool` /
`selectFailover` → `burningAmong`), and layer 2 returns its candidate first in
`preferredProviderCandidate` (`burningCandidate`). Callers that cut by runway BEFORE layer 2
(`nextReadyImplementor`, the two different-provider QA pickers) check `burningCandidate` first,
and auto model selection / unpinned goal steps get a roster narrowed to the target (`burningEntries`;
`routeForPick` drops a saved pick on another sub). What still moves work off it: a cap or the
98% hard limit, a disabled account, an owner model pin, and provider intent named in the brief.
While active it also skips that sub's usage-saving model and token conservation, makes
planner/reader skip free providers, and steers the Director (`chooseTarget`). Goals do not pace it:
`implementorModelRoster` marks its roster entries `resetBurn`, `poolOverPace` never holds those, and
`goalModelRoster` keeps the OTHER pools too (`checkBurnRate` narrows only an unpinned goal to the
target), so a goal pinned to another pool, or a step that failed over onto one, is still paced; and
`GoalRunner` re-checks goals held for usage the moment a settings broadcast names a new burn target. It ends the moment
a redeem of that sub's banked reset succeeds (`resetCreditRedeemed`, from the hub), and as a
backstop in `ThreadManager.resetBurn()` once the anchored weekly window passes or rolls early (a
reset spent in the native app) — so read it through `resetBurn()`, never the raw kv. Tests:
`test:reset-burn` (lifecycle), `test:account-usage` + `test:provider-fallback` (routing,
failover, redeem), `test:auto-model` (roster), `reset-burn-lab` (the picker in a real browser).

## Conventions that bite
- Codex/Grok usage is real and comparable: their weekly `sevenDay` % comes from
  `codexUsagePing` / `grokUsagePing` and each carries a `weeklySafetyPct`. Don't assume
  "only Claude has comparable usage" — that assumption is what caused the mis-scope.
- Provider comparators have no `lastPick`; substitute soonest-reset as the final
  tiebreak (there's no per-backend round-robin counter).
- `nextReadyImplementor` (cross-provider failover) also routes through
  `preferredImplementorProvider`, so a policy change there covers failover for free.

Both comparator sets are pure + exported (`bySpreadUsage`, `providerSpreadUsage`,
`bySafetyHeadroom`) — unit-test them directly (`test:spread-usage`, `test:weekly-safety`),
no ThreadManager harness needed.
