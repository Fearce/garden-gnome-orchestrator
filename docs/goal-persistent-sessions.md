# Goals continue in one persistent session (2026-10-02)

**Verdict:** a sequential goal (`maxConcurrent` 1) now carries ONE step task and its implementor session
from turn to turn, the way a Codex goal continues its own thread. The director is asked only when there is
something to judge. Parallel goals and goals with `persistentSession: false` keep the old fresh-step loop.
The code is `orchestrator/goals.ts` (`continueOnItsOwn`, `sendTurn`, `noProgress`, `blockerStreak`) over
`ThreadManager.continueGoalTask` / `goalTaskHold`. Traps: `.claude/rules/goals.md`. Shape:
`docs/agent-reference/CLAUDE-full.md` § "Goal-directed tasks".

## Reference

OpenAI's cookbook, [Using goals in Codex](https://developers.openai.com/cookbook/examples/codex/using_goals_in_codex):
a goal is durable and scoped to a thread. Codex continues that thread at idle turn boundaries, never while
user input or work is pending, and judges completion on evidence. A token budget is optional. A
continuation that made no tool call suppresses the next one.

The rest comes from the locally installed Codex goal tools and their continuation prompts, read-only, not
from the article: `blocked`, `usage_limited` and `budget_limited` are states of their own, blocked needs
the same impasse across three consecutive goal turns, and an explicit resume starts a fresh audit. The
local Codex D2R rollout (thread `01a0f32a…`) is consistent with that. It held 53 goal-continuation
prompts and 35 compactions in one thread. While the goal was active its `tokens_used` grew by exactly the
delta of `total_tokens − cached_input_tokens` (e.g. +156,565 between 08:37 and 08:49Z on 2026-10-01), and
paused intervals were not charged. Its continuation prompts classify each turn as progress, verified wait
or no progress, accept a wait only on a provably live process, job or tool handle, and audit each
requirement against authoritative evidence. Those are observed prompt texts, not a claim about Codex
internals.

## Measured baseline (before)

The paused D2R goal `1b678301…` ran 15 fresh step tasks, and each paid a new session's bootstrap (brief,
repo re-read, plan) plus a director call. The long steps were busy, not waiting on quota: step 8 had
28,764,913 ms of agent time over 28,934,684 ms elapsed, and step 14 had 24,828,190 over 25,080,819
(`probe:elapsed`). Cache reads were about 98–99% of the steps' recorded tokens. That is replayed context,
not fresh generation. It is excluded from the fresh-token budget below but still reported separately;
that does not make cached inference free.

## What changed

- **One task, one session.** After the first step, a clean turn that ends `CONTINUE` with no completion
  claim and no owner change goes straight back into the same task through `continueGoalTask`, which uses
  the owner Resume path with a short continuation (objective, last status line, rules) instead of a fresh
  brief. The provider's own compaction and recovery keep the context.
- **The director is asked only when there is something to judge:** the first step; a `COMPLETE` claim (an
  independent audit, so a lone claim never ends the goal); a failed or unclean (`review`) turn;
  an owner edit or Resume (`replan_at`); a pin change (that session runs on the old model); or a task that
  can take no more turns.
- **Deterministic guards, checked before a task continuation starts** (the director's initial and audit
  judgements have their own checks, below): queued owner input, open questions, review
  injections, a manual Proceed, a run still active or winding down, an owner resume in flight, a cap park
  awaiting auto-resume, a restart's auto-resume or drain, token safety, the global and per-repo concurrency
  caps, capacity and the burn rate. A held turn costs nothing and waits as `waiting` or `usage_limited`. A
  task past its hard deadline pauses the goal for the owner. Reservation is synchronous (`resuming`), so a second admission or an owner
  action cannot interleave with it.
- **No spinning.** A turn with no tool call hands the goal to the director, since a turn that ends on its
  report alone is a normal ending; a second in a row stops automatic continuation. Progress is evidence, never
  prose: at least 3 tool calls the task never made before, a new finding, or a changed git state (the same
  test auto-continue uses). A repeated report with no new work stops it, and so do 3 idle turns running.
  Any turn that did new work resets that count, whatever status it ended on, and a repeat is judged
  against the turn just before. Grok reports no tool calls, so its turns are never counted idle; a repeated
  report still stops them. The same `BLOCKED` impasse three turns running stops the goal as `blocked`. Only
  a repository change or a new finding starts a new count; rewording does not. `WAITING` defers one check
  at no cost; each check that finds the job still running and nothing new doubles the next wait (5, 10,
  20, 40 minutes, then hourly), so a long job's watch never stops the goal but costs at most a turn an
  hour. A timeout while reading a live job is not a reason to restart it.
- **Unclean turns are bounded too.** A `review` turn with no tool call counts toward the same pair. After
  2 unclean turns running, the task is not continued again: the next step is a fresh task, which the
  failed-step guard bounds like any other. A persistent goal's tasks skip the self-improvement round,
  which would otherwise replace the report the goal reads its status line from.
- **The carrier's pool, not any pool.** The next turn runs in the carrier's session on the backend its
  latest run actually used (a failed-over task left its dispatch pool). When that pool is over pace the
  goal waits as `usage_limited` before calling the director, and a pool that runs out during the call
  means waiting, never handing the session's judgement to a fresh task elsewhere.
- **Optional token budget**, unset by default. It counts step-task run usage (fresh input plus output,
  cache reads apart) from the goal's recorded `usage_since` baseline, and is checked between turns, so a
  running turn can exceed it. Director judgements are outside the meter. A spent budget stops the goal as
  `budget_limited`, and Resume is refused until the budget is raised or removed. A cancelled step task
  pauses the goal until the owner resumes it; it does not call the director by itself. Grok reports no usage, so
  a budgeted goal is never pinned to it, never offered it, never routed to it automatically, and never
  continues a Grok session. A run with no usage row makes the total a lower bound (`≥`), never a zero.
- **Existing goals** get `persistent_session = 1` and a `usage_since` baseline at migration time. Earlier
  runs are shown only as a count, because pre-2026-09-28 rows may hold session-cumulative snapshots. No
  goal is resumed, and no running step is interrupted.

## Call counts (deterministic, `test:goals` → `goalSession.test.ts`)

Five turns of the same scripted work:

| Loop | Director calls | Fresh task dispatches | Continuations into the same session |
|---|---|---|---|
| fresh-step (old, still used for parallel goals) | 5 | 5 | 0 |
| persistent (new default) | 1 | 1 | 4 |

A continuation is under 2,500 characters, against a full step brief plus a new session's bootstrap.

## Limitations

- **No multi-hour A/B was run**, so there is no measured token saving and none is claimed. The call counts
  above are the deterministic difference.
- Historical per-run totals before 2026-09-28 (this install's meter fix) can be cumulative session
  snapshots, so they cannot be summed into a reliable before-figure. Production accounting never uses that
  date: it counts from each goal's own baseline.
- Providers report usage differently (Codex input includes the cached part, Claude's does not; Grok
  reports none). The usage line normalises categories but is not a cross-provider cost comparison.
- The budget is boundary-enforced from persisted run rows, not a streaming per-token cap.
- Director judgements are not linked to step-task runs, so they are outside both the usage line and the
  budget.
- The unclean-turn count, the waiting backoff and the retired-carrier set are kept in memory. After a
  restart a task gets up to two more unclean turns, and a long job's watch starts again at 5 minutes.
