---
paths:
  - server/src/accounts/accountManager.ts
  - server/src/orchestrator/threadManager.ts
---

# "Provider" spans backends AND subs — routing/balancing lives in TWO layers

Read before any task that changes how dispatches are ROUTED or BALANCED ("prefer X",
"spread usage", "route to the least-used one", "fail over differently"). In this app
**"provider" / "platform" means every enabled backend — the Claude subscriptions AND
Codex AND Grok** — NOT just the Claude subs. A brief that says "across all providers"
almost always needs BOTH layers below; touching only one silently half-implements it
(the reason the spread-usage toggle took a correction round).

## The two selection layers

1. **Which Claude SUBSCRIPTION** — `AccountManager` (`accounts/accountManager.ts`).
   `select()` / `dispatchPreview()` / `selectFailover()` all sort the sub pool through
   `primaryOrder(allOverSafety)`, which picks one comparator:
   `bySafetyFallbackPriority` (all over their soft ceiling) → else `bySpreadUsage`
   (spread on) → else `bySelectionPriority` (default: soonest weekly reset first).
2. **Which BACKEND** — `threadManager.preferredImplementorProvider(candidates)`. The
   candidates are `{claude, codex?, grok?}` `ProviderCandidate`s. It picks a comparator
   the SAME shape: `providerSafetyFallbackPriority` → `grokPreferred` override → else
   `providerSpreadUsage` (spread on) → else `providerPriority` (default: soonest reset).

**They compose, they don't duplicate.** `dispatchPreview()` yields the Claude candidate
already resolved to its *best sub* (layer 1), then layer 2 compares that sub's usage
against Codex/Grok. So "balance across everything" = layer 1 balances the subs *inside*
Claude, layer 2 balances Claude-vs-Codex-vs-Grok. Add a new routing policy = add a
parallel comparator in BOTH files (`byX` + `providerX`) and flip to it in both places.

## Conventions that bite
- Codex/Grok usage is real and comparable: their weekly `sevenDay` % comes from
  `codexUsagePing` / `grokUsagePing` and each carries a `weeklySafetyPct`. Don't assume
  "only Claude has comparable usage" — that assumption is what caused the mis-scope.
- Provider comparators have no `lastPick`; substitute soonest-reset as the final
  tiebreak (there's no per-backend round-robin counter).
- `nextReadyImplementor` (cross-provider failover) also routes through
  `preferredImplementorProvider`, so a policy change there covers failover for free.
- `grokPreferred` is an explicit override applied BEFORE the comparator — it still wins
  over any balancing policy. Keep it first.

Both comparator sets are pure + exported (`bySpreadUsage`, `providerSpreadUsage`,
`bySafetyHeadroom`) — unit-test them directly (`test:spread-usage`, `test:weekly-safety`),
no ThreadManager harness needed.
