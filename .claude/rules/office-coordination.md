---
paths:
  - server/src/agents/prompts.ts
  - server/src/orchestrator/threadManager.ts
  - server/src/bus/officeServer.ts
---

# Office coordination is PEER-GATED (solo repo = no office at all)

The office (cross-agent chat) is OFF while a task is alone in its repo — no office
prose in prompts, no proactive `office_look`/`chat_read`, no general-office check-in.
It switches ON for everyone the moment a 2nd task joins the repo. This is the fan-out
to touch for any change to WHEN/HOW agents are told to coordinate. (For the CLI
`OFFICE[team]:` text-bridge extractor see `office-bridge.md`; this is the gating +
kickoff-injection + activation layer.)

## Where "office is on" is decided
`ThreadManager.repoPeers(thread)` (other live agents sharing the workspace) is the
single gate. `liveAgentThreads()` reads `activeRuns` (the in-process truth); a repo
is "collaborating" when 2+ distinct task threads are live in it.

## The fan-out (miss one → an agent hears about the office when it shouldn't, or not when it should)
1. `prompts.ts` — the static role prompts carry **NO** office prose. Don't re-add a
   standing "check the office" paragraph — it's noise + wasted tokens for a solo task.
2. `threadManager.officeNote(thread, role, withTools)` — role-aware coordination note,
   returns `undefined` when no `repoPeers`. `withOfficeNote(...)` appends it to a
   kickoff only when peers exist. Injected into EVERY role's fresh kickoff (planner/
   researcher/reader/qa via `withOfficeNote`; implementor Claude/z.ai/Codex/Grok in
   `startImplementor` + the resume-fresh-fallback). `withTools=false` = CLI text bridge.
3. `officeCheckIn` — the general-office "👋 here" post is SUPPRESSED while solo (and does
   NOT mark `checkedIn`, so it can still fire later); `ensureGroup` backfills it on grouping.
4. `ensureGroup` — forms the project room AND is the ON-switch: for each member newly
   entering the room it backfills the check-in, then `pushOfficeActivation` wakes the
   already-running implementor incumbents about the joiner(s).

## Invariants that bite
- **`pushOfficeActivation` targets `this.live` ONLY (live implementors).** NEVER push a
  mid-run message into a one-shot planner/QA/reader — it corrupts their structured output
  (same reason `deliverChatToPeers` targets `this.live`). A read-only phase reads the room
  itself; its next implementor phase gets the office note in its kickoff.
- **Skip the triggering thread as a push recipient.** Its own fresh kickoff already carried
  the note, and in `startImplementor` `ensureGroup` runs BEFORE `agent.start` — pushing into
  it would be a pre-start send.
- **Dedup is durable via `chatThreadInRoom`,** not an in-memory Set — a bounce/auto-resume
  re-announces and re-pings nobody. Tie any new "notify on join" to a member's first room entry.
- **Office MCP tools stay in `allowedTools` always** (roles.ts). The SDK can't add tools
  mid-query, so a task that starts solo still needs them present for a later mid-run join.
- **The gnome strip / roster reads `activeRuns`, not chat** (`web/.../Office.tsx`), so a solo
  agent still shows as a walking gnome even though it posts nothing. Don't "fix" that.

## Test without spawning a real `claude`
`server/src/tests/officeGating.itest.ts` (gate `test:office-gating`) drives the real office
methods against stub live agents: seed a real `agent_runs` row (so `liveAgentThreads` resolves
a role) + a recording `{send}` stub into `activeRuns`/`this.live`. Same cheap seam as
`perRepoConcurrency.itest.ts` — use it for coordination/gating logic; reserve the expensive
real-agent harness (`e2e-a-pipeline-lane.md`) for "does the lane actually answer".
