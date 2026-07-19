# Should we add a DeepSeek backend to the orchestrator?

*A decision brief for Kevin — July 2026. Written by an implementor worker after reading the actual backend code and checking current DeepSeek/Claude pricing + benchmarks.*

---

## TL;DR

**The "almost 100x cheaper" number is real API-to-API, but it doesn't describe your setup — and that's the whole crux.** This orchestrator does not pay per-token API pricing for anything. It authenticates every agent through your flat‑fee **Claude Max subscription** and (optionally) a flat‑fee **ChatGPT‑plan Codex login**. The marginal cost of a Claude implementor run today is **$0** — you already paid for the window. DeepSeek is sold **pay‑per‑token** (there is no flat "DeepSeek sub" with a bundled coding agent). So buying a DeepSeek plan **adds a metered bill; it does not cut one.** "100x cheaper" is 100x cheaper than a rate you aren't paying.

That kills the money argument as stated. But there is **one** genuinely good reason to wire DeepSeek in, and it's the mirror image of the pricing story: **DeepSeek has no 5h/weekly usage windows.** It's the only backend that is *never capped*. Today, when every Claude sub **and** Codex are exhausted, a task parks in `review` and waits (`resumeCapParked`, every 120s) for a window to reset. A metered DeepSeek backend could be the **never‑capped last‑resort implementor** that keeps tasks moving through a full cap-out instead of parking — the one place where "metered, always‑on" beats "flat, windowed."

**My recommendation:** Don't buy DeepSeek to save money on the Opus implementor — you'd be replacing a $0‑marginal, higher‑reliability worker with a metered, slightly‑weaker one. **Do** consider a small pay‑as‑you‑go DeepSeek balance *only* as an anti‑park failover backend, and prototype it the cheap way (below) before committing. If you rarely cap out all subs at once, even that isn't worth it.

---

## 1. The pricing reframe (why the premise doesn't transfer)

| | Input $/M | Output $/M | vs your marginal cost |
|---|---|---|---|
| **Claude Opus 4.8** (implementor/planner/QA) | $5.00 | $25.00 | You pay **$0** — flat Max sub |
| **Claude Sonnet 4.6** (director/researcher) | ~$3 | ~$15 | You pay **$0** — flat Max sub |
| Codex / GPT‑5.5 (opt‑in implementor) | metered or plan | metered or plan | **$0** on ChatGPT‑plan login |
| **DeepSeek V4 Pro** (the quality tier) | $0.435 | $0.87 | **metered — a new bill** |
| **DeepSeek V4 Flash** (the cheap tier) | $0.14 | $0.28 | **metered — a new bill** |

So the raw claim checks out *only* between API price sheets: V4 Flash output ($0.28) is ~89× under Opus output ($25); V4 Pro — the tier you'd actually want for implementor‑grade work — is ~29× under on output, ~11× on input. Call it "10–30x, not 100x" for the model you'd really use.

But your orchestrator is built to **never touch metered API billing**:

- `server/src/agents/runner.ts:80` — `buildEnv()` *deletes* `ANTHROPIC_API_KEY` on purpose, so agents authenticate via the Max subscription OAuth token only. The comment calls it "the cardinal rule."
- `server/src/config.ts:156` — Codex "PREFERRED" auth is a ChatGPT‑plan `codex login` precisely because "it bills against the Plus/Pro/etc. plan, so no usage‑based API billing is needed."
- The entire `AccountManager` / `ResetStagger` / usage‑ping machinery exists to squeeze *flat‑fee windows*, not to minimize a per‑token bill.

Adding DeepSeek moves you from "predictable flat fee, $0 marginal" to "flat fee **plus** a metered drip." That's the opposite direction from "cheaper."

---

## 2. Is it even feasible? Yes — cleanly. The code has the seam.

The orchestrator already anticipates multiple implementor backends. There's a single interface, `AgentRunLike` (`runner.ts:55`), that both providers implement:

- **Claude** → `AgentRun`, driving `@anthropic-ai/claude-agent-sdk`.
- **Codex** → `CodexAgentRun`, a custom child‑process runner around the `codex exec` CLI.

The thread manager steers runs purely through that interface and only picks a concrete class at one factory point in `startImplementor` (`threadManager.ts:1687`+), gated by `resolveImplementorProvider` (`threadManager.ts:1176`). A DeepSeek backend would be a **third** `AgentRunLike` implementation plus a routing branch. Architecturally this is the *designed* extension point — no refactor needed.

The real question is **how much runner** you'd have to write, and there are two very different answers.

### Path A — reuse the Claude harness via DeepSeek's Anthropic‑compatible endpoint  ★ recommended if you build anything

As of **July 24, 2026**, DeepSeek ships a first‑party **Anthropic‑format** endpoint: `https://api.deepseek.com/anthropic`, with model mapping (`claude-opus-*` → `deepseek-v4-pro`, `claude-sonnet/haiku-*` → `deepseek-v4-flash`). The Claude Agent SDK is the `claude` CLI under the hood, and it honors `ANTHROPIC_BASE_URL` + `ANTHROPIC_AUTH_TOKEN`.

**Implication: you can reuse the *existing* `AgentRun` path almost verbatim, just pointed at DeepSeek by env.** You keep the whole harness for free — file editing, Bash, **MCP tools** (bus: `post_deliverable` / `ask_user` / `post_finding`, office chat), resume/session semantics, images. That's exactly what the Codex backend had to *give up* and hand‑rebuild (Codex has no MCP, so it bridges the office over a text protocol — `codexRunner.ts:28`).

Concrete work for Path A:
1. A per‑run env override in `buildEnv` (`runner.ts:80`): when the run is DeepSeek, set `ANTHROPIC_BASE_URL=https://api.deepseek.com/anthropic` and `ANTHROPIC_AUTH_TOKEN=<deepseek key>` instead of the OAuth token. (Today it hard‑deletes the API key and injects OAuth — this needs a clean branch, not a hack.)
2. A `deepseek` value in `ImplementorProvider` + a routing branch in `resolveImplementorProvider` / `preferredImplementorProvider`.
3. A Subscriptions toggle + key field (the 6‑file settings pattern in `.claude/rules/add-a-setting.md`, plus the Subscriptions UI like Codex has).
4. **Bypass the window accounting for DeepSeek runs.** `AccountManager`, 5h/weekly resets, `ResetStagger`, usage pings — all assume Anthropic's rate‑limit event shapes and flat windows. DeepSeek has none; it's a drawn‑down balance. So DeepSeek must be exempt from the cap/park/stagger logic and instead needs a **spend guard** (a $ ceiling that latches it off), which is *new* logic with no analog today.
5. Map error shapes: DeepSeek's 402 "insufficient balance" / 429 are not Anthropic `rate_limit_event`s, so the `runner.ts` cap classifier won't recognize them — a DeepSeek run needs its own "out of money / rate‑limited" detection so it fails over *back* to Claude gracefully.

Rough size: **a few hundred lines + UI**, mostly plumbing and the spend guard — noticeably *less* than Codex took, because the harness is reused.

### Path B — a custom DeepSeek runner (like `codexRunner.ts`)

Spawn some agent CLI or drive DeepSeek's OpenAI‑compatible chat API directly, and rebuild the tool loop, apply_patch/file editing, event streaming, watchdogs, office text bridge, resume — everything `codexRunner.ts` is (hundreds of lines, plus its wedge watchdog, JSONL parsing, image temp‑files). **No reason to do this** when Path A exists. Skip it.

---

## 3. Quality: close on benchmark, but benchmark ≠ your workload

Current agentic‑coding numbers (SWE‑bench Verified):

- **DeepSeek V4 Pro ≈ 91.2%**
- **Claude Opus 4.7 ≈ 93.9%** (Opus 4.8 is your implementor, a touch higher)
- **GPT‑5.5** marginally above both.

On a one‑shot benchmark that's genuinely close — a ~2–3 point gap. But this orchestrator's value is **unattended, multi‑round, QA‑gated, 100‑turn agentic work** with cross‑agent coordination and self‑resume. The distance between "benchmark‑close" and "reliably drives a long task to a clean QA pass without derailing, over and over" is wider than 2.7 points of SWE‑bench suggests — and your maxTurns/auto‑resume/QA machinery is tuned to Claude's behavior. For the *implementor* seat specifically, reliability matters more than the model being 2 points back, and you're paying $0 for the more reliable one. That's a second independent reason not to swap the implementor.

Where the quality gap is a **non‑issue**: the cheap auxiliary roles (director, researcher) and the last‑resort‑during‑a‑cap case, where "keeps moving, slightly weaker" beats "parked, waiting."

---

## 4. The one place it's actually worth it: never‑capped failover

Your failover ladder already exists and is well‑built (`threadManager.ts:2003‑2075`):

- Codex caps mid‑run → flip to Claude.
- Every Claude sub caps mid‑run, Codex has headroom → flip to Codex.
- **Everything capped → the task parks** in `review` with `⏳ Auto‑resume pending`, and `resumeCapParked` waits (120s loop) for *any* Claude sub or Codex window to reset.

That park is the gap. DeepSeek is the only backend with **no window to wait on** — it's always available (until the balance runs out). So the highest‑value — arguably *only* worthwhile — integration is:

> **Add `deepseek` as the bottom rung of the failover ladder:** when Claude *and* Codex are both capped, instead of parking, flip the task to DeepSeek and keep going. It's exactly the reverse‑flip block at `threadManager.ts:2046`, with `deepseek` as the target and a spend cap as the only guard.

This is where the metered/no‑window model that made it *worse* for everyday use makes it *better*: you pay a few cents only during the rare full cap‑out, in exchange for tasks never stalling on a reset. Whether that's worth a monthly minimum + setup depends entirely on **how often you actually cap out every sub at once.** If that's "a couple times a month," it's a nice‑to‑have; if it's "constantly," it's real; if it's "basically never," skip it.

A softer secondary win: offloading the **director/researcher** (Sonnet) and the fast‑usage‑polling **Haiku** pings to cheap DeepSeek would free flat‑fee window headroom for Opus *implementor* work — but those roles are already cheap on the sub, so the gain is marginal and adds provider‑juggling complexity.

---

## 5. Recommendation

1. **Don't buy DeepSeek expecting to cut costs.** Your costs are flat and your implementor's marginal cost is $0; DeepSeek adds a metered bill and a slightly less reliable worker. The premise doesn't survive contact with how the orchestrator authenticates.
2. **The only integration worth building** is DeepSeek as a **never‑capped last‑resort failover** so tasks don't park when all subs are exhausted. Gauge it against how often you truly cap out everything at once.
3. **If you build it, use Path A** (the Anthropic‑compatible endpoint + reuse `AgentRun`), not a custom runner — you keep MCP/deliverables/office for free. Budget a few hundred lines: a per‑run env branch in `buildEnv`, a `deepseek` provider + routing branch, the 6‑file settings toggle, exemption from the window/stagger machinery, a **spend cap**, and DeepSeek‑specific error mapping.
4. **Cheapest way to even test the thesis before committing code:** point a throwaway orchestrator instance at DeepSeek by env alone — set `ANTHROPIC_BASE_URL=https://api.deepseek.com/anthropic` and `ANTHROPIC_AUTH_TOKEN=<key>` for the whole process (with a tiny prepaid balance), run a couple of real tasks, and judge V4 Pro's implementor reliability on *your* workload firsthand. If it holds up and you cap out often, build the scoped failover; if not, you've spent a dollar and an afternoon instead of a backend.

I didn't write any code for this — it's a "should we" question, and my honest answer is "not for the reason you're considering it, and only a narrow version of it at all." Happy to implement the Path‑A failover backend end‑to‑end (behind a Subscriptions toggle, off by default) the moment you say go.

---

### Sources
- [DeepSeek Models & Pricing](https://api-docs.deepseek.com/quick_start/pricing/) · [DeepSeek V4 Pro pricing](https://pricepertoken.com/pricing-page/model/deepseek-deepseek-v4-pro)
- [DeepSeek Anthropic API guide](https://api-docs.deepseek.com/guides/anthropic_api/) · [DeepSeek → coding agents integration](https://api-docs.deepseek.com/guides/coding_agents/)
- [DeepSeek V4 vs Opus 4.7 vs GPT‑5.5 benchmarks](https://benchlm.ai/blog/posts/deepseek-v4-vs-claude-opus-4-7-vs-gpt-5-5) · [Verdent: V4 vs Opus vs GPT‑5.5 for agentic coding](https://www.verdent.ai/guides/deepseek-v4-vs-claude-opus-4-6-vs-gpt-5-5)
- [Claude Opus 4.8 API pricing](https://pricepertoken.com/pricing-page/model/anthropic-claude-opus-4.8) · [Anthropic pricing docs](https://platform.claude.com/docs/en/about-claude/pricing)
