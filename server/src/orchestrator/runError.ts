import type { AgentEvent } from "../types.js";

type ResultEvent = Extract<AgentEvent, { type: "result" }>;

// An SDK error result reports no message text — only an `errors` array and a `subtype` — so those are
// the only diagnostics available when persisting a dead run. The involuntary cutoffs (a turn ceiling,
// a structured-output retry exhaustion) arrive here routinely rather than exceptionally, which is why a
// subtype has to read as a reason: an operator reading the run history otherwise cannot tell a deliberate,
// resumable cutoff from a crash.

// Plain-English reason per message-less error subtype the SDK can end a run with. Deliberately says what
// happened and nothing about what follows — the same subtype reaches a warm-resumed implementor and a
// planner/QA run that parks for the owner, so any promise of a resume here would be a lie on half the paths.
const SUBTYPE_REASONS: Record<string, string> = {
  error_max_turns: "Stopped at the per-session turn ceiling (error_max_turns) — an involuntary cutoff, not a crash.",
  error_max_structured_output_retries:
    "Stopped after too many structured-output retries (error_max_structured_output_retries) — the agent never returned a reply matching the schema.",
  error_max_budget_usd: "Stopped at the per-session cost ceiling (error_max_budget_usd) — an involuntary cutoff, not a crash.",
};

export const MAX_RUN_ERROR_LEN = 2000;

/** The failure reason to persist for an errored run: the agent's own words when it produced any (the CLI
 *  backends put them in `result`, the SDK in `errors`), else what the subtype says happened. Never the
 *  opaque "Run failed." unless the result reported no text and no subtype whatsoever. */
export function runErrorText(res: ResultEvent): string {
  const text = ownWords(res) || SUBTYPE_REASONS[res.subtype] || subtypeFallback(res.subtype);
  return text.slice(0, MAX_RUN_ERROR_LEN);
}

function ownWords(res: ResultEvent): string {
  const own = res.result?.trim();
  if (own) return own;
  return (res.errors ?? [])
    .map((e) => e.trim())
    .filter(Boolean)
    .join("; ");
}

function subtypeFallback(subtype: string): string {
  const name = subtype.trim();
  return name ? `Run failed (${name}).` : "Run failed.";
}
