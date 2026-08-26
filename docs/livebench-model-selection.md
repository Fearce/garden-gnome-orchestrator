# LiveBench as an auto-selection signal

**Verdict: adopt it as a daily cached capability prior, not as the routing authority.** LiveBench is
especially useful before this orchestrator has enough graded tasks of its own, and its category breakdown
can distinguish coding, agentic coding, reasoning, and data-analysis work. It remains subordinate to live
subscription headroom, provider/tool compatibility, and this orchestrator's own accepted-task grades.

## Why this shape

LiveBench publishes raw `table_<release>.csv` task scores and `categories_<release>.json` mappings in its
public leaderboard repository. Overall is the mean of category averages; it is not a separately published
number. The orchestrator reads the release manifest and those two source files directly instead of scraping
the rendered site.

`LiveBenchScores` stores the newest complete release in the existing SQLite kv table and refreshes it every
24 hours. A fetch error keeps the last good snapshot; no snapshot simply means auto-selection proceeds with
local evidence only. Dispatch is never blocked by the benchmark service.

## Matching and trust

- A benchmark row whose id equals or extends the configured model id is labelled **exact model**. Effort
  variants are kept separately so the selector can see whether extra reasoning actually moved the score.
- A newer unbenchmarked model may use the newest older result from the same narrow model family (for
  example GPT 5.6 using GPT 5.5) only as an explicitly labelled **older same-family prior**.
- No cross-family inference is made. A model with no honest comparison gets no score.
- The selector prompt tells the judging model to prefer relevant category scores, exact evidence, local
  task outcomes, and native-tool fit rather than sorting blindly by overall score.

The same evidence annotates both the sticky director choice and the per-task implementor/model-effort
choice when `Auto-select the implementor model` is enabled.

## Durable local cost and usage evidence

LiveBench is only the cold-start prior. Every auto-picked task permanently records the outcome and the full
pipeline cost needed to reach it: QA rounds, dollars, turns, wall time, and normalized input/output/cache/
reasoning/total token counts. These totals include planner and QA retries because an ostensibly cheap
implementor that causes extra rounds is not cheap in practice. The aggregate grade survives task purging.

Future picks receive both per-repository and global model history, plus model-by-effort history. They are
explicitly told that `$0` on a subscription is not zero cost when it burned a scarce token window, and to
choose the lowest-cost model and effort that is still likely to finish unattended.
