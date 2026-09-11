import { basename, isAbsolute, relative } from "node:path";
import type {
  CoworkCommit,
  CoworkMessage,
  CoworkSession,
  CoworkSessionSummary,
  CoworkTouchedFile,
  CoworkTurn,
} from "../types.js";

/** What a Co-work conversation actually did, read back off its own durable transcript.
 *
 * Deterministic on purpose. This summary is what the owner reads when a session was timeboxed or
 * abandoned (exactly the moment capacity is short), and it is what a promoted task is briefed from, so
 * it must never depend on a model turn that can be capped, refused, or invent a commit that was never
 * made. Everything here is replayed from tool calls and their results.
 */

/** Tool inputs that name a file the agent WROTE. A read is not work the owner needs summarized. */
const WRITE_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit", "str_replace_editor", "apply_patch"]);
const PATH_KEYS = ["file_path", "filePath", "path", "notebook_path", "notebookPath"];

/** `[master 1a2b3c4] subject`: git's own commit receipt. The ref part is matched loosely on purpose so
 *  the `[main (root-commit) 1a2b3c4]` and `[detached HEAD 1a2b3c4]` forms are recognized too; a receipt
 *  this misses is a commit the owner is told never happened. */
const COMMIT_LINE = /^\[(.+?)\s+([0-9a-f]{7,40})\]\s*(.*)$/gim;

const MAX_DIRECTIONS = 12;
const MAX_OUTCOMES = 6;
const MAX_FILES = 40;
const MAX_COMMITS = 20;
const DIRECTION_CHARS = 400;
const OUTCOME_CHARS = 1_200;

interface ToolCallRecord {
  name: string;
  input: Record<string, unknown>;
}

function toolCall(message: CoworkMessage): ToolCallRecord | null {
  if (message.kind !== "tool" || !message.meta || typeof message.meta !== "object") return null;
  const meta = message.meta as Record<string, unknown>;
  const name = typeof meta.name === "string" ? meta.name : message.content;
  const input = meta.input && typeof meta.input === "object" ? (meta.input as Record<string, unknown>) : {};
  return name ? { name, input } : null;
}

/** Workspace-relative wherever possible: an owner reading a summary wants `web/src/App.tsx`, not a
 *  hundred-character absolute path repeated forty times. A path outside the workspace stays absolute
 *  rather than growing a `../../` prefix that says less than the original did. */
function displayPath(raw: string, workspace: string): string | null {
  const value = raw.trim().replace(/["']/g, "");
  if (!value) return null;
  if (!isAbsolute(value)) return value.split("\\").join("/");
  const rel = relative(workspace, value);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) return value;
  return rel.split("\\").join("/");
}

function writtenPath(call: ToolCallRecord, workspace: string): string | null {
  if (!WRITE_TOOLS.has(call.name)) return null;
  for (const key of PATH_KEYS) {
    const value = call.input[key];
    if (typeof value === "string" && value.trim()) return displayPath(value, workspace);
  }
  return null;
}

/** The files the conversation wrote, busiest first: where the work actually landed. */
export function touchedFiles(messages: CoworkMessage[], workspace: string): CoworkTouchedFile[] {
  const counts = new Map<string, number>();
  for (const message of messages) {
    const call = toolCall(message);
    const path = call && writtenPath(call, workspace);
    if (path) counts.set(path, (counts.get(path) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([path, writes]) => ({ path, writes }))
    .sort((a, b) => b.writes - a.writes || a.path.localeCompare(b.path))
    .slice(0, MAX_FILES);
}

/** Commits the conversation made, read from git's own receipt in the tool RESULT, never from the
 *  command that was attempted. A `git commit` that failed a pre-commit hook printed no receipt, and
 *  reporting it as landed is the one error this trail must not make. */
export function commitsMade(messages: CoworkMessage[]): CoworkCommit[] {
  const out: CoworkCommit[] = [];
  const seen = new Set<string>();
  for (const message of messages) {
    if (message.kind !== "tool_result") continue;
    const meta = message.meta && typeof message.meta === "object" ? (message.meta as Record<string, unknown>) : null;
    if (meta?.isError === true) continue;
    for (const match of message.content.matchAll(COMMIT_LINE)) {
      const sha = match[2]!.slice(0, 10);
      const subject = (match[3] ?? "").trim();
      if (!subject || seen.has(sha)) continue;
      seen.add(sha);
      out.push({ sha, subject });
    }
  }
  return out.slice(-MAX_COMMITS);
}

function clip(text: string, max: number): string {
  const clean = text.trim();
  return clean.length <= max ? clean : `${clean.slice(0, max).trimEnd()}...`;
}

/** The owner's own instructions, in order. Steering is included, because a mid-turn correction is
 *  often where the real decision was made. Undelivered directions are skipped: the agent never saw
 *  them, so nothing in the workspace can reflect them. */
function ownerDirections(messages: CoworkMessage[]): string[] {
  const out: string[] = [];
  for (const message of messages) {
    if (message.role !== "user" || message.kind !== "text") continue;
    const meta = message.meta && typeof message.meta === "object" ? (message.meta as Record<string, unknown>) : null;
    if (meta && typeof meta.steeringMode === "string" && (meta.delivery === "failed" || meta.delivery === "pending")) continue;
    const text = clip(message.content, DIRECTION_CHARS);
    if (text) out.push(text);
  }
  return out.slice(-MAX_DIRECTIONS);
}

/** One closing statement per turn the Co-worker actually finished talking in. Intermediate streamed
 *  parts of the same turn are superseded by its last block, which is where a Co-worker sums up. */
function turnOutcomes(messages: CoworkMessage[]): string[] {
  const byTurn = new Map<string, string>();
  const order: string[] = [];
  for (const message of messages) {
    if (message.role !== "coworker" || message.kind !== "text" || message.partial) continue;
    const key = message.turnId ?? message.id;
    if (!byTurn.has(key)) order.push(key);
    const text = message.content.trim();
    if (text) byTurn.set(key, text);
  }
  return order
    .map((key) => byTurn.get(key))
    .filter((text): text is string => !!text)
    .slice(-MAX_OUTCOMES)
    .map((text) => clip(text, OUTCOME_CHARS));
}

function totalCost(turns: CoworkTurn[]): number | null {
  const known = turns.filter((turn) => turn.costUsd != null);
  return known.length ? known.reduce((sum, turn) => sum + (turn.costUsd ?? 0), 0) : null;
}

/** The reason the session is sitting where it is, null when its last turn simply finished. That
 *  distinction is the whole point of the trail: `done` needs no explanation, `timeboxed` does. */
function endedBecause(turns: CoworkTurn[]): CoworkSessionSummary["endedBecause"] {
  const last = turns[turns.length - 1];
  if (!last || last.state === "done" || last.state === "running") return null;
  return last.state;
}

export function summarizeCoworkSession(input: {
  session: CoworkSession;
  turns: CoworkTurn[];
  messages: CoworkMessage[];
}): CoworkSessionSummary {
  const { session, turns, messages } = input;
  const toolCalls = messages.filter((message) => message.kind === "tool").length;
  const endedAt = turns.reduce((latest, turn) => Math.max(latest, turn.endedAt ?? turn.startedAt), session.updatedAt);
  return {
    sessionId: session.id,
    name: session.name,
    workspace: session.workspace,
    directions: ownerDirections(messages),
    outcomes: turnOutcomes(messages),
    files: touchedFiles(messages, session.workspace),
    commits: commitsMade(messages),
    turns: turns.length,
    toolCalls,
    costUsd: totalCost(turns),
    startedAt: session.createdAt,
    endedAt,
    endedBecause: endedBecause(turns),
  };
}

function duration(ms: number): string {
  const minutes = Math.max(0, Math.round(ms / 60_000));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

const ENDED_REASON: Record<string, string> = {
  timeboxed: "the last turn reached its hand-back boundary",
  cancelled: "the owner stopped the last turn",
  error: "the last turn ended with an error",
  interrupted: "a server restart interrupted the last turn",
};

function bulletList(items: string[]): string[] {
  return items.map((item) => `- ${item.split("\n").join("\n  ")}`);
}

/** The owner-facing trail. Markdown, because it is rendered in the transcript and in the summary
 *  dialog by the same renderer the Co-worker's own replies use. */
export function renderCoworkSummary(summary: CoworkSessionSummary): string {
  const lines: string[] = [`**Session summary: ${summary.name}**`, ""];
  const reason = summary.endedBecause ? ENDED_REASON[summary.endedBecause] : null;
  const facts = [
    `${summary.turns} turn${summary.turns === 1 ? "" : "s"}`,
    `${summary.toolCalls} tool call${summary.toolCalls === 1 ? "" : "s"}`,
    `${duration(summary.endedAt - summary.startedAt)} elapsed`,
  ];
  if (summary.costUsd != null) facts.push(`$${summary.costUsd.toFixed(2)}`);
  lines.push(`${basename(summary.workspace) || summary.workspace} · ${facts.join(" · ")}${reason ? ` · ${reason}` : ""}`, "");

  lines.push("**What was asked**");
  lines.push(...(summary.directions.length ? bulletList(summary.directions) : ["- Nothing was sent in this session."]));
  lines.push("");

  if (summary.outcomes.length) {
    lines.push("**What the Co-worker reported**", "");
    lines.push(summary.outcomes[summary.outcomes.length - 1]!, "");
  }

  lines.push("**Files changed**");
  lines.push(...(summary.files.length
    ? bulletList(summary.files.map((file) => `\`${file.path}\`${file.writes > 1 ? ` (${file.writes} edits)` : ""}`))
    : ["- No file writes were recorded in this conversation."]));
  lines.push("");

  lines.push("**Commits**");
  lines.push(...(summary.commits.length
    ? bulletList(summary.commits.map((commit) => `\`${commit.sha}\` ${commit.subject}`))
    : ["- No commits were made from this conversation."]));
  return lines.join("\n");
}

/** The brief a promoted task starts from. It states the source explicitly, because the receiving
 *  implementor must treat the exploration as CONTEXT to verify, not as a step it can skip. */
export function renderCoworkTaskBrief(summary: CoworkSessionSummary, objective: string): string {
  const lines: string[] = [
    objective.trim(),
    "",
    "---",
    "",
    `Promoted from the Co-work session **${summary.name}** in \`${summary.workspace}\`. The exploration`,
    "below already happened in this same workspace. Treat it as context to verify, not as work already",
    "delivered: re-check the current tree before relying on any of it.",
    "",
    "**What the owner asked during that session**",
  ];
  lines.push(...(summary.directions.length ? bulletList(summary.directions) : ["- (nothing recorded)"]));
  if (summary.outcomes.length) {
    lines.push("", "**Where the exploration got to**", "", summary.outcomes[summary.outcomes.length - 1]!);
  }
  lines.push("", "**Files that session touched**");
  lines.push(...(summary.files.length
    ? bulletList(summary.files.map((file) => `\`${file.path}\``))
    : ["- (none recorded)"]));
  lines.push("", "**Commits it made**");
  lines.push(...(summary.commits.length
    ? bulletList(summary.commits.map((commit) => `\`${commit.sha}\` ${commit.subject}`))
    : ["- (none)"]));
  return lines.join("\n");
}

/** A task title from the conversation: the owner's first instruction is what they came here to do. */
export function coworkTaskTitle(summary: CoworkSessionSummary): string {
  const first = summary.directions[0]?.split("\n")[0]?.trim();
  const source = first && first.length > 3 ? first : summary.name;
  return clip(source, 90).replace(/[.\s]+$/, "") || summary.name;
}
