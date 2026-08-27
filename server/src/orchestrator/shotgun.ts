/**
 * SHOTGUN TASKS — N collaborators working one objective in one repository, at the same time.
 *
 * The hard constraint is the repo convention: no git worktrees, everyone on the active branch (the
 * owner's standing doctrine). So parallelism cannot come from isolating checkouts — it has to come from
 * DISJOINT OWNERSHIP inside the single shared tree. That is what this module enforces.
 *
 * The shape: the planner's plan is decomposed into K work packages with non-overlapping file ownership.
 * The lead task takes the first; each other package becomes a collaborator thread on the same workspace,
 * running the ordinary implementor pipeline. Because they share a workspace, the existing office
 * machinery groups them into a project room automatically (`ensureGroup`) — that is exactly the case it
 * was built for, so shotgun does not invent a second coordination channel. When they have all settled,
 * the lead reconciles the combined tree and ONE QA pass reviews the whole thing.
 *
 * Two rules that decide whether this is safe or reckless:
 *
 * 1. **Overlapping ownership is not a warning, it is a rejection.** Two agents editing one file in one
 *    working tree silently lose each other's work — there is no merge step to catch it, because there is
 *    no second checkout. So a decomposition whose file sets intersect is refused and the task degrades
 *    to a single agent. Degrading is always available and always correct; splitting unsafely is not.
 *
 * 2. **Degrading is a first-class outcome, not a failure.** Plenty of real tasks cannot be split — a
 *    focused bug fix, a single-file change, anything sequential. The planner is asked to say so, and
 *    "no" produces an ordinary, complete, single-agent task rather than a forced three-way split that
 *    spends triple the quota to collide with itself.
 */

import type { ShotgunAssignment } from "../types.js";

// ShotgunAssignment is declared in types.ts (it is persisted on the thread row and mirrored to the
// client), and re-exported here so callers of this module get the whole vocabulary from one import.
export type { ShotgunAssignment } from "../types.js";

/** Bounds on a shotgun request. Two is the minimum that means anything; the ceiling keeps one task from
 *  monopolising the box (each collaborator is a full agent) and keeps the integration pass tractable —
 *  reconciling six parallel change sets by hand is already the practical limit of one review. */
export const MIN_AGENTS = 2;
export const MAX_AGENTS = 6;

/** The planner's decomposition verdict. */
export interface ShotgunPlan {
  parallelizable: boolean;
  reason: string;
  assignments?: ShotgunAssignment[];
}

export type DecompositionResult =
  | { ok: true; assignments: ShotgunAssignment[] }
  | { ok: false; reason: string };

/** Structured-output schema for the decomposition call. `parallelizable` and `reason` are required
 *  because they are control flow: an absent verdict must read as "cannot split", never as consent. */
export const SHOTGUN_SCHEMA = {
  type: "object",
  properties: {
    parallelizable: {
      type: "boolean",
      description:
        "True ONLY if this task genuinely splits into independent work packages that touch NON-OVERLAPPING files. False for anything sequential, single-file, or where the packages would need to edit the same files.",
    },
    reason: {
      type: "string",
      description: "One or two sentences: why this can be split the way you propose, or why it cannot.",
    },
    assignments: {
      type: "array",
      description: "The work packages, when parallelizable. Each is one collaborator's complete, standalone brief.",
      items: {
        type: "object",
        properties: {
          title: { type: "string", description: "Short board-lane title for this package." },
          objective: {
            type: "string",
            description:
              "This collaborator's complete brief — what to build and what 'done' means for this package alone. Written to stand on its own; the collaborator does not see the other packages' details.",
          },
          files: {
            type: "array",
            description:
              "The files or directories this package EXCLUSIVELY owns, repo-relative. Must not overlap any other package's list — an overlap makes the split unsafe and it will be rejected.",
            items: { type: "string" },
          },
        },
        required: ["title", "objective", "files"],
      },
    },
  },
  required: ["parallelizable", "reason"],
} as const;

/** Clamp a requested collaborator count into the supported range. */
export function clampAgentCount(n: number): number {
  if (!Number.isFinite(n)) return MIN_AGENTS;
  return Math.min(MAX_AGENTS, Math.max(MIN_AGENTS, Math.round(n)));
}

/** Whether a thread's agent count asks for parallel work at all. */
export function isShotgun(agentCount: number | null | undefined): boolean {
  return agentCount != null && agentCount >= MIN_AGENTS;
}

/** Normalize an owned path for comparison: forward slashes, lowercased, no leading `./`, no trailing
 *  separator. Mirrors `normalizeWorkspace`'s intent — Windows and POSIX spellings of one path must
 *  compare equal, or the overlap check silently passes on a real collision. */
export function normalizeOwnedPath(p: string): string {
  return p
    .trim()
    .replace(/\\/g, "/")
    .replace(/^\.\//, "")
    .replace(/\/+$/, "")
    .toLowerCase();
}

/** Whether two owned paths collide. Not just equality: a directory owns everything beneath it, so
 *  `src/api` and `src/api/routes.ts` are the same claim and must be caught. The `/` boundary check
 *  keeps `src/apidocs` from being read as living inside `src/api`. */
export function pathsCollide(a: string, b: string): boolean {
  const x = normalizeOwnedPath(a);
  const y = normalizeOwnedPath(b);
  if (!x || !y) return false;
  if (x === y) return true;
  return x.startsWith(y + "/") || y.startsWith(x + "/");
}

/** The first colliding pair between two assignments, or null when their ownership is disjoint. */
export function findCollision(a: ShotgunAssignment, b: ShotgunAssignment): [string, string] | null {
  for (const x of a.files) {
    for (const y of b.files) {
      if (pathsCollide(x, y)) return [x, y];
    }
  }
  return null;
}

/**
 * Validate a decomposition before any collaborator is spawned. Every rejection returns an owner-facing
 * reason, because a refusal here is reported as the task degrading to a single agent and the owner is
 * entitled to know why it did.
 *
 * Trimming to `agentCount` happens LAST and deliberately keeps the first N: the planner is asked to
 * order packages by importance, so a request for 3 against a 5-way split keeps the three that matter
 * rather than refusing. The trimmed set is re-checked for size, never for overlap — a subset of a
 * pairwise-disjoint set is still disjoint.
 */
export function validateDecomposition(plan: ShotgunPlan | null | undefined, agentCount: number): DecompositionResult {
  if (!plan) return { ok: false, reason: "the decomposition step produced no usable answer" };
  if (!plan.parallelizable) {
    return { ok: false, reason: plan.reason?.trim() || "the planner judged this task not safely splittable" };
  }
  const assignments = (plan.assignments ?? [])
    .map((a) => ({
      title: (a?.title ?? "").trim(),
      objective: (a?.objective ?? "").trim(),
      files: (a?.files ?? []).map((f) => (f ?? "").trim()).filter(Boolean),
    }))
    .filter((a) => a.title && a.objective);
  if (assignments.length < MIN_AGENTS) {
    return { ok: false, reason: `the decomposition returned only ${assignments.length} usable work package(s), so there is nothing to parallelize` };
  }
  const noFiles = assignments.find((a) => a.files.length === 0);
  if (noFiles) {
    // Without a declared file set there is no ownership contract, and ownership is the ONLY thing
    // keeping two agents from silently overwriting each other in this shared tree.
    return { ok: false, reason: `work package "${noFiles.title}" declares no owned files, so its edits could not be kept clear of the others` };
  }
  for (let i = 0; i < assignments.length; i++) {
    for (let j = i + 1; j < assignments.length; j++) {
      const clash = findCollision(assignments[i]!, assignments[j]!);
      if (clash) {
        return {
          ok: false,
          reason: `work packages "${assignments[i]!.title}" and "${assignments[j]!.title}" both claim ${clash[0] === clash[1] ? `\`${clash[0]}\`` : `\`${clash[0]}\` and \`${clash[1]}\``}, so running them together would have them overwrite each other in the shared working tree`,
        };
      }
    }
  }
  return { ok: true, assignments: assignments.slice(0, agentCount) };
}

/** How one collaborator's run turned out, for the lead's integration pass. */
export interface CollaboratorOutcome {
  title: string;
  state: string;
  files: string[];
  /** Why it didn't finish, when it didn't. */
  error?: string | null;
}

/** Terminal states a collaborator can settle in — the barrier waits for all of these. `review` counts:
 *  it means that collaborator stopped and wants a human, which is a finished run from the lead's point
 *  of view, and the integration pass is told the share is incomplete. */
export const COLLABORATOR_TERMINAL: ReadonlySet<string> = new Set(["done", "review", "failed", "cancelled", "closed"]);

/** Whether a collaborator has stopped, whatever the verdict. */
export function collaboratorSettled(state: string): boolean {
  return COLLABORATOR_TERMINAL.has(state);
}

// ---- the text the agents see ---------------------------------------------------------------------

/** The ownership contract prepended to every collaborator's brief — and to the lead's own share, which
 *  is under exactly the same constraint. This is the single place the rule is worded, so the lead and
 *  the collaborators cannot be told different things. */
export function ownershipBlock(mine: ShotgunAssignment, peers: { title: string; files: string[]; name?: string }[]): string {
  const peerLines = peers.length
    ? peers.map((p) => `- ${p.name ? `${p.name} — ` : ""}"${p.title}" owns: ${p.files.join(", ")}`).join("\n")
    : "- (none yet — the other collaborators are still starting)";
  return [
    "## 🔀 You are one of several agents working this repository RIGHT NOW",
    "",
    "This task was split so it could be worked in parallel. You share ONE working tree on ONE branch with the others — there are no separate checkouts, so nothing merges your changes for you and an edit outside your share silently overwrites a teammate's work.",
    "",
    `**Your share — these paths are YOURS, and only yours:**\n${mine.files.map((f) => `- ${f}`).join("\n")}`,
    "",
    `**Owned by other agents — do NOT edit these, even to fix something obviously wrong in them:**\n${peerLines}`,
    "",
    "Rules for working in a shared tree:",
    "- Edit ONLY inside your share. If your work genuinely requires a change outside it, say so in the office chat (`chat_post(scope:\"team\")`) and let the owner of that path make it — do not reach in.",
    "- Stage your OWN files by path when you commit (`git add <your paths>`), never `git add -A` or `git add .` — the tree contains teammates' uncommitted work and a broad add commits it under your message.",
    "- Re-read `git status`/`git diff` before every commit and confirm the hunks are yours.",
    "- Coordinate in the office: `office_look` to see who is here, `chat_read(scope:\"team\")` for what they have said, `chat_post(scope:\"team\")` to flag anything that affects them (a shared interface you changed, a build you broke, a dependency you added).",
    "- Do NOT run the whole task's final integration, and do NOT declare the overall task finished — a lead agent reconciles everything and a QA pass reviews the combined result. Finish YOUR share properly and stop.",
  ].join("\n");
}

/** The lead's reconcile directive, once every collaborator has settled. */
export function integrationBrief(outcomes: CollaboratorOutcome[]): string {
  const line = (o: CollaboratorOutcome): string => {
    const verdict = o.state === "done" ? "finished" : o.state === "review" ? "STOPPED and asked for a human" : `ended as ${o.state}`;
    return `- "${o.title}" (${o.files.join(", ")}) — ${verdict}${o.error ? `: ${o.error}` : ""}`;
  };
  const incomplete = outcomes.filter((o) => o.state !== "done");
  return [
    "## 🔗 Integration pass — the parallel work is in, reconcile it",
    "",
    "Every other agent on this task has stopped. Their work is already in this working tree and/or committed on this branch:",
    outcomes.map(line).join("\n"),
    "",
    "Your job now is to make the COMBINED result correct and coherent — this is the step that turns several parallel changes into one deliverable:",
    "1. Read the full picture: `git status` and `git diff` (plus `git log` for what has been committed) across ALL of the paths above, not just your own.",
    "2. Reconcile the seams — the places two shares meet. Mismatched interfaces, duplicated helpers, a type one agent changed and another still uses the old shape of, imports that no longer resolve.",
    "3. Make it BUILD and make the tests PASS for the whole tree. This is not optional and it is the main reason this pass exists.",
    "4. Finish anything left unfinished below, or — if you cannot safely complete it — say plainly what remains and why, so the review has the truth rather than a guess.",
    incomplete.length
      ? `\n⚠ ${incomplete.length} share(s) did NOT finish cleanly: ${incomplete.map((o) => `"${o.title}"`).join(", ")}. Check what they actually left behind (a partial edit, a broken build, nothing at all) and deal with it — do not assume their objective was met.`
      : "\nAll shares finished cleanly, so expect the seams — not the individual objectives — to be where the problems are.",
    "",
    "Commit the reconciliation as its own change, then hand off: a QA agent reviews the combined result.",
  ].join("\n");
}

/** The kickoff for the decomposition call itself. */
export function decompositionKickoff(brief: string, planSummary: string | undefined, agentCount: number): string {
  return [
    `# Can this task be split across ${agentCount} agents working AT THE SAME TIME in ONE shared working tree?`,
    "",
    "## The task",
    brief,
    planSummary ? `\n## The plan already made for it\n${planSummary}` : "",
    "",
    "## What you are deciding",
    `Split this into AT MOST ${agentCount} work packages that can be built simultaneously, by different agents, in the SAME checkout on the SAME branch.`,
    "",
    "The one hard constraint: **no two packages may touch the same file.** There are no separate checkouts and nothing merges their changes — two agents editing one file silently destroy each other's work. So the file lists you return must be strictly non-overlapping, and a directory counts as everything inside it.",
    "",
    "Answer `parallelizable: false` — which is a perfectly good answer, and the RIGHT one more often than not — when:",
    "- the work is sequential (later steps need the earlier ones' output);",
    "- it is concentrated in one file or one tight cluster of files;",
    "- you cannot honestly predict which files each package will need to touch;",
    "- the packages would be so small that coordinating them costs more than doing the work.",
    "",
    "Only answer `true` when the packages are genuinely independent, each is substantial enough to be worth its own agent, and you can name each one's owned files with confidence. Order them most-important first — if fewer agents are available, the leading packages are the ones that will run.",
    "",
    "Each `objective` is a COMPLETE standalone brief: the agent receiving it sees your text and the shared goal, not the other packages' details. Include what to build and what 'done' means for that package alone.",
  ]
    .filter(Boolean)
    .join("\n");
}
