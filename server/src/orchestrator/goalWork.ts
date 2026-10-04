import { z } from "zod";
import { GOAL_WORK_ITEM_STATUSES, GOAL_WORK_ITEMS_MAX, type GoalWorkItem, type GoalWorkItemStatus } from "../types.js";

/**
 * A goal's milestones: the meaningful work items its step agents report inside a long-running step, so the
 * owner sees what is being worked on, what is finished, what remains and what waits on them. The agent's
 * report is the only source: nothing here infers completion from time, a session ending or a command.
 * Items are keyed per goal, so a retry, a resumed session or the next step updates the same row.
 *
 * Pure: validation, the merge into the stored rows, and the text the prompts and the tool reply carry.
 * `GoalRunner.recordWork` resolves the step, writes and broadcasts.
 */

export const GOAL_WORK_REPORT_MAX_ITEMS = 40;
// The owner skims these: a title is a few words, a note one short sentence. Longer text is clipped on write.
const TITLE_MAX = 60;
const NOTE_MAX = 200;
const DETAIL_MAX = 200;
const KEY_MAX = 40;

const OWNER_STATUSES: ReadonlySet<GoalWorkItemStatus> = new Set(["blocked", "awaiting_approval"]);

/** One item of a report: the MCP tool's input and the CLI `GOAL_PROGRESS:` line share it. */
export const goalWorkItemShape = z.object({
  id: z
    .string()
    .optional()
    .describe('A short stable id for this milestone, e.g. "sync-queue". Reuse it in every later report about the same milestone; omitted, the title is the id.'),
  title: z.string().describe(`What the milestone achieves in 3-6 plain words, e.g. "Offline sync queue" (clipped at ${TITLE_MAX} characters).`),
  status: z.enum(GOAL_WORK_ITEM_STATUSES as [GoalWorkItemStatus, ...GoalWorkItemStatus[]]).describe(
    "planned | working | blocked | awaiting_approval | done | dropped (taken out of scope).",
  ),
  note: z.string().optional().describe(`One short sentence: the result, or what is left on it (clipped at ${NOTE_MAX} characters).`),
  blocker: z.string().optional().describe("Required for blocked and awaiting_approval, one short sentence: what it waits on, or whose approval it needs."),
  verified: z.boolean().optional().describe("Only with done: true when you verified the result, not just finished the work."),
  verification: z.string().optional().describe("With verified, a few words: how you checked it (the test or the evidence)."),
});

export const goalWorkReportShape = { items: z.array(goalWorkItemShape).min(1).max(GOAL_WORK_REPORT_MAX_ITEMS) };
const reportSchema = z.object(goalWorkReportShape);

export type GoalWorkReportItem = z.infer<typeof goalWorkItemShape>;
export type GoalWorkRow = Omit<GoalWorkItem, "id" | "goalId" | "position" | "createdAt">;

export type GoalWorkMerge = { ok: true; rows: GoalWorkRow[]; added: number; updated: number } | { ok: false; error: string };

/** A milestone key: lower-case words joined by hyphens. */
export function workItemKey(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, KEY_MAX)
    .replace(/-+$/, "");
}

const clipText = (s: string | undefined, n: number): string | null | undefined => {
  if (s === undefined) return undefined;
  const t = s.trim();
  if (!t) return null;
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

/** Parses a report from either channel; the error says what to fix, since the agent reads it. */
export function parseGoalWorkReport(raw: unknown): { ok: true; items: GoalWorkReportItem[] } | { ok: false; error: string } {
  const parsed = reportSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return { ok: false, error: `the report must be {"items":[{"id","title","status",...}]} with 1-${GOAL_WORK_REPORT_MAX_ITEMS} items (${issue ? `${issue.path.join(".") || "report"}: ${issue.message}` : "invalid"})` };
  }
  return { ok: true, items: parsed.data.items };
}

/**
 * Merges a report into a goal's stored milestones. All or nothing: one invalid item refuses the report.
 * An item matches the stored row with the same key; with no `id` given, also the row with the same title,
 * so a retry that forgets the id does not duplicate it. Omitted text fields keep their stored value.
 */
export function mergeGoalWork(existing: GoalWorkItem[], report: GoalWorkReportItem[], threadId: string, now: number): GoalWorkMerge {
  const byKey = new Map(existing.map((i) => [i.key, i]));
  const byTitle = new Map(existing.map((i) => [workItemKey(i.title), i]));
  const rows = new Map<string, GoalWorkRow>();
  let added = 0;
  for (const [index, item] of report.entries()) {
    const title = clipText(item.title, TITLE_MAX);
    const where = `item ${index + 1}${title ? ` ("${title}")` : ""}`;
    if (!title) return { ok: false, error: `${where} has no title` };
    const key = workItemKey(item.id?.trim() || title);
    if (!key) return { ok: false, error: `${where} needs an id or title with letters or digits` };
    const prior = rows.get(key) ?? byKey.get(key) ?? (item.id?.trim() ? undefined : byTitle.get(workItemKey(title)));
    const blocker = clipText(item.blocker, DETAIL_MAX);
    if (OWNER_STATUSES.has(item.status) && !(blocker ?? (prior && OWNER_STATUSES.has(prior.status) ? prior.blocker : null))) {
      return { ok: false, error: `${where} is ${item.status} but says nothing in \`blocker\` about what it waits on` };
    }
    if (!prior) added++;
    const row = nextRow(prior, item, { key: prior?.key ?? key, title, blocker, threadId, now });
    rows.set(row.key, row);
  }
  if (existing.length + added > GOAL_WORK_ITEMS_MAX) {
    return { ok: false, error: `a goal keeps at most ${GOAL_WORK_ITEMS_MAX} milestones; report fewer, broader ones, or reuse the recorded ids` };
  }
  return { ok: true, rows: [...rows.values()], added, updated: rows.size - added };
}

function nextRow(
  prior: GoalWorkItem | GoalWorkRow | undefined,
  item: GoalWorkReportItem,
  at: { key: string; title: string; blocker: string | null | undefined; threadId: string; now: number },
): GoalWorkRow {
  const done = item.status === "done";
  const wasDone = prior?.status === "done";
  const keep = <T>(next: T | undefined, before: T | null | undefined): T | null => (next !== undefined ? next : (before ?? null));
  const verified = done ? (item.verified ?? (wasDone ? prior!.verified : false)) : false;
  return {
    key: at.key,
    title: at.title,
    status: item.status,
    note: keep(clipText(item.note, NOTE_MAX), prior?.note),
    blocker: OWNER_STATUSES.has(item.status) ? keep(at.blocker, prior?.blocker) : null,
    verified,
    verification: verified ? keep(clipText(item.verification, DETAIL_MAX), wasDone ? prior?.verification : null) : null,
    threadId: at.threadId,
    updatedAt: at.now,
    startedAt: prior?.startedAt ?? (item.status === "working" ? at.now : null),
    completedAt: done ? (wasDone ? (prior!.completedAt ?? at.now) : at.now) : null,
  };
}

const STATUS_WORD: Record<GoalWorkItemStatus, string> = {
  planned: "planned",
  working: "working",
  blocked: "blocked",
  awaiting_approval: "awaiting approval",
  done: "done",
  dropped: "dropped",
};

function itemLine(i: Pick<GoalWorkItem, "key" | "title" | "status" | "verified">): string {
  const verified = i.status === "done" && i.verified ? ", verified" : "";
  return `- ${i.key} [${STATUS_WORD[i.status]}${verified}]: ${i.title}`;
}

/** The milestones as the tool reply and the prompts list them, open ones first, clipped to `maxChars`. */
export function goalWorkList(items: GoalWorkItem[], maxChars: number): string {
  const live = items.filter((i) => i.status !== "dropped");
  const open = live.filter((i) => i.status !== "done");
  const done = live.filter((i) => i.status === "done");
  const lines: string[] = [];
  let used = 0;
  let omitted = 0;
  for (const i of [...open, ...done]) {
    const line = itemLine(i);
    if (used + line.length + 1 > maxChars) {
      omitted++;
      continue;
    }
    lines.push(line);
    used += line.length + 1;
  }
  if (omitted) lines.push(`- (${omitted} more not shown)`);
  return lines.join("\n");
}

/** The rule every step brief and continuation carries, so agents keep the owner's Goals view current. */
export const GOAL_PROGRESS_RULE =
  "PROGRESS REPORTING: keep the owner's Goals view current with the `report_goal_progress` tool (on a CLI backend without it, write one standalone line `GOAL_PROGRESS: {\"items\":[...]}` with the same JSON). Report the meaningful milestones of the WHOLE objective, not commands or small edits: a handful of them, each with a stable short `id`, a `title` of 3-6 plain words and a `status` (planned, working, blocked, awaiting_approval, done or dropped), and at most one short sentence of `note`. The owner skims this list. Report your plan when you start, then again whenever a milestone starts, finishes, gets blocked or needs the owner, adding new ones as you discover them. Keep the one you are on `working`. Mark `done` only when it is finished, and add `verified: true` with how you checked it only when you verified the result. An item that needs the owner's approval stays `awaiting_approval` until they have explicitly approved it. Reuse the recorded ids below instead of adding duplicates.";

/** The recorded milestones block for a step brief or a continuation, or "" when there are none. */
export function goalWorkBlock(items: GoalWorkItem[], maxChars: number): string {
  if (!items.some((i) => i.status !== "dropped")) return "";
  return `Milestones recorded so far (id [status]: title):\n${goalWorkList(items, maxChars)}`;
}
