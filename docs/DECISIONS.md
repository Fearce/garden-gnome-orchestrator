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
| Is it safe that **`office.sprogbroen.dk` is fully public**? | **Yes — being reachable was never the risk.** Anonymous callers get three counts; every surface naming a person, repo or message is behind a 190-bit admin key or a 256-bit device token. The real defect was the *deploy path*: a fresh host started an office whose join code is published in this repo. Fixed, with four hardening gaps. | [`relay-public-exposure-review.md`](relay-public-exposure-review.md) · `npm run test:relay-access` |

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

## Adding a row

When you close a question: add the row **in the same commit** as the brief, and fix any doc header
that still reads like the lane is live. A brief still saying "recommended" for something since
rejected costs the next agent an iteration.

Related always-loaded pointers: `.claude/rules/model-backend-economics.md` (the economics that
decide most of these), `.claude/rules/add-an-implementor-backend.md` (the touch-point checklist once
you've decided to build).
