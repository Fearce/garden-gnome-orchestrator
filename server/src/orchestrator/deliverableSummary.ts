// The "Summarize done task deliverables" setting: when a task settles to done or review, one Sonnet
// call condenses the implementor's final completion report (plus the task's surfaced files and why it
// is waiting, if it is) into the short owner-facing note shown as the LAST card of the task feed.
//
// Grounded on purpose: the model sees only the brief, the durable memo report and the deliverable list,
// never the transcript, so QA chatter and the self-improvement round cannot leak into it. Best-effort
// like the other ancillary calls (titles, voice lines): any failure returns null and the console simply
// keeps showing the implementor's own report.

import { createHash } from "node:crypto";
import type { DeliverableSummary, Finding, ImplementationMemo, Thread } from "../types.js";
import { disputesTheWork } from "./titleFromInjection.js";

export const DELIVERABLE_SUMMARY_MODEL = process.env.DELIVERABLE_SUMMARY_MODEL || "claude-sonnet-5";
const MAX_OUTPUT_TOKENS = 1_200;
const TIMEOUT_MS = 90_000;
const BRIEF_CHARS = 4_000;
const REPORT_CHARS = 24_000;
const REASON_CHARS = 1_500;
const MAX_DELIVERABLES = 30;

type Block = { type?: string; text?: string };

export interface DeliverableSummaryInput {
  title: string;
  brief: string;
  state: DeliverableSummary["taskState"];
  /** Why a review-state task is waiting on the owner; ignored for done. */
  reviewReason?: string | null;
  /** Deploy step the owner still owes, for a done task that handed off a manual deployment. */
  pendingDeployment?: string | null;
  report: string;
  deliverables: Array<{ label: string; path: string; description?: string | null }>;
}

const INSTRUCTIONS = `You write the closing note an owner reads when they open a finished task on their work board. The implementor's own final report is below; it is accurate but long and mixed with process detail. Condense it into what the owner needs.

Rules:
- Use ONLY facts stated in the material below. Never invent a file, commit, result or next step. If the report does not say something, leave it out.
- Open with one plain sentence stating the outcome.
- Then "**Deliverables**": one bullet per surfaced file (label, then its path in backticks, then a few words on what it is). If none were surfaced, name the concrete things that were produced instead (commits, deployed services, answers) or omit the section.
- Then "**What changed**": at most five short bullets.
- Then "**Verification**": one line on what was actually checked and the result.
- Only when the task is waiting on the owner or something remains: "**Needs you**", with the specific action.
- Markdown, no headings (#), no preamble, no sign-off, under 250 words. Write to the owner directly; never comment on the report itself.`;

function clip(text: string, max: number): string {
  const clean = text.trim();
  return clean.length <= max ? clean : `${clean.slice(0, max).trimEnd()}\n…(truncated)`;
}

export function buildDeliverableSummaryPrompt(input: DeliverableSummaryInput): string {
  const files = input.deliverables.slice(0, MAX_DELIVERABLES);
  const fileLines = files.length
    ? files.map((file) => `- ${file.label} — ${file.path}${file.description ? ` — ${file.description}` : ""}`).join("\n")
    : "(none surfaced)";
  const status =
    input.state === "done"
      ? `Done — accepted.${input.pendingDeployment ? ` A manual deployment is still owed by the owner: ${clip(input.pendingDeployment, REASON_CHARS)}` : ""}`
      : `In review — waiting on the owner.${input.reviewReason?.trim() ? ` Reason: ${clip(input.reviewReason, REASON_CHARS)}` : ""}`;
  return [
    INSTRUCTIONS,
    `## Task\n${input.title.trim()}`,
    `## Owner's brief\n${clip(input.brief, BRIEF_CHARS) || "(none recorded)"}`,
    `## Task status\n${status}`,
    `## Surfaced deliverable files\n${fileLines}`,
    `## Implementor's final report\n${clip(input.report, REPORT_CHARS)}`,
  ].join("\n\n");
}

/** Strip a heading-style preamble a model sometimes adds despite instructions; reject a reply that is
 *  empty or argues with the task instead of summarizing it. */
export function cleanDeliverableSummary(text: string): string | null {
  const cleaned = text
    .trim()
    .replace(/^#{1,6}\s*(summary|task summary|deliverables summary)\s*\n+/i, "")
    .trim();
  if (!cleaned || disputesTheWork(cleaned.split("\n")[0] ?? "")) return null;
  return cleaned;
}

async function ask(prompt: string, token: string): Promise<string | null> {
  const body = JSON.stringify({ model: DELIVERABLE_SUMMARY_MODEL, max_tokens: MAX_OUTPUT_TOKENS, messages: [{ role: "user", content: prompt }] });
  for (let attempt = 0; attempt < 2; attempt++) {
    let res: Response;
    try {
      res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "anthropic-beta": "oauth-2025-04-20",
          "anthropic-version": "2023-06-01",
          "content-type": "application/json",
          "user-agent": "claude-cli/2.0.0",
        },
        body,
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch {
      continue; // network blip / timeout — retry once, then give up
    }
    if (res.status === 200) {
      let j: { content?: Block[] };
      try {
        j = (await res.json()) as { content?: Block[] };
      } catch {
        return null;
      }
      const text = Array.isArray(j.content)
        ? j.content
            .filter((b) => b?.type === "text")
            .map((b) => b.text ?? "")
            .join("\n")
            .trim()
        : "";
      return text || null;
    }
    await res.text().catch(() => ""); // drain to free the socket
    if (res.status !== 429 && res.status < 500) return null; // 4xx (auth etc.) — retrying won't help
  }
  return null;
}

/** One Sonnet summary, or null on any failure (no token, network, non-200, unusable reply). Never throws. */
export async function summarizeDeliverables(input: DeliverableSummaryInput, token: string | undefined): Promise<string | null> {
  if (!token || !input.report.trim()) return null;
  const reply = await ask(buildDeliverableSummaryPrompt(input), token).catch(() => null);
  return reply ? cleanDeliverableSummary(reply) : null;
}

/** The newest actual completion — the same memo the console features — or null when no run produced a
 *  report worth condensing. Mirrors web/src/implementationMemos.ts `selectImplementationMemos().latestUseful`. */
export function summarizableMemo(memos: readonly ImplementationMemo[]): ImplementationMemo | null {
  const ordered = [...memos].sort((a, b) => b.revision - a.revision || b.createdAt - a.createdAt);
  return ordered.find((memo) => memo.outcome === "completed" && !!memo.report?.trim()) ?? null;
}

/** A task the owner is looking at as finished: done, or parked in review for them. A cap-park also
 *  lands in review but resumes itself, so it is not a finish worth a summary. */
export function summaryStateFor(thread: Pick<Thread, "state" | "error">, capParkPrefix: string): DeliverableSummary["taskState"] | null {
  if (thread.state === "done") return "done";
  if (thread.state === "review" && !(thread.error ?? "").startsWith(capParkPrefix)) return "review";
  return null;
}

/** Identity of one summary's inputs. Any change the owner would see in the note (a new report revision,
 *  another surfaced file, a review turning into done) changes the key; a re-stamped memo does not. */
export function summarySourceKey(input: DeliverableSummaryInput): string {
  return createHash("sha256").update(`${DELIVERABLE_SUMMARY_MODEL}\n${buildDeliverableSummaryPrompt(input)}`).digest("hex").slice(0, 32);
}

export function deliverableFilesFor(findings: readonly Finding[]): DeliverableSummaryInput["deliverables"] {
  return findings
    .filter((finding) => finding.kind === "deliverable" && !!finding.path)
    .map((finding) => ({ label: finding.label?.trim() || finding.summary, path: finding.path!, description: finding.detail ?? null }));
}
