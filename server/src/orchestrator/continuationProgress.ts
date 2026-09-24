/**
 * Whether an implementor session that is about to be auto-continued actually did NEW work.
 *
 * A turn-ceiling cutoff is a per-session allowance running out, not the task running out. A long task
 * (task 3ab7019e, 2026-09-24: six productive 100-turn sessions, a commit and two findings along the way)
 * must keep being continued for as long as it keeps working. It used to stop after a fixed count of 8
 * continuations whatever those sessions did, and parked in `review` mid-work. The failure a bound really
 * exists for is a WEDGED session: one that burns its turns re-running the same poll, re-reading the same
 * files, or coming back empty. So the bound is a no-progress STREAK, never a count of continuations.
 *
 * "New work" is judged deterministically, with no model call. Any one of these is progress:
 *  - at least MIN_NOVEL_ACTIONS tool calls that none of the recent sessions made (`ActionHistory`);
 *  - a finding whose summary the task has not posted before (a repeated "still blocked on X" is not);
 *  - the workspace's git state (HEAD, status, diff) changed since the previous check.
 * Prose never counts: model text is almost never repeated word for word, so it cannot tell a wedge from
 * work. A backend that records no tool calls (Grok) therefore progresses through findings and git.
 */

/** Below this many never-seen actions a session is treated as repeating itself. A productive 100-turn
 *  session measured 100-200 tool calls, so three is far below any real work and far above a poll loop. */
export const MIN_NOVEL_ACTIONS = 3;

/** Planning bookkeeping, not work: a todo list changes on every call while nothing else moves. */
const BOOKKEEPING_TOOLS = new Set(["TodoWrite", "TodoRead", "todo"]);

/** Input fields that change between two runs of the SAME action: a free-text description, call/item ids,
 *  and the status/output a Codex MCP item carries in its input. */
const VOLATILE_INPUT_KEYS = new Set(["description", "id", "call_id", "item_id", "status", "aggregated_output", "timeout", "run_in_background"]);

/** One ended session's activity, as read from the thread's persisted rows. */
export interface SessionActivity {
  /** Tool-call rows (`name {input}`), in order. */
  actions: string[];
  /** Summaries of the findings/deliverables this task's own runs posted during the session. */
  findingSummaries: string[];
  /** Summaries the task had already posted before the session began. */
  earlierFindingSummaries: string[];
}

export interface SessionProgress {
  progressed: boolean;
  /** Distinct actions no recent session made. */
  novel: number;
  /** Findings with a summary the task never posted before. */
  newFindings: number;
  /** This session's distinct action keys — what `ActionHistory.record` takes. */
  actionKeys: Set<string>;
}

export function assessSessionProgress(
  activity: SessionActivity,
  recent: ReadonlySet<string>,
  workspaceChanged = false,
): SessionProgress {
  const actionKeys = new Set(activity.actions.map(actionKey).filter((k): k is string => !!k));
  let novel = 0;
  for (const key of actionKeys) if (!recent.has(key)) novel++;
  const earlier = new Set(activity.earlierFindingSummaries.map(normalize));
  const newFindings = new Set(activity.findingSummaries.map(normalize).filter((s) => s && !earlier.has(s))).size;
  return { progressed: workspaceChanged || newFindings > 0 || novel >= MIN_NOVEL_ACTIONS, novel, newFindings, actionKeys };
}

/**
 * The actions of the last few sessions that did anything. Comparing with ONE previous session lets a
 * loop that alternates between two routines (poll, re-read config, poll, …) read as new every time, and
 * lets one near-empty session reset the comparison. `size` is the streak limit + 1, so every session
 * inside one streak is compared against everything the streak has already done.
 */
export class ActionHistory {
  private readonly sessions: Set<string>[] = [];
  constructor(private readonly size: number) {}

  union(): Set<string> {
    const all = new Set<string>();
    for (const s of this.sessions) for (const k of s) all.add(k);
    return all;
  }

  record(keys: ReadonlySet<string>): void {
    if (keys.size === 0) return;
    this.sessions.push(new Set(keys));
    while (this.sessions.length > this.size) this.sessions.shift();
  }
}

/** The part of a tool row that identifies the action: its name and input minus the volatile fields.
 *  Null for bookkeeping tools. A row clipped mid-JSON (the SQL read caps content) keys on its raw text. */
export function actionKey(row: string): string | null {
  const text = row.trim();
  const space = text.indexOf(" ");
  const name = space < 0 ? text : text.slice(0, space);
  if (BOOKKEEPING_TOOLS.has(name)) return null;
  if (space < 0) return name || null;
  const raw = text.slice(space + 1);
  try {
    const input = JSON.parse(raw) as unknown;
    return `${name} ${JSON.stringify(stripVolatile(input))}`;
  } catch {
    return `${name} ${normalize(raw)}`;
  }
}

function stripVolatile(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripVolatile);
  if (!value || typeof value !== "object") return typeof value === "string" ? normalize(value) : value;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) if (!VOLATILE_INPUT_KEYS.has(k)) out[k] = stripVolatile(v);
  return out;
}

/** The park reason once the streak runs out. Deliberately free of capacity wording, so a usage-window
 *  rollover (`capacityStall.ts`) never wakes a wedged task, and names no button: the auto-review fix
 *  round embeds it in its own hand-back, whose re-arm is a different control. */
export function noProgressParkText(sessions: number): string {
  return (
    `auto-continue stopped: ${sessions} consecutive sessions did no new work (the same actions repeated, ` +
    "or nothing at all, no new findings, and no change to the workspace). It looks stuck and needs your review: send it direction, or resume it to keep going."
  );
}

function normalize(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}
