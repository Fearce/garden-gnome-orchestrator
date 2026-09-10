/* taskScene.ts: the data half of the screensaver.
 *
 * The prototype this grew out of replayed a 52-second script. This does not: every lane below is a
 * real task off the console's own store, and every number the scene draws is derived from live
 * `Thread` + `AgentRun` state. Keeping that derivation here, as pure functions of (threads, runs,
 * now), is what makes it testable without a DOM and what keeps the renderer free of policy.
 *
 * THE PROGRESS PROBLEM. Neither `Thread` nor `AgentRun` carries a percentage, because the pipeline
 * genuinely does not know one. What it does know is which stages a task has REACHED and how long the
 * live one has been running, so that is what the build height is made of:
 *
 *   floor  the furthest stage any run of this task has entered, as the start of that stage's band.
 *          A max over stages reached, so the frame can never fall back down when a task is handed
 *          back for a fix round.
 *   creep  inside a live stage, a saturating curve on the ACTIVE run's real elapsed time. It
 *          approaches the band's end and never arrives, which is the honest shape: a long-running
 *          implementor has clearly done more than a fresh one, and neither is "nearly finished".
 *
 * A parked or finished task holds its floor. `done` is the one state that reads 1, and it is the
 * only one that raises the pennant. The split between `buildProgressFor` (per store update) and
 * `buildHeight` (per animation frame) is deliberate: the render loop then does arithmetic on five
 * numbers instead of re-walking every run sixty times a second.
 */

import type { AgentRun, Role, Thread, ThreadState } from "../../types.js";
import { stateColor, stateLabel } from "../../lib/format.js";
import type { Tool } from "./rig.js";

/** What the live data says a lane should be doing, before any arrival/departure animation. The
 *  renderer owns the transitional `descending` / `ascending` poses between these. */
export type TargetPhase = "perched" | "working" | "done" | "failed";

/** Everything the render loop needs to know the build height at an arbitrary instant. */
export interface BuildProgress {
  /** The height already earned by the stages this task has reached. */
  floor: number;
  /** The height the live stage approaches. Equal to `floor` when nothing is being worked. */
  ceil: number;
  /** Seconds of work after which the gap is ~63% crossed. */
  tau: number;
  /** When the live run started, or null when no run is climbing this band. */
  since: number | null;
  /** When it stopped, or null while it is still going. */
  until: number | null;
}

export interface SceneTask {
  id: string;
  title: string;
  /** The workspace leaf, as the card's mono line. */
  workspace: string;
  role: Role;
  tool: Tool;
  target: TargetPhase;
  build: BuildProgress;
  badge: string;
  /** A CSS colour expression for the card's state accent, from the console's own state palette. */
  stateColor: string;
  /** The task's own live line: the streaming agent text if any, else its brief preview. */
  activity: string;
  /** When the clock started, so the lane can show a real elapsed time. Null while never started. */
  startedAt: number | null;
  /** Where the clock stopped, for a finished task. Null while it is still running. */
  endedAt: number | null;
}

/** How many gnomes the beam can carry before the cards stop being readable. Beyond this the scene
 *  shows the most interesting lanes (live work first) and the rest simply are not on stage. */
export const MAX_LANES = 6;

/** Each role's tool. The first five are the prototype's cast, one motion each: the saw reciprocates,
 *  the pickaxe chops through a long arc, the hammer strikes, the wrench ratchets a bolt round, the
 *  gavel taps. `reader` deliberately shares the researcher's pickaxe (both dig for an answer, and
 *  their role hues are far apart); `director` never owns a lane of its own but is mapped so the
 *  lookup is total. */
const ROLE_TOOL: Record<Role, Tool> = {
  planner: "saw",
  researcher: "pickaxe",
  implementor: "hammer",
  qa: "wrench",
  reviewer: "gavel",
  reader: "pickaxe",
  director: "gavel",
};

/** The stage a thread state belongs to, as a band of the 0..1 build. The bands are the pipeline's
 *  real order, so a task visibly climbs its own frame as it moves through planning, implementation
 *  and QA. A zero-width band is a state that WAITS rather than works: it holds the height the
 *  previous stage reached instead of adding to it. */
const STATE_BAND: Record<ThreadState, [number, number]> = {
  intake: [0.0, 0.03],
  enriching: [0.03, 0.08],
  queued: [0.08, 0.08],
  awaiting_user: [0.08, 0.08],
  planning: [0.08, 0.3],
  researching: [0.3, 0.44],
  awaiting_approval: [0.44, 0.44],
  implementing: [0.44, 0.82],
  qa: [0.82, 0.95],
  review: [0.95, 0.95],
  reviewing: [0.95, 0.99],
  paused: [0.0, 0.0],
  done: [1, 1],
  failed: [0.0, 0.0],
  cancelled: [0.0, 0.0],
  closed: [0.0, 0.0],
};

/** The stage each ROLE occupies, so a task's floor can be read off the runs that actually happened
 *  rather than off its current state alone (a task handed back from QA is in `implementing` again,
 *  but its frame has a QA pass in it and must not drop back down). */
const ROLE_STATE: Record<Role, ThreadState> = {
  director: "enriching",
  planner: "planning",
  researcher: "researching",
  implementor: "implementing",
  qa: "qa",
  reviewer: "reviewing",
  reader: "implementing",
};

/** Seconds of real work after which a stage's band is ~63% crossed. Scaled to how long each role
 *  actually takes: a reader answers in a couple of minutes, an implementor works for tens. */
const ROLE_TAU: Record<Role, number> = {
  director: 60,
  planner: 240,
  researcher: 300,
  implementor: 900,
  qa: 420,
  reviewer: 300,
  reader: 120,
};

/** The role a live state is being worked by. Only the states where somebody is swinging a tool
 *  answer; everything else falls back to whichever role ran most recently. */
const STATE_ROLE: Partial<Record<ThreadState, Role>> = {
  enriching: "director",
  planning: "planner",
  researching: "researcher",
  implementing: "implementor",
  qa: "qa",
  reviewing: "reviewer",
};

const WORKING_STATES = new Set<ThreadState>(["enriching", "planning", "researching", "implementing", "qa", "reviewing"]);
const FAILED_STATES = new Set<ThreadState>(["failed", "cancelled"]);

/** Which pose the live data asks for. `done` and `failed` are terminal poses; everything that is not
 *  actively being worked perches on the beam, which is exactly what a queued or parked task is. */
export function targetPhase(state: ThreadState): TargetPhase {
  if (state === "done") return "done";
  if (FAILED_STATES.has(state)) return "failed";
  return WORKING_STATES.has(state) ? "working" : "perched";
}

/** The newest run of a role, which is the one doing the work now. A restarted stage has several
 *  rows, and a resumed one several more, so "the latest start" is the only stable read. */
function newestRun(runs: AgentRun[], role: Role): AgentRun | null {
  return runs.reduce<AgentRun | null>((best, r) => (r.role === role && (!best || r.startedAt > best.startedAt) ? r : best), null);
}

/** The role this lane's gnome wears. A live stage names its own role; a parked one keeps the role
 *  that last worked it, so a task waiting in review still shows the QA gnome that put it there. */
function roleFor(thread: Thread, runs: AgentRun[]): Role {
  const live = STATE_ROLE[thread.state];
  if (live) return live;
  const latest = runs.reduce<AgentRun | null>((best, r) => (!best || r.startedAt > best.startedAt ? r : best), null);
  if (latest) return latest.role;
  return thread.lane === "read" ? "reader" : "planner";
}

/** The five numbers the build height is a function of. See the file header. */
export function buildProgressFor(thread: Thread, runs: AgentRun[]): BuildProgress {
  const still = (height: number): BuildProgress => ({ floor: height, ceil: height, tau: 1, since: null, until: null });
  if (thread.state === "done") return still(1);

  // The furthest stage anything has entered. A closed task is off the board entirely, so
  // `closedPrevState` never has to be consulted.
  let floor = STATE_BAND[thread.state][0];
  for (const run of runs) floor = Math.max(floor, STATE_BAND[ROLE_STATE[run.role]][0]);
  floor = Math.min(1, floor);

  const bandEnd = STATE_BAND[thread.state][1];
  const role = STATE_ROLE[thread.state];
  if (!role || bandEnd <= floor) return still(floor);

  const current = newestRun(runs, role);
  if (!current) return still(floor);

  return { floor, ceil: bandEnd, tau: ROLE_TAU[role], since: current.startedAt, until: current.endedAt ?? null };
}

/** How much of the frame is up at `now`. A saturating curve on seconds of real work: fast at first,
 *  then asymptotic, so an in-flight stage never claims the next stage's ground. */
export function buildHeight(build: BuildProgress, now: number): number {
  if (build.since == null || build.ceil <= build.floor) return build.floor;
  const seconds = Math.max(0, (build.until ?? now) - build.since) / 1000;
  if (!(seconds > 0)) return build.floor;
  return Math.min(1, build.floor + (build.ceil - build.floor) * (1 - Math.exp(-seconds / build.tau)));
}

/** The one line a lane's card narrates.
 *
 *  An agent's draft arrives as markdown that grows a line at a time, so the NEWEST non-empty line is
 *  what it is saying right now. That is deliberately not what the board's own card shows: the board
 *  is read to find out how a task ended and prefers a verdict headline, while the scene is watched
 *  from across the room and wants the line that is moving. Bullet markers and bold runs are stripped
 *  because a card at this size has no room to render them. */
function laneLine(text: string): string {
  const lines = text
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  const newest = lines.length ? lines[lines.length - 1]! : text.trim();
  const plain = newest.replace(/^[-*+•]\s+/, "").replace(/\*\*/g, "").trim();
  return plain.length > LANE_LINE_MAX ? `${plain.slice(0, LANE_LINE_MAX - 1)}…` : plain;
}

/** As much of the activity line as a lane card fits on its two wrapped rows. */
const LANE_LINE_MAX = 120;

/** The last path segment of a workspace, which is the only part that fits a card. */
function workspaceLeaf(workspace: string): string {
  const parts = workspace.split(/[\\/]+/).filter(Boolean);
  return parts.length ? parts[parts.length - 1]! : workspace;
}

/** How interesting a lane is, lowest first, so `MAX_LANES` keeps the live work on stage. */
function laneRank(state: ThreadState): number {
  if (WORKING_STATES.has(state)) return 0;
  if (state === "done" || FAILED_STATES.has(state)) return 2;
  return 1; // queued, parked, waiting on the owner
}

/** When this lane's clock started: the first run, else the task's own creation. */
function startOf(runs: AgentRun[], thread: Thread): number | null {
  if (!runs.length) return WORKING_STATES.has(thread.state) ? thread.createdAt : null;
  return runs.reduce((min, r) => Math.min(min, r.startedAt), Number.POSITIVE_INFINITY);
}

/** Group runs by the task they belong to, once per store update. */
function groupRuns(runs: Record<string, AgentRun>): Map<string, AgentRun[]> {
  const byThread = new Map<string, AgentRun[]>();
  for (const run of Object.values(runs)) {
    const list = byThread.get(run.threadId);
    if (list) list.push(run);
    else byThread.set(run.threadId, [run]);
  }
  return byThread;
}

/** Turn the console's live task state into the cast on the beam.
 *
 *  Collaborator threads (`parentId`) are left out for the same reason the board leaves them out:
 *  they belong inside their lead. Closed tasks are off the board entirely.
 *
 *  `drafts` is the live streaming agent text keyed by task id, so a working gnome's card narrates
 *  what its agent is actually saying rather than a canned line. */
export function sceneTasks(
  threads: Record<string, Thread>,
  runs: Record<string, AgentRun>,
  drafts: Record<string, string | undefined> = {},
  maxLanes = MAX_LANES,
): SceneTask[] {
  const byThread = groupRuns(runs);

  const eligible = Object.values(threads).filter((t) => !t.parentId && t.state !== "closed");
  // Rank first, then oldest-first inside a rank: a stable order keeps a gnome from teleporting to
  // another card the moment an unrelated task updates.
  eligible.sort((a, b) => laneRank(a.state) - laneRank(b.state) || a.createdAt - b.createdAt);

  return eligible.slice(0, maxLanes).map((thread) => {
    const threadRuns = byThread.get(thread.id) ?? [];
    const role = roleFor(thread, threadRuns);
    const target = targetPhase(thread.state);
    const line = drafts[thread.id] || thread.briefPreview || thread.brief?.split("\n")[0] || thread.title;
    return {
      id: thread.id,
      title: thread.title,
      workspace: workspaceLeaf(thread.workspace),
      role,
      tool: ROLE_TOOL[role],
      target,
      build: buildProgressFor(thread, threadRuns),
      badge: stateLabel(thread.state),
      stateColor: stateColor(thread.state),
      activity: laneLine(line),
      startedAt: startOf(threadRuns, thread),
      // A finished task's clock stops when it last changed, which is when it finished.
      endedAt: target === "done" || target === "failed" ? thread.updatedAt : null,
    };
  });
}
