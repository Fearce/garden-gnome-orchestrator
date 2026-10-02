---
paths:
  - "server/scripts/probe-token-burn.cjs"
  - "server/src/agents/sessionUsage.ts"
  - "server/src/tests/sessionUsage.test.ts"
  - "server/src/orchestrator/resumeCompress.ts"
---

# Token-efficiency audit — measure the calls, never reason from prompts

Read before any "reduce token usage", "why was usage high", or "optimize for token efficiency" task. Many agents were given exactly that brief, and none found the two leaks the owner stumbled on (2026-09-28). All of them edited prompts and code by inspection. Nobody measured.

## The one fact that decides where to look
About 98% of Claude tokens are **cache reads**, and every API call re-reads the whole context. So tokens ≈ **calls × context size**, and trimming a prompt by 2k is noise next to a session re-read at 900k. Start from context per call, not from prompt length.

## Method
1. `npm run probe:token-burn --prefix server` (`-- --days 7`, `-- --json`). It measures each run from its Claude transcript, which records every call's real usage, and prints tokens per day per role, context per call, the share spent above 300k, fresh-run starting context, per-thread resume reload, and warnings. On a loaded box it takes minutes, so background it.
2. Chase the biggest number first. **Context per call** high or rising means sessions grow too large: check compaction (`CLAUDE_CODE_AUTO_COMPACT_WINDOW`, `AUTO_COMPACT_WINDOW_TOKENS`) and resume reseeding (`RESUME_RESEED_CONTEXT_TOKENS`, `bloatedSessionReason`). **Reload** high means resumes re-read their session. **Calls** high means too many runs or turns: goal step granularity, QA rounds, turn ceilings. **Starting context** high means a fat base prompt that every call pays for.
3. Prove a lever before shipping it. Replay real transcripts through the change and compare actual against simulated tokens. That is how `fcce590` was sized.

## Don't trust `agent_runs` token/cost columns for rows before the `sessionUsage.ts` fix
On `--resume` the Claude CLI restores the session's saved totals, so `modelUsage` and `total_cost_usd` are **session-cumulative**. `codex exec resume` does the same with `turn.completed.usage`. Older rows therefore repeat every earlier run of the session: one 1-call run recorded 149M tokens, and a session holding 255M summed to 710M. `ClaudeRunMeter` / `CodexRunMeter` (`agents/sessionUsage.ts`, gate `test:session-usage`) now charge each run only for its own tokens:
- **Claude:** the process's first result pins the baseline as its cumulative minus `result.usage`, which covers that query alone.
- **Codex:** the baseline is the thread's last `token_count` total in its rollout, read before the resume spawns.

The probe's drift check flags any run whose DB figure exceeds its transcript. Old rows trip it by design until they age out; a drift on a post-fix run is a regression.

## Levers already pulled — don't re-propose them
- Goal steps aim at one long task (`f9c0d63`).
- A resume past 200k context reseeds from a compressed handoff (`fcce590`).
- GGO-driven sessions compact at 300k, not ~1M (`952ea45`).
- A goal step over its burn rate, or whose goal was paused, wraps up at its next turn ceiling instead of
  running on for hours (`stepWrapUpReason`). After the two fixes above, the 09-29 overnight burn was VOLUME,
  not a leak: context per call 169k, 0% above 300k, but two Opus goal steps ran ~2,800 calls in 7h. To size
  a goal's spend, join `goal_steps.thread_id` to the probe's runs; the per-thread table already ranks them.
- Every configured Claude role runs Opus 5.5 by design (`claudeOpusFloor.ts`); only work the route judges well-scoped runs Sonnet 5.5 (`.claude/rules/scoped-sonnet-routing.md`), so a "use a cheaper model" proposal must first read `token-conservation-mode.md` and `model-backend-economics.md`.
