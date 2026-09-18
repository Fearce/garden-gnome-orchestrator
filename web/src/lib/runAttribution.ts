import type { AgentRun, Role } from "../types.js";
import { modelEffortLabel } from "./format.js";

/**
 * Which model wrote a line — resolved from the run that produced it, never from the role.
 *
 * A task routinely changes model mid-work (usage saving, a cap failover, an auto-resume that lands on
 * another subscription), and every launch is its own `agent_runs` row whose `model` is written once and
 * never rewritten. So the run IS the record of what wrote a message; labelling a whole role from its
 * latest run retroactively restamps every earlier message with a model that never saw it.
 */

/**
 * Fold a run snapshot into the index already held, keyed by run id.
 *
 * The fields the feed reads are immutable, but a run's lifecycle fields are not — and a reply is read
 * on the server before the client applies it, so it can carry a run that has ended since. Keep the copy
 * that is further along rather than the one that happened to arrive last, or a history reply racing a
 * live `run.upsert` reopens a finished run.
 */
export function mergeRunIndex(existing: Record<string, AgentRun>, incoming: readonly AgentRun[]): Record<string, AgentRun> {
  const merged = { ...existing };
  for (const run of incoming) {
    const held = merged[run.id];
    if (held && held.endedAt != null && run.endedAt == null) continue;
    merged[run.id] = run;
  }
  return merged;
}

/**
 * Drop runs whose task the board no longer lists.
 *
 * The connect snapshot is a bounded fleet-wide slice, so it has to be merged into — not over — the runs
 * an open task loaded from its own history. Merging alone would let a long-lived tab accumulate runs for
 * purged work forever, so a hello prunes against the task list it just delivered.
 */
export function pruneRunIndex(runs: Record<string, AgentRun>, threadIds: ReadonlySet<string>): Record<string, AgentRun> {
  const kept: Record<string, AgentRun> = {};
  for (const [id, run] of Object.entries(runs)) if (threadIds.has(run.threadId)) kept[id] = run;
  return kept;
}

/**
 * The model+effort label for one feed row.
 *
 * Undefined when the run isn't in the index: the row then shows no model at all. Borrowing a
 * neighbouring run's model is precisely the falsification this replaces — an unlabelled line is honest,
 * a wrongly-labelled one is not.
 */
export function runModelLabel(runs: Record<string, AgentRun>, runId: string | undefined | null): string | undefined {
  const run = runId ? runs[runId] : undefined;
  if (!run) return undefined;
  return modelEffortLabel(run.model, run.effort) || undefined;
}

/** A role's models, newest run first, deduplicated by their rendered label. */
function roleModelLabels(runs: readonly AgentRun[], role: Role): string[] {
  const ordered = runs
    .filter((run) => run.role === role)
    .sort((a, b) => b.startedAt - a.startedAt)
    .map((run) => modelEffortLabel(run.model, run.effort))
    .filter((label): label is string => label.length > 0);
  return [...new Set(ordered)];
}

/**
 * The agent-filter chip's label. It stands for a role's whole history, so when that role ran on more
 * than one model it may not name just one: the current model leads and the rest are counted, with the
 * title enumerating every model newest-first.
 */
export function roleModelSummary(runs: readonly AgentRun[], role: Role): { label: string; title?: string } | undefined {
  const labels = roleModelLabels(runs, role);
  const current = labels[0];
  if (!current) return undefined;
  if (labels.length === 1) return { label: current };
  return { label: `${current} +${labels.length - 1}`, title: `Ran on ${labels.join(", ")}` };
}
