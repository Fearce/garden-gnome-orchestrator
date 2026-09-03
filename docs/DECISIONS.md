# Closed-questions register

**Read this before investigating any "should we adopt / replace / add X?" question.** Every row is
a question that has already been answered here, with its headline verdict. `grep` finds *scripts*;
it never finds *verdicts* — that's what this file is for.

If your question is listed: **extend the named brief, don't write a second one.** Two briefs
answering one question is how a repo ends up with two answers and trusts neither. If the brief is
stale, correct it in place and update its row.

---

## Settled

| Question | Verdict | Brief |
|---|---|---|
| Add a **DeepSeek** backend to save money? | **No — the premise doesn't transfer.** Marginal cost per Claude run is already $0 (flat Max sub); a metered provider *adds* a bill. Worth it *only* as a never-capped anti-park bottom rung of the failover ladder, gated by a spend cap. | [`deepseek-integration-analysis.md`](deepseek-integration-analysis.md) |
| Replace the **Agent SDK harness with Pi**? | **No for the Claude seat** — third-party harnesses are billed per token as "extra usage" and don't draw plan limits, so the swap starts a bill *and* orphans the window-scheduling subsystem. Also no MCP, no forced structured output, no `maxTurns`. **Yes for the CLI-backend lane** — one Pi runner could replace `codexRunner.ts` + `grokRunner.ts`. | [`pi-harness-evaluation.md`](pi-harness-evaluation.md) |
| What happens on a **token freeze** mid-task? | **Rate-limit/usage-cap handling is robust and self-healing** (4-signal detection → account failover → cap-park → 120 s auto-resume). **529 is deliberately left to the SDK.** Context-window-exceeded is the one real gap — see Open below. | [`../TOKEN_FREEZE_FINDINGS.md`](../TOKEN_FREEZE_FINDINGS.md) |
| Does **freeze → reset → auto-resume** actually work end-to-end? | **Yes, proven.** 26/26 assertions against the real `ThreadManager`, with a negative control that fails if resume regresses to a cold restart. No bug existed; it had just never been exercised. | [`token-freeze-resume-test.md`](token-freeze-resume-test.md) · `npm run test:token-freeze` |
| Why did **thread history disappear** in the feed? | **Two symptoms, one root cause (fixed); the third was not a bug.** | [`diagnosis-thread-history.md`](diagnosis-thread-history.md) |
| Subscribe to **Alibaba Cloud** and add **Qwen 3.8**? | **Split answer: no to Qwen 3.8, yes to the subscription.** `qwen3.8-max` is *not* on the $50/mo Coding Plan — it's pay-as-you-go, so the DeepSeek verdict applies to it. The flat plan itself is worth buying for a different reason: **Codex and Grok can never serve `MCP_DEPENDENT_ROLES`**, so an Anthropic-compatible backend is the only second rung for reader/auto-review — and today's one is a z.ai **Lite** at 100% weekly. Build on the `ZaiAgentRun` seam; the real cost is that Alibaba publishes **no quota API**. | [`qwen-alibaba-integration-analysis.md`](qwen-alibaba-integration-analysis.md) |
| Is it safe that **`office.sprogbroen.dk` is fully public**? | **Yes — being reachable was never the risk.** Anonymous callers get three counts; every surface naming a person, repo or message is behind a 190-bit admin key or a 256-bit device token. The real defect was the *deploy path*: a fresh host started an office whose join code is published in this repo. Fixed, with four hardening gaps. | [`relay-public-exposure-review.md`](relay-public-exposure-review.md) · `npm run test:relay-access` |
| Use **LiveBench scores plus cost/token burn** when auto-selecting models and effort? | **Yes, inside a deterministic task-capability floor.** Adaptive work uses the cheapest reliable eligible model; substantial ambiguous/high-risk production, data-lifecycle, migration, cross-cutting, or sensitive user-facing work prefers Opus 5 and permits only documented flagship fallbacks. LiveBench is a daily cached secondary prior; durable local grades are stronger within that eligible tier and retain quality, QA, whole-pipeline dollars/turns/time, normalized token categories, and model×effort outcomes beyond task purging. `$0` subscription cost never hides scarce allowance burn. | [`livebench-model-selection.md`](livebench-model-selection.md) · `npm run test:route-selection` · `npm run test:route-pipeline` · `npm run test:livebench` · `npm run test:model-select` · `npm run test:auto-model` |
| Put recurring-free inference APIs directly into **task failover**? | **Yes, but reserve them for confidently small first attempts; no for coding roles.** Nine providers have secure connections and mandatory usage chips. A deterministic fail-closed policy admits only explicit read-lane lookups or narrow low-effort plans, never broad/risky/uncertain work, retries, continuations, or attachments. Admission also reserves enough visible quota for the bounded 4-call/8K-token run. Any free failure returns to the normal reliable ladder and cannot cap-park the task. Implementor/researcher/QA remain excluded until their write, web, shell, resume, steering, bus, and commit contracts exist. | [`free-ai-provider-connections.md`](free-ai-provider-connections.md); `npm run test:free-providers`; `npm run test:free-provider-routing` |

## Genuinely still open

Reconstructing this list from five closed briefs is exactly the waste this register exists to
prevent, so it's stated once, here.

- **Context-window-exceeded has no dedicated recovery path.** It falls through as a generic error
  into a human-gated park — indistinguishable from a crash. `TOKEN_FREEZE_FINDINGS.md` §5 already
  specifies the fix in four concrete steps (a `contextExceeded` signal distinct from `rateLimited`;
  auto-drive the existing `resumeCompress.ts` path on it; a distinct park marker + honest message;
  and tighten `RATE_LIMIT_RESULT_RE` so a context error can't be mis-routed into rate-limit
  failover). Nothing has been built.
- **One Pi-driven `AgentRunLike` to replace `codexRunner.ts` + `grokRunner.ts`.** Recommended, not
  built. `pi-harness-evaluation.md` §7 has a ~1-day three-step prototype with an explicit stop
  condition — if the tool bridge doesn't work cleanly, abandon it.
- **DeepSeek as the anti-park bottom rung.** Conditionally recommended, not built, and only worth it
  if capping out *every* sub simultaneously is actually common.
- **An Alibaba Coding Plan backend as the second MCP-capable rung.** Recommended, not built — blocked on
  a maintainer subscribing, and on the ~$1 pay-as-you-go test that proves MCP tool use survives the
  Anthropic-compatible endpoint (if it doesn't, the recommendation flips to no).
  `qwen-alibaba-integration-analysis.md` §5-6 has the touch list and the two traps: `buildEnv`'s
  hardcoded `"zai"`/`config.zai.timeoutMs`, and the absent quota API that forces a **local** invocation
  counter where z.ai has `usageUrl`.

## Adding a row

When you close a question: add the row **in the same commit** as the brief, and fix any doc header
that still reads like the lane is live. A brief still saying "recommended" for something since
rejected costs the next agent an iteration.

Related always-loaded pointers: `.claude/rules/model-backend-economics.md` (the economics that
decide most of these), `.claude/rules/add-an-implementor-backend.md` (the touch-point checklist once
you've decided to build).
