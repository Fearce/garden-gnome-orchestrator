---
paths:
  - server/src/agents/runner.ts
  - server/src/orchestrator/threadManager.ts
  - server/src/config.ts
---

# Adding an implementor backend (a new `provider` across the routing seam)

For a whole new agent backend the implementor can run on — the reference adds are **z.ai**
(Anthropic-compatible, reuses AgentRun) and **Codex/Grok** (custom CLI runners). Decide
WHETHER/WHICH-flavor first in `model-backend-economics.md`; this is the WHERE-to-touch
checklist. `provider-selection-layers.md` covers the routing/balancing comparators. A miss
typechecks fine but silently strands the backend at that layer — the **failover/cap sites
(steps 8–10) are the ones that hide misses**.

**Grep is the map.** Every `=== "grok"`, `instanceof GrokAgentRun`, `startsWith("grok:")`,
`GROK_SUB_ID`, `noteGrokCap`, `readGrokUsage` hit needs a peer for your provider. Two flavors:
- **Anthropic-compatible** (z.ai): reuse `AgentRun` via the `buildEnv` base-URL/token branch
  (`ANTHROPIC_BASE_URL`+`ANTHROPIC_AUTH_TOKEN`, drop the Claude OAuth token) + a nominal
  `class XAgentRun extends AgentRun {}` marker. Keeps the bus/office MCP tools, deliverables,
  resume, images for FREE — the big win over a custom runner.
- **Custom CLI** (Codex/Grok): a new `AgentRunLike` class + the `OFFICE[team|office]:` text
  bridge (`office-bridge.md`) — it gives all that up.

## Touch list
1. `config.ts` — backend block (auth/key, models, usage endpoint). `modelCatalog.ts` — `CURATED_X_MODELS`.
2. `types.ts` — `ImplementorProvider` union, `X_SUB_ID`, `OrchestratorSettings` fields (mirror web).
3. `runner.ts` — reuse: `buildEnv` branch + `XAgentRun` marker. Custom: the runner class.
4. **Usage chip** (mirror `grokUsage`/`grokUsagePing`): `agents/xUsage.ts`+`xUsagePing.ts`; start it in
   `index.ts`; `protocol.ts` DTO re-export + `hello` field + `x.usage` event; `hub.ts` buildHello; web
   mirror (`types.ts`, `store.ts` handler+default, `Accounts.tsx` chip + `styles.css` `.acct.x`). Chip must
   stay on-screen — `topbar-accounts-strip.md`.
5. **Settings** — the full `add-a-setting.md` 6-file pattern per field (enabled/model/effort/safety +
   any write-only key, which goes in the `SettingsPatch` Omit as `xKeyPresent`/`xKeyLast4`, never broadcast).
6. `threadManager.providerForRun` — `instanceof XAgentRun` BEFORE the `"claude"` fallback (a reuse-AgentRun
   marker IS an AgentRun). `settings()` read + `setSettings()` kvSet + model/effort/key helpers.
7. `xCapActive`/`noteXCap`/`loadXCap` (+ boot-load in ctor) + `xProviderCandidate` + `xImplementorReady`.
   Then `resolveImplementorProvider` (auth-gate + cap-exclude + push candidate) and `nextReadyImplementor`.
   The `preferred*`/`spread` comparators handle any provider generically — no per-provider branch there.
8. `startImplementor` + `runRole` factories. **Resume portability**: an X session id resumes only on X —
   never cross-resume with Claude/another CLI (`priorImplementorProvider`/`latestQaRun` read the
   `x:<model>` account-label prefix).
9. **Cap-failover — the trap.** A non-Claude *AgentRun* cap (z.ai) surfaces as `rateLimited`, NOT a CLI
   `.capped`, and has NO sibling Claude account: in `awaitImplementorResult` early-return for `instanceof
   XAgentRun` (else it wrongly fails over to a Claude account), and add it to the `awaitImplementorCompletion`
   `cliCapped || xCapped` flip AND the `runRole` `provider !== "claude"` cap block. `noteXCap` in all three.
   **First make `rateLimited` settable at all:** only ANTHROPIC's phrasing sets it, so override `protected
   get providerCapText()` with your backend's own cap wording (`ZaiAgentRun`/`ZAI_CAP_TEXT_RE` — anchored,
   since the match swallows the message and latches the backend). Miss it and every trap above is
   unreachable: z.ai's `Request rejected (429) · [1310][Weekly/Monthly Limit Exhausted…]` read as a crash
   for weeks — no latch, no hand-off, a burnt QA round. Mirror the wording into `probe-run-errors.cjs`'s
   `CAP_RE` too, or the sweep files it as a REAL failure. Gate: `test:zai-cap`.
10. `capParkMessage`, `providerLabel`, and — CLI text-bridge backends ONLY — `isCliOfficeBridge` (a
    reuse-AgentRun backend has the real office MCP, so LEAVE IT OUT).
11. **`scripts/probe-accounts.cjs` — `BACKENDS` *and* `MIRRORED_HEADROOM_TERMS`.** The sweep's
    failover-ladder readout reads `setting_x_enabled` + `x_cap_until` by literal name, and it
    re-implements your `xProviderCandidate`'s `hasHeadroom` by hand. Both drift silently and in the
    flattering direction — an unread door keeps printing the rung `available`, so the sweep reports
    more failover depth than exists (Grok sat cap-latched for days unseen; its monthly credit door went
    unread for weeks). So: implement each of your candidate's headroom terms as a real check here, then
    declare it in `MIRRORED_HEADROOM_TERMS` naming the check that covers it. `test:failover-ladder`
    parses the live `hasHeadroom` expressions out of `threadManager.ts` and fails on any term you gate
    on but don't mirror — and on a mirror you claim but no longer have.

## Verify
Unit gate for the usage parser (`test:zai-usage` is the reference; register in `run-gates.cjs`). Prove it
actually RUNS end-to-end with the throwaway harness (`e2e-a-pipeline-lane.md`) — a typecheck never catches a
dead env branch. Browser-test the chip + settings round-trip (`browser-test-throwaway-instance`). Deploy the
server change yourself via the atomic hub restart (CLAUDE.md).
