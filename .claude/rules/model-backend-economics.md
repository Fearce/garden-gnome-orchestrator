---
paths:
  - server/src/agents/**
  - server/src/accounts/**
  - server/src/config.ts
  - docs/**
---

# Model/provider/harness economics — read before any "adopt X / swap to X" task

**Check `docs/DECISIONS.md` first** (the closed-questions register). DeepSeek backend, Pi
harness swap and token-freeze behaviour are already answered — extend that brief, never
write a second one.

Two recurring questions share one non-obvious answer that costs ~15 tool calls to
rediscover: *"provider X is ~100x cheaper — integrate it to save money?"* and *"harness X
is better designed — swap to it?"*. Both premises usually don't transfer, for the same
reason:

- **The orchestrator pays $0 marginal per token.** Every agent authenticates via the
  flat-fee Claude **Max subscription** — `buildEnv` (`runner.ts`) deliberately *deletes*
  `ANTHROPIC_API_KEY` so runs bill the sub, not metered API; Codex's preferred auth is a
  flat **ChatGPT-plan** login (`config.ts` `codex.sourceAuthHome`). So a per-token price
  sheet (Opus $5/$25 per M vs DeepSeek $0.14/$0.28) compares against a rate the owner
  **isn't paying** — a metered provider ADDS a bill, it doesn't cut one.
- **A third-party harness METERS that same sub — only the first-party path is $0.**
  Anthropic bills a non-Claude-Code harness on a Pro/Max login **per token as "extra
  usage"**, which does *not* draw the 5h/weekly windows; the Agent SDK escapes that only
  because it *is* the `claude` CLI. Swapping harnesses therefore starts a bill AND orphans
  `AccountManager`/`ResetStagger`/cap-failover at once — settle it **before** any feature
  table, since a rival can win every checklist row and still be a large net loss.
  Asymmetric by vendor: OpenAI *endorses* third-party use of a ChatGPT plan (Codex for
  OSS), so the same swap is free on the Codex/z.ai lane and costly on the Claude lane.
- Most cheap providers are **pay-per-token, not a flat sub** with a bundled coding agent.
  Adding one moves you off the flat/windowed model the stack is built around
  (`AccountManager`, 5h/weekly windows, `ResetStagger`, usage pings) onto a drawn-down
  balance with **none** of it — so it needs a **spend guard** (new logic, no analog today)
  and exemption from the window/stagger/cap machinery.

**Where a metered provider IS an asset:** no usage windows, so it's *never capped*. When
every Claude sub **and** Codex are exhausted a task **parks** in `review` awaiting a reset
(`threadManager.ts` reverse-flip + `resumeCapParked`). A never-capped backend is worth
adding ONLY as that ladder's bottom rung (anti-park), spend-capped — not as a day-to-day
implementor (already $0 and more reliable on Claude; a ~2-3pt SWE-bench gap understates
long-horizon reliability risk).

**If you do build one — the seam and the shortcut** (full touch-point checklist in
`add-an-implementor-backend.md`; read it once you've decided to build):
- A new backend is a `provider` branch across the threadManager seam + a runner (a custom
  `AgentRunLike`, OR — for an Anthropic-compatible endpoint — the reused `AgentRun` marked by a
  nominal `class XAgentRun extends AgentRun {}`) + the 6-file settings toggle (`add-a-setting.md`).
  `AgentRun` (Claude SDK), `CodexAgentRun` (custom CLI), and `ZaiAgentRun` (reuse) all model this.
- **Don't write a codex-style custom runner** for any provider exposing an
  **Anthropic-compatible endpoint** (e.g. DeepSeek's `https://api.deepseek.com/anthropic`).
  The SDK honors `ANTHROPIC_BASE_URL` + `ANTHROPIC_AUTH_TOKEN`, so you reuse the existing
  `AgentRun` path via a per-run env branch in `buildEnv` — keeping MCP tools (bus
  deliverables/ask_user/findings, office chat), file editing, resume, images for free.
  Codex gave all that up and rebuilt it (its office is a text bridge). Custom = last resort.
- **Test the thesis for ~$1 before writing code:** point a throwaway instance at the
  provider by env alone, run real tasks, judge reliability on the actual workload.
