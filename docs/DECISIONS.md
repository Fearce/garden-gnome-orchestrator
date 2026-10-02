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
| Embed a full **VS Code extension host** in GGO? | **Use Monaco plus real declarative snippet contributions.** Desktop language workers, JSON snippet import and VSIX `contributes.snippets` work in the existing authenticated app. No extension JavaScript, Marketplace, terminal or debugger host is exposed. | [`ide-workspace.md`](ide-workspace.md) · `npm run test:ide` · `npm run ide-lab` |
| Add a **DeepSeek** backend to save money? | **No — the premise doesn't transfer.** Marginal cost per Claude run is already $0 (flat Max sub); a metered provider *adds* a bill. Worth it *only* as a never-capped anti-park bottom rung of the failover ladder, gated by a spend cap. | [`deepseek-integration-analysis.md`](deepseek-integration-analysis.md) |
| Replace the **Agent SDK harness with Pi**? | **No for the Claude seat** — third-party harnesses are billed per token as "extra usage" and don't draw plan limits, so the swap starts a bill *and* orphans the window-scheduling subsystem. Also no MCP, no forced structured output, no `maxTurns`. **Yes for the CLI-backend lane** — one Pi runner could replace `codexRunner.ts` + `grokRunner.ts`. | [`pi-harness-evaluation.md`](pi-harness-evaluation.md) |
| What happens on a **token freeze** mid-task? | **Rate-limit/usage-cap handling is robust and self-healing** (4-signal detection → account failover → cap-park → 120 s auto-resume). **529 is deliberately left to the SDK.** Context-window-exceeded is the one real gap — see Open below. | [`../TOKEN_FREEZE_FINDINGS.md`](../TOKEN_FREEZE_FINDINGS.md) |
| Does **freeze → reset → auto-resume** actually work end-to-end? | **Yes, after fixing Token Safety's terminal-cancel path.** Recovery is always on; provider caps and safety stops use durable capacity parks, preserve sessions, hold fresh dispatches while safety is tripped, and wake only when the compatible 5h + weekly/monthly gates permit it. The former on/off + threshold settings are removed and legacy kv rows are deleted on load. | [`token-freeze-resume-test.md`](token-freeze-resume-test.md) · `npm run test:token-freeze` |
| Why did **thread history disappear** in the feed? | **Two symptoms, one root cause (fixed); the third was not a bug.** | [`diagnosis-thread-history.md`](diagnosis-thread-history.md) |
| Subscribe to **Alibaba Cloud** and add **Qwen 3.8**? | **Split answer: no to Qwen 3.8, yes to the subscription.** `qwen3.8-max` is *not* on the $50/mo Coding Plan — it's pay-as-you-go, so the DeepSeek verdict applies to it. The flat plan itself is worth buying for a different reason: **Codex and Grok can never serve `MCP_DEPENDENT_ROLES`**, so an Anthropic-compatible backend is the only second rung for reader/auto-review — and today's one is a z.ai **Lite** at 100% weekly. Build on the `ZaiAgentRun` seam; the real cost is that Alibaba publishes **no quota API**. | [`qwen-alibaba-integration-analysis.md`](qwen-alibaba-integration-analysis.md) |
| Share a **Director subscription with office members** until a deadline? | **Removed, pending a redesign** (2026-10-02, owner's call). The feature (29704be, e382abd, c13cc92) was reverted in full: settings UI, discovery, the shared Director target, the relay's `share.*` frames and the `director-sharing` feature flag. Boot deletes the saved `director_shares_v1` / `director_shared_selection_v1` rows, so no old offer or selection survives. Do not reintroduce it without a fresh owner decision. | `npm run test:director-provider` |
| Is it safe that **`office.sprogbroen.dk` is fully public**? | **Yes — being reachable was never the risk.** Anonymous callers get three counts; every surface naming a person, repo or message is behind a 190-bit admin key or a 256-bit device token. The real defect was the *deploy path*: a fresh host started an office whose join code is published in this repo. Fixed, with four hardening gaps. | [`relay-public-exposure-review.md`](relay-public-exposure-review.md) · `npm run test:relay-access` |
| Run any Claude role on **Sonnet** instead of Opus 5.5? | **Yes, but only for work the route judges well-scoped** (2026-10-02, owner's call, refining the 09-27 Opus-only rule). Narrow or contained changes run their implementor/QA, and read-lane lookups, on Sonnet 5.5. Goal steps, duration windows, shotgun splits, flagship risk and investigations stay on Opus, and a tight plan can move other work to Sonnet once. Pins and per-role Settings models still win. | [`.claude/rules/scoped-sonnet-routing.md`](../.claude/rules/scoped-sonnet-routing.md) · `npm run test:scoped-sonnet` |
| Use **LiveBench scores plus cost/token burn** when auto-selecting models and effort? | **Yes, inside a deterministic task-capability floor.** Adaptive work uses the cheapest reliable eligible model; substantial ambiguous/high-risk production, data-lifecycle, migration, cross-cutting, or sensitive user-facing work prefers Opus 5.5 and permits only documented flagship fallbacks. LiveBench is a daily cached secondary prior; durable local grades are stronger within that eligible tier and retain quality, QA, whole-pipeline dollars/turns/time, normalized token categories, and model×effort outcomes beyond task purging. `$0` subscription cost never hides scarce allowance burn. | [`livebench-model-selection.md`](livebench-model-selection.md) · `npm run test:route-selection` · `npm run test:route-pipeline` · `npm run test:livebench` · `npm run test:model-select` · `npm run test:auto-model` |
| Put recurring-free inference APIs directly into **task failover**? | **Yes, but reserve them for confidently small first attempts; no for coding roles.** Nine providers have secure connections and mandatory usage chips. A deterministic fail-closed policy admits only explicit read-lane lookups or narrow low-effort plans, never broad/risky/uncertain work, retries, continuations, or attachments. Admission also reserves enough visible quota for the bounded 4-call/8K-token run. Any free failure returns to the normal reliable ladder and cannot cap-park the task. Implementor/researcher/QA remain excluded until their write, web, shell, resume, steering, bus, and commit contracts exist. | [`free-ai-provider-connections.md`](free-ai-provider-connections.md); `npm run test:free-providers`; `npm run test:free-provider-routing` |
| Who integrates a task branch in a **commit-only (Vota)** repo? | **The agent, locally** (2026-10-02, owner's call). It rebases its `ggo/...` branch onto the base and fast-forwards the base, exactly as elsewhere, but never pushes. Pushing the base and merging its PR is the owner's only step. Leaving the work on the task branch and handing him the fast-forward is not "done". GGO retires a done task's worktree once its branch is in its base, rather than waiting for the card to be closed. | [`../.claude/rules/task-worktrees.md`](../.claude/rules/task-worktrees.md) · `npm run test:task-worktree` · `npm run test:task-worktree-pipeline` |
| Should GGO **force** every task into its own worktree, or only guide agents to one? | **Guidance only** (2026-10-02, owner's call, superseding the row below). Forcing every task into a worktree, even when it was alone in the repo, confused agents reading the branch topology. A task now starts in its dispatched checkout (`workspaceMode: "guided"`); its kickoff and the office tell it to claim its own worktree with `task_worktree` when another agent shares the repo. A claim never moves `thread.workspace` (the session is keyed by its cwd), so the Changes view and deliverable containment follow `thread.worktrees` explicitly. | [`../.claude/rules/task-worktrees.md`](../.claude/rules/task-worktrees.md) · `npm run test:task-worktree-pipeline` |
| Should tasks keep sharing one checkout per repo, or each get its **own branch / git worktree**? | **Own worktree** (2026-10-01, owner's call after a 33-hour Vota task blocked all other Vota work; the forced move at start was replaced by guidance on 2026-10-02, see the row above). This reverses "work on the active branch; never create worktrees". Branch `ggo/<name>-<id8>` in `<repo>.worktrees/<name>`, `<name>` chosen for the work before the first agent starts (a folder can't be renamed under a live session); `thread.workspace` swaps to it while `homeWorkspace` keeps grouping. Sub-tasks and collaborators share the parent's tree. Junctions are unlinked before any `git worktree remove`. | [`../.claude/rules/task-worktrees.md`](../.claude/rules/task-worktrees.md) · `npm run test:task-worktree` · `npm run test:task-worktree-pipeline` |
| Should a long-running **goal** keep dispatching fresh step tasks with a director call each, or **continue one session like a Codex goal**? | **One persistent session for sequential goals** (2026-10-02, the default for new and migrated goals). The director is asked only to audit a completion claim, after an unclean turn, a turn with no tool call, an owner change or a dead session. Deterministic holds come before any model call, and evidence-based stops (a second turn running with no tool call, no new work, the same blocker 3 turns running) end as `blocked`. A turn that ends on its report alone is a normal ending, so the first one asks the director instead of stopping (2026-10-02, after the d2r goal blocked on a turn that only reported). There is an optional, boundary-enforced step-task token budget (`budget_limited`). Parallel goals keep fresh steps. Five turns cost 1 director call + 1 dispatch instead of 5 + 5. No multi-hour A/B was run, so no saving percentage is claimed. | [`goal-persistent-sessions.md`](goal-persistent-sessions.md) |
| Should **"prepare a sub for reset"** respect the runway forecast and the soft weekly safety ceiling, like the older hidden account priority did? | **No — only hard availability outranks it.** A banked reset refills the window, so allowance those soft guards keep in reserve is exactly what would be wasted; a cap or the 98% hard limit still moves work elsewhere, and failover handles a mid-run cap. The burn ends the moment GGO redeems that sub's banked reset, and otherwise when the targeted weekly window passes or rolls early (a reset spent in the native app), so it cannot keep steering at a refilled sub. The hidden `temporary_claude_account_priority` kv it replaced is retired. A goal's burn-rate guard does not pace the burn target either (owner, 2026-10-02: "goals should just burn the vota sub"); a goal held for burn rate re-checks the moment a burn starts. | `.claude/rules/provider-selection-layers.md` · `npm run test:reset-burn` · `npm run test:provider-fallback` · `npm run test:auto-model` · `npm run reset-burn-lab` |

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

Reported bugs and planned work that aren't adopt/replace questions go in [`BACKLOG.md`](BACKLOG.md).

Related always-loaded pointers: `.claude/rules/model-backend-economics.md` (the economics that
decide most of these), `.claude/rules/add-an-implementor-backend.md` (the touch-point checklist once
you've decided to build).
