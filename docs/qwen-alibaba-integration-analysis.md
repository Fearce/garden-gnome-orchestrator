# Should we subscribe to Alibaba Cloud and integrate Qwen 3.8 into the orchestrator?

*A decision brief — 26 August 2026. Written by an implementor worker after reading the actual backend
code, measuring 30 days of this orchestrator's real run trail, and checking current Alibaba/z.ai plan
terms. Companion to [`deepseek-integration-analysis.md`](deepseek-integration-analysis.md), whose
verdict does **not** transfer here — see §1.*

---

## TL;DR

**Yes to the subscription. No to Qwen 3.8 — because the two aren't the same purchase.**

The $50/mo Alibaba Cloud **Coding Plan** does not include `qwen3.8-max`. Its model list is
`qwen3.7-plus`, `qwen3.6-plus`, `kimi-k2.5`, `glm-5`, `MiniMax-M2.5`, `qwen3.5-plus`,
`qwen3-max-2026-01-23`, `qwen3-coder-next`, `qwen3-coder-plus`, `glm-4.7`. Qwen 3.8-Max is
**pay-as-you-go only** ($1.65/M in, $4.951/M out) — which is precisely the metered shape this repo
already rejected for DeepSeek, and rejecting it again for the same reason is the consistent call.

But the flat plan underneath it is worth buying **on its own merits, and not for the reason you asked**.
Your only MCP-capable failover rung today is a **z.ai GLM Coding Plan Lite at $18/mo**, and as of this
writing its weekly window is at **100% — exhausted, capped for another 1d 9h** (`data/zai-usage-cache.json`:
`{"plan":"lite","sevenDay":100}`). The Alibaba Coding Plan Pro carries **45,000 requests/week** against
Lite's ~400 prompts/week. For **+$32/mo** you replace a chronically-exhausted rung with one roughly two
orders of magnitude larger, through **the integration seam this repo already built for z.ai**.

**Recommendation:** subscribe to the Coding Plan Pro, wire it as a second Anthropic-compatible backend
(≈ the `ZaiAgentRun` pattern), and treat it as a **replacement candidate for z.ai Lite**, not an addition
to it. Skip Qwen 3.8-Max. Spend ~$1 on pay-as-you-go first to prove the harness actually drives it (§6).

---

## 1. Why the DeepSeek verdict doesn't decide this one

`docs/DECISIONS.md` closes "add a DeepSeek backend?" with **no — a metered provider *adds* a bill**,
because every agent here authenticates through a flat-fee subscription and the implementor's marginal
cost is $0. That reasoning is sound and still holds. It just doesn't reach Alibaba, because **Alibaba
sells a flat-fee plan and DeepSeek doesn't**:

| | Billing | Bundled coding-agent support | Verdict shape |
|---|---|---|---|
| DeepSeek | pay-per-token only | — | metered ⇒ adds a bill ⇒ **no** |
| **Alibaba Coding Plan Pro** | **fixed $50/mo** | Claude Code, Qwen Code, Cline, Cursor | flat ⇒ same shape as z.ai ⇒ **evaluate on quota/model merit** |
| Alibaba pay-as-you-go (the only way to get `qwen3.8-max`) | per-token | — | metered ⇒ **the DeepSeek verdict applies** |

So the question splits cleanly, and the two halves get opposite answers. **"Subscribe to Alibaba Cloud"
and "integrate Qwen 3.8" are not the same purchase** — the flagship you named is on the wrong side of
that line.

There is one more reason not to chase 3.8-Max specifically: on the benchmarks that matter here it is
**not** a clear step up on the seat you'd use it for. Qwen3.8-Max scores **67.7 on SWE-bench Pro**
against Opus 4.8's **69.2** (behind), and **86.6 on Terminal-Bench 2.1** against Opus 4.8's **84.6**
(ahead). It is genuinely strong at long-horizon autonomous work and weaker at issue-resolution. That is
an interesting profile, not a reason to pay metered rates for a seat that currently costs $0.

---

## 2. What $50/mo actually buys, against your measured workload

Coding Plan Pro quota — metered by **model invocation count**, not tokens:

| Window | Plan allowance | Your peak (30d, `agent_runs.num_turns`) | Utilization |
|---|---|---|---|
| 5 hours | 6,000 | 3,009 turns | 50% |
| 7 days | 45,000 | 24,032 turns | 53% |
| 30 days | 90,000 | **75,956 turns** | **84%** |

*(A run's `num_turns` is one assistant turn ≈ one model invocation, so this is a like-for-like estimate,
not an exact conversion. Treat the monthly row as ±20%.)*

Two things fall out of that table, and they point in opposite directions:

- **As a drop-in primary implementor, it does not fit.** 84% of the monthly cap with your *entire*
  workload is not headroom, and your volume is climbing fast — weekly turns ran 11,544 → 15,047 →
  24,032 → 21,267 over the last four full weeks. At the current run-rate you'd cross 90,000/month
  inside this quarter. Alibaba explicitly **does not** spill over to pay-as-you-go when the plan is
  exhausted; calls simply fail. So it can never be the seat that carries the load.
- **As a failover rung, it is enormously oversized — and that's fine.** z.ai carried **4,182 turns
  across 130 runs** in the same 30 days (Claude carried 71,749). A second alt backend at similar duty
  would use **~5% of the Pro plan**. You are buying insurance, not throughput.

Which is the honest framing of the money: **$50/mo for a rung you'll run at ~5% utilization.** That
sounds bad until you look at what you're paying for the same rung today.

---

## 3. The actual problem this fixes: your failover ladder is one rung deep where it counts

Live state, from `npm run probe:accounts` at the time of writing:

```
■ personal   5h  23%  ·  7d  97%   ← about to lapse
■ secondary  5h 101%  ·  7d  26%   ← 5h capped
  ✗ Codex  NO ROOM — 7d at 100%, resets in 6d 2h
  ✓ Grok   available (7d 10% · credits 100%)
  ✗ z.ai   CAPPED — frees in 1d 9h
  ladder depth: 2 rung(s)
  reach for reader + reviewer: 1 rung(s)   ⚠ SHORTER than the 2 above
```

That last line is the point. `MCP_DEPENDENT_ROLES` (`threadManager.ts:446`) — the **reader** and the
**auto-reviewer** — answer the owner *only* through the in-process MCP bus (`post_finding`, `ask_user`).
`CLI_BRIDGED_PROVIDERS` (`:451`) reach the bus through the runner's `OFFICE[...]` **text bridge**, which
doesn't carry those tools, so **Codex and Grok cannot serve those roles at all**. z.ai can — and only
because it drives the same Claude SDK against an Anthropic-compatible endpoint, which is exactly what
that comment at `:448-450` says.

So the set of backends that can run an auto-review is: **Claude, and z.ai.** Right now that's *one*,
because z.ai's weekly is spent and `personal` is at 97%. Every "Auto-review & mark done" click in this
window is one lapsed weekly away from parking.

**An Alibaba Coding Plan backend is the second member of that set.** That is the structural argument,
and it's worth more than the throughput: Codex and Grok can never fill this gap no matter how much
quota they have, because the limitation is architectural, not economic.

*Honest counterweight:* the pain is **not acute today** — `threads` currently shows **0** tasks parked
with `⏳ Auto-resume pending`, and the reader role logged **0** runs in 30 days (reviewer logged 29 runs
/ 438 turns). This is insurance against a thin ladder, not a fire you're currently fighting.

---

## 4. z.ai: replace, don't stack

You are already paying for a plan in this exact slot, and it is the wrong size.

| | z.ai GLM Lite (current) | z.ai GLM Pro | **Alibaba Coding Plan Pro** |
|---|---|---|---|
| Price | **$18/mo** | $80/mo | **$50/mo** |
| 5-hour allowance | ~80 prompts | ~400 prompts | **6,000 calls** |
| Weekly allowance | ~400 prompts | ~2,000 prompts | **45,000 calls** |
| Monthly cap | — (weekly credits) | — | 90,000 calls |
| Models | glm-4.6 / 4.7 / 5.2 / 5-turbo | same | qwen3.7-plus, glm-5, glm-4.7, kimi-k2.5, MiniMax-M2.5, qwen3-coder-next, … |
| Live quota API | **yes** (`config.zai.usageUrl`) | yes | **no** — console page only |

Alibaba counts *model calls* where z.ai counts *prompts*, and Alibaba's own docs put a query at "5–10
calls for simple tasks, 10–30 or more for complex" — so 6,000 calls/5h ≈ 400–1,200 queries, i.e. **at
least z.ai Pro's tier for $30/mo less**, and far beyond the Lite plan you actually hold.

Two secondary wins worth naming:

- **It bundles `glm-5` and `glm-4.7`.** This repo's z.ai default is `glm-4.6` (`config.ts:253`). The
  Alibaba plan carries the newer GLM line *plus* three other model families under one subscription — so
  it isn't only "more z.ai", it's a strictly wider roster than the sub it would replace.
- **One less vendor.** Consolidating the alt-backend slot onto one plan is one key, one cap latch, one
  usage story instead of two.

**Caveat on replacement:** don't cancel z.ai on day one. Run both for a month, watch which one the
router actually reaches for, then drop Lite. Losing z.ai before Alibaba is proven would take the
MCP-capable rung count to *zero* during the transition — the exact failure this is meant to prevent.

---

## 5. What it costs to build, honestly

The cheap path exists and is already load-bearing here. `.claude/rules/add-an-implementor-backend.md`
calls this the **"Anthropic-compatible"** flavor: reuse `AgentRun` via the `buildEnv` base-URL/token
branch plus a nominal marker class. `buildEnv` (`runner.ts:123`) already takes a generic
`baseUrl`/`authToken` pair and routes the run through `ANTHROPIC_BASE_URL`/`ANTHROPIC_AUTH_TOKEN` while
dropping the Claude OAuth token. **That branch is 90% of a new backend and it already works.** You keep
the MCP bus, office chat, deliverables, resume, images and structured output for free — which is exactly
what Codex had to give up and hand-rebuild.

But "z.ai took 274 references across 18 files" is the real measure, and three of those are genuinely
*new* work rather than a copy:

1. **`buildEnv` is not yet provider-generic.** Inside the branch it hardcodes
   `env.CLAUDE_ORCH_PROVIDER = "zai"` and `config.zai.timeoutMs` (`runner.ts:138-139`). Those two lines
   must be parameterized before a second Anthropic-compatible backend can use the seam — small, but it
   is a shared-path edit, not an additive one.
2. **There is no quota API — and that breaks the usage chip and the ladder readout.** z.ai's entire chip
   + routing story hangs off `config.zai.usageUrl` returning live 5h/weekly windows. Alibaba publishes
   **no programmatic quota endpoint**; the docs say to check the Coding Plan console page. So step 4 of
   the backend checklist (the usage chip) and step 11 (`probe-accounts.cjs` `BACKENDS` +
   `MIRRORED_HEADROOM_TERMS`) have nothing to read. You would have to **count invocations locally** out
   of `agent_runs` against 6,000/5h, 45,000/week and 90,000/month. That's tractable — you already record
   every run's turns — but it is new logic with no analog in the codebase, and the rule file warns
   specifically that an unread door "keeps printing the rung `available`", i.e. it drifts in the
   flattering direction. Budget this as the real cost of the integration.
3. **A third window.** `AccountManager`/`ResetStagger` model **5h + weekly**. Alibaba adds a **monthly**
   cap on top, and per §2 the monthly is the binding one. That concept doesn't exist anywhere in the
   accounting today.

Two traps the rules file already paid for, which apply verbatim:

- **`providerCapText` must learn Alibaba's cap wording** (`runner.ts:247`, `ZAI_CAP_TEXT_RE` at `:594`).
  Only Anthropic's phrasing sets `rateLimited` by default. z.ai's `Request rejected (429) · [1310]
  [Weekly/Monthly Limit Exhausted…]` read as a *crash* for weeks — no latch, no hand-off, a burnt QA
  round. Alibaba's exhaustion wording is **undocumented**, so it has to be captured empirically from a
  real rejection, then mirrored into `probe-run-errors.cjs`'s `CAP_RE`.
- **Two different base URLs.** Coding-plan traffic goes to
  `https://coding-intl.dashscope.aliyuncs.com/apps/anthropic`; pay-as-you-go goes to
  `https://dashscope-intl.aliyuncs.com/apps/anthropic`. Pointing `buildEnv` at the wrong one **silently
  bills metered instead of drawing the flat plan** — the one mistake that would turn this from a $50
  subscription into the DeepSeek scenario. Neither URL may end in `/v1/`.

---

## 6. Recommendation

1. **Don't buy Qwen 3.8-Max.** It's pay-as-you-go only, it's *behind* Opus 4.8 on SWE-bench Pro, and
   metering is the thing `DECISIONS.md` already closed. The model you asked about is not the reason to
   do this.
2. **Do subscribe to the Coding Plan Pro ($50/mo)** — but frame it as *fixing the failover ladder*, not
   as adding a flagship. It is the only purchase that gives you a **second MCP-capable backend**, which
   Codex and Grok are architecturally incapable of being.
3. **Prove the harness drives it before you subscribe.** Put ~$1 of pay-as-you-go credit on the account,
   point a throwaway instance at `dashscope-intl.aliyuncs.com/apps/anthropic` by env alone
   (`ANTHROPIC_BASE_URL` + `ANTHROPIC_AUTH_TOKEN`), and run one real task. What you're testing is not
   model quality — it's whether **MCP tool use survives the Anthropic-compatible endpoint**, which
   Alibaba's docs do not confirm and which is the single assumption this whole plan rests on. If the bus
   tools don't come through, the MCP-rung argument in §3 evaporates and the answer flips to "no".
4. **If it passes, build it as `QwenAgentRun extends AgentRun`** on the z.ai seam: parameterize the two
   hardcoded lines in `buildEnv`, add the local invocation counter in place of a quota endpoint, teach
   `providerCapText` the real rejection wording, and follow the 11-step touch list. Budget it below the
   z.ai integration's size because the seam exists, but not by much — the missing quota API is real work.
5. **Then run both for a month and drop z.ai Lite.** Not before.

*One slot-availability note:* Alibaba flags the Coding Plan as "limited availability, first-come,
first-served", and the Lite tier was already withdrawn (new subscriptions closed 20 Mar 2026, renewals
13 Apr 2026). If you want the Pro tier, that is a mild argument for deciding sooner rather than later.

**No code was written for this** — it's a "should we" question, and building a backend for an account
that doesn't exist yet would be guessing at the cap wording and the quota shape. Say go and I'll
implement the whole thing behind a Settings toggle, off by default.

---

### Sources

- [Alibaba Cloud Model Studio — Coding Plan](https://www.alibabacloud.com/help/en/model-studio/coding-plan) ·
  [Coding Plan FAQ](https://www.alibabacloud.com/help/en/model-studio/coding-plan-faq) ·
  [Rate limiting](https://www.alibabacloud.com/help/en/model-studio/rate-limit)
- [qwen3.8-max model info + pay-as-you-go pricing](https://www.alibabacloud.com/help/en/model-studio/qwen3-8-max) ·
  [Alibaba: Qwen3.8-Max announcement](https://www.alibabagroup.com/en-US/document-2021044032125272064)
- [Qwen 3.8-Max benchmarks vs Claude / GPT-5.6](https://www.mindstudio.ai/blog/qwen-3-8-max-benchmarks-explained) ·
  [Qwen 3.8 verified benchmarks](https://www.yottalabs.ai/post/qwen-3-8-benchmarks-what-is-verified-2026)
- [Anthropic Messages API on DashScope](https://docs.qwencloud.com/api-reference/chat/anthropic) ·
  [OpenAI-compatible DashScope](https://www.alibabacloud.com/help/en/model-studio/compatibility-of-openai-with-dashscope)
- [GLM Coding Plan pricing — Lite/Pro/Max](https://www.aipricing.guru/z-ai-subscription-pricing/) ·
  [GLM Coding Plan guide](https://codingplan.org/en/plans/glm)
- Local evidence: `npm run probe:accounts --prefix server`, `agent_runs` (30d), `data/zai-usage-cache.json`,
  `server/src/orchestrator/threadManager.ts:446-456`, `server/src/agents/runner.ts:123-141,247,513-517,594`,
  `server/src/config.ts:238-260`.
</content>
</invoke>
