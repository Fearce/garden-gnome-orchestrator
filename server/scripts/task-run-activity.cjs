// Classify successful-looking agent runs that never reached a new model turn.
//
// Most hollow resumes persist no non-system messages. The Agent SDK can also replay a pending
// tool_use from the query that hit its turn ceiling, then finish the resumed query at 0 turns / $0.
// Message traffic is therefore only the first signal; explicit zero telemetry outranks it.

function hollowRunReading(run, nonSystemMessages) {
  if (run?.state !== "done" || run?.ended_at == null) return null;

  const messageCount = Number(nonSystemMessages);
  if (!Number.isInteger(messageCount) || messageCount < 0) return null;

  if (messageCount === 0) {
    return {
      kind: "empty",
      messageCount,
      summary: "⚠ HOLLOW — no non-system messages; never reached the model",
    };
  }

  if (run.num_turns === 0 && run.cost_usd === 0) {
    return {
      kind: "zero-turn-with-output",
      messageCount,
      summary: `⚠ HOLLOW — ${messageCount} non-system message${messageCount === 1 ? "" : "s"}, but 0 turns / $0`,
    };
  }

  return null;
}

module.exports = { hollowRunReading };
