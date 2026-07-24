---
paths:
  - server/src/agents/runner.ts
  - server/src/agents/codexRunner.ts
  - server/src/agents/modelCatalog.ts
  - server/src/config.ts
  - server/src/accounts/**
---

# Model/provider economics — read before any "add a cheaper model / provider X" task

The recurring question ("DeepSeek/OpenRouter/local model is ~100x cheaper — integrate
it to save money?") has a non-obvious answer that costs ~15 tool calls to rediscover.
The premise usually doesn't transfer. Ground the discussion in these facts:

- **The orchestrator pays $0 marginal per token.** Every agent authenticates via the
  flat-fee Claude **Max subscription** — `buildEnv` (`runner.ts`) deliberately *deletes*
  `ANTHROPIC_API_KEY` so runs bill the sub, not metered API. Codex's preferred auth is a
  flat **ChatGPT-plan** login (`config.ts` `codex.sourceAuthHome`, "no usage-based API
  billing needed"). So an implementor run's marginal cost is already **$0**. A "per-token
  API price sheet" comparison (Opus $5/$25 per M vs DeepSeek $0.14/$0.28) is comparing
  against a rate the owner **isn't paying** — a metered provider ADDS a bill, not cuts one.
- Most cheap providers are **pay-per-token, not a flat "sub"** with a bundled coding
  agent. Adding one moves you off the flat/windowed model the whole stack is built around
  (`AccountManager`, 5h/weekly windows, `ResetStagger`, usage pings) onto a metered
  drawn-down balance with **none** of those — so it needs a **spend guard** (new logic,
  no analog today) and exemption from all the window/stagger/cap machinery.

**Where a metered provider IS an asset:** it has no usage windows, so it's *never capped*.
Today when every Claude sub **and** Codex are exhausted, a task **parks** in `review` and
waits for a reset (`threadManager.ts` reverse-flip block + `resumeCapParked`). A
never-capped backend is worth adding ONLY as the bottom rung of that failover ladder
(anti-park), gated by a spend cap — not as a day-to-day implementor (that's $0 already and
more reliable on Claude; a ~2-3pt SWE-bench gap understates long-horizon reliability risk).

**If you do build a new backend — the seam and the shortcut** (full touch-point
checklist — every routing/cap/failover site to mirror — in `add-an-implementor-backend.md`;
read it once you've decided to build, so you don't rediscover the seam by grep):
- A new backend is a `provider` branch across the threadManager seam + a runner (a custom
  `AgentRunLike`, OR — for an Anthropic-compatible endpoint — the reused `AgentRun` marked by a
  nominal `class XAgentRun extends AgentRun {}`) + the 6-file settings toggle (`add-a-setting.md`).
  `AgentRun` (Claude SDK), `CodexAgentRun` (custom CLI), and `ZaiAgentRun` (reuse) all model this.
- **Don't write a codex-style custom runner** for any provider that exposes an
  **Anthropic-compatible endpoint** (e.g. DeepSeek's `https://api.deepseek.com/anthropic`).
  The Claude Agent SDK honors `ANTHROPIC_BASE_URL` + `ANTHROPIC_AUTH_TOKEN`, so you reuse
  the existing `AgentRun` path by a per-run env branch in `buildEnv` — keeping MCP tools
  (bus deliverables/ask_user/findings, office chat), file editing, resume, images for free.
  Codex had to give all that up and rebuild it (its office is a text bridge). Custom runner = last resort.
- **Test the thesis for ~$1 before writing code:** point a throwaway instance at the
  provider by env alone (`ANTHROPIC_BASE_URL`/`ANTHROPIC_AUTH_TOKEN`, tiny prepaid balance),
  run real tasks, judge reliability on the actual workload. Then decide.

Full worked example: `docs/deepseek-integration-analysis.md` (July 2026 decision brief).
