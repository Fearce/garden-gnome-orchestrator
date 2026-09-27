import type { AgentRun, FeedItem } from "../types.js";
import { runActive } from "./format.js";

/**
 * A live run that has produced nothing the feed can show yet.
 *
 * A Claude CLI start on a loaded machine routinely takes minutes before its first message (process
 * start, SessionStart hooks, MCP connects, then the first model turn), and a model change adds a
 * compressed-handoff step before the run even exists. With nothing in the feed a re-pinned task reads
 * as dead, although its run row already names the model it was launched on.
 */
export interface SilentRun {
  run: AgentRun;
  /** `launching`: the CLI has not reported its session yet. `first-turn`: it has, the model hasn't spoken. */
  phase: "launching" | "first-turn";
}

/** The task's newest live run, if it has not spoken yet. Only the newest counts: an older live run
 *  that is quiet is a role waiting on the newer one, not a start in progress. */
export function silentLiveRun(
  runs: readonly AgentRun[],
  feed: readonly FeedItem[],
  streamingRunIds: ReadonlySet<string>,
): SilentRun | undefined {
  const newest = runs
    .filter((run) => run.endedAt == null && runActive(run.state))
    .reduce<AgentRun | undefined>((latest, run) => (!latest || run.startedAt > latest.startedAt ? run : latest), undefined);
  if (!newest || streamingRunIds.has(newest.id)) return undefined;
  if (feed.some((item) => "runId" in item && item.runId === newest.id)) return undefined;
  return { run: newest, phase: newest.state === "starting" ? "launching" : "first-turn" };
}
