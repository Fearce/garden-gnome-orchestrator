import type { GoalUsage, ImplementorProvider } from "../types.js";

/** Which backend produced a run, read back off its persisted account label ("codex:…" ⇒ Codex, "grok:…" ⇒
 *  Grok, "zai:…" ⇒ z.ai, a Claude sub's own label ⇒ Claude). */
export function providerOfRunAccount(account: string | null | undefined): ImplementorProvider {
  if (account?.startsWith("codex:")) return "codex";
  if (account?.startsWith("grok:")) return "grok";
  if (account?.startsWith("zai:")) return "zai";
  return "claude";
}

/** The only backend whose runs never report token usage, so a token budget cannot see its work. */
export const UNMETERED_PROVIDER: ImplementorProvider = "grok";

/** One `agent_runs` row's token columns, as the usage query reads them. */
export interface RunTokenRow {
  account: string | null;
  startedAt: number;
  endedAt: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadInputTokens: number | null;
  cacheCreationInputTokens: number | null;
}

interface RunTokens {
  freshInput: number;
  output: number;
  cached: number;
}

/**
 * A run's tokens in provider-neutral categories. Claude and z.ai report input WITHOUT cache reads, and a
 * cache write is fresh input the model read for the first time. Codex reports input INCLUDING the cached
 * part, so the cached share is taken back out. Null when the run recorded no usage at all.
 */
export function runTokens(row: RunTokenRow): RunTokens | null {
  const input = row.inputTokens;
  const output = row.outputTokens;
  const cacheRead = row.cacheReadInputTokens ?? 0;
  const cacheWrite = row.cacheCreationInputTokens ?? 0;
  if (input == null && output == null && !cacheRead && !cacheWrite) return null;
  const freshInput = providerOfRunAccount(row.account) === "codex"
    ? Math.max(0, (input ?? 0) - cacheRead)
    : (input ?? 0) + cacheWrite;
  return { freshInput, output: output ?? 0, cached: cacheRead };
}

/**
 * A goal's usage from its step tasks' run rows, counted from `since`: the goal's recorded metering
 * baseline. Every run started at or after it was written by a build whose meters report each run's own
 * tokens, so those rows sum. Older rows may hold session-cumulative snapshots, which cannot be summed
 * and are not reconstructed: they are only counted in `runsBeforeBaseline`. A run with no usage row is
 * counted in `unmeteredRuns` and makes `tokensUsed` a lower bound, never a silent zero.
 */
export function summarizeRunUsage(rows: RunTokenRow[], since: number): GoalUsage {
  const usage: GoalUsage = { ...EMPTY_GOAL_USAGE, since };
  for (const row of rows) {
    if (row.startedAt < since) {
      usage.runsBeforeBaseline++;
      continue;
    }
    usage.runs++;
    if (row.endedAt != null && row.endedAt > row.startedAt) usage.agentSeconds += Math.round((row.endedAt - row.startedAt) / 1000);
    const tokens = runTokens(row);
    if (!tokens) {
      usage.unmeteredRuns++;
      continue;
    }
    usage.freshInputTokens += tokens.freshInput;
    usage.outputTokens += tokens.output;
    usage.cachedInputTokens += tokens.cached;
  }
  usage.tokensUsed = usage.freshInputTokens + usage.outputTokens;
  return usage;
}

export const EMPTY_GOAL_USAGE: GoalUsage = {
  tokensUsed: 0,
  freshInputTokens: 0,
  outputTokens: 0,
  cachedInputTokens: 0,
  runs: 0,
  unmeteredRuns: 0,
  runsBeforeBaseline: 0,
  agentSeconds: 0,
  since: 0,
};

/** The usage line the console and the director read, e.g. "≥ 1.2M of 5M step-task tokens (2 runs reported no usage)".
 *  Director judgements run outside the step tasks and are not in it. */
export function describeGoalUsage(usage: GoalUsage, budget: number | null): string {
  const used = `${usage.unmeteredRuns ? "≥ " : ""}${compactTokens(usage.tokensUsed)}`;
  const parts = [budget != null ? `${used} of ${compactTokens(budget)} step-task tokens` : `${used} step-task tokens`];
  if (usage.unmeteredRuns) parts.push(`${usage.unmeteredRuns} run${usage.unmeteredRuns === 1 ? "" : "s"} reported no usage`);
  if (usage.runsBeforeBaseline) parts.push(`${usage.runsBeforeBaseline} earlier run${usage.runsBeforeBaseline === 1 ? "" : "s"} not counted`);
  return parts.length > 1 ? `${parts[0]} (${parts.slice(1).join("; ")})` : parts[0]!;
}

export function compactTokens(n: number): string {
  if (n >= 1_000_000) return `${trimZero((n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1))}M`;
  if (n >= 1_000) return `${trimZero((n / 1_000).toFixed(n >= 10_000 ? 0 : 1))}k`;
  return String(n);
}

const trimZero = (s: string): string => s.replace(/\.0$/, "");
