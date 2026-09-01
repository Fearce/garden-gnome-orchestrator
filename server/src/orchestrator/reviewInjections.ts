import { randomUUID } from "node:crypto";
import type { Db } from "../db/db.js";

export type ReviewInjectionLane = "qa" | "reviewer";
export type ReviewInjectionMode = "append" | "interrupt";
export type ReviewInjectionStatus =
  | "accepted"
  | "delivered_reviewer"
  | "acknowledged_reviewer"
  | "queued_implementor"
  | "delivered_implementor"
  | "implemented"
  | "handled"
  | "failed"
  | "too_late";

export interface ReviewInjection {
  id: string;
  threadId: string;
  lane: ReviewInjectionLane;
  episodeToken: string | null;
  mode: ReviewInjectionMode;
  instruction: string;
  attachmentIds: string[];
  status: ReviewInjectionStatus;
  reviewerRunId: string | null;
  reviewerDeliveredAt: number | null;
  reviewerAcknowledgement: string | null;
  reviewerAcknowledgedAt: number | null;
  implementorRunId: string | null;
  implementorQueuedAt: number | null;
  implementorDeliveredAt: number | null;
  implementorCompletedAt: number | null;
  resolution: string | null;
  createdAt: number;
  updatedAt: number;
}

type Row = Record<string, unknown>;

const OPEN_STATUSES: ReviewInjectionStatus[] = [
  "accepted",
  "delivered_reviewer",
  "acknowledged_reviewer",
  "queued_implementor",
  "delivered_implementor",
  "implemented",
];

function parseIds(raw: unknown): string[] {
  if (typeof raw !== "string" || !raw) return [];
  try {
    const value = JSON.parse(raw) as unknown;
    return Array.isArray(value) ? value.filter((id): id is string => typeof id === "string") : [];
  } catch {
    return [];
  }
}

function fromRow(row: Row): ReviewInjection {
  return {
    id: String(row.id),
    threadId: String(row.thread_id),
    lane: row.lane as ReviewInjectionLane,
    episodeToken: (row.episode_token as string | null) ?? null,
    mode: row.mode as ReviewInjectionMode,
    instruction: String(row.instruction),
    attachmentIds: parseIds(row.attachment_ids),
    status: row.status as ReviewInjectionStatus,
    reviewerRunId: (row.reviewer_run_id as string | null) ?? null,
    reviewerDeliveredAt: row.reviewer_delivered_at == null ? null : Number(row.reviewer_delivered_at),
    reviewerAcknowledgement: (row.reviewer_acknowledgement as string | null) ?? null,
    reviewerAcknowledgedAt: row.reviewer_acknowledged_at == null ? null : Number(row.reviewer_acknowledged_at),
    implementorRunId: (row.implementor_run_id as string | null) ?? null,
    implementorQueuedAt: row.implementor_queued_at == null ? null : Number(row.implementor_queued_at),
    implementorDeliveredAt: row.implementor_delivered_at == null ? null : Number(row.implementor_delivered_at),
    implementorCompletedAt: row.implementor_completed_at == null ? null : Number(row.implementor_completed_at),
    resolution: (row.resolution as string | null) ?? null,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

/**
 * Durable audit and hand-off state for instructions sent while QA or Auto-review owns a task.
 *
 * This deliberately lives beside ThreadManager instead of in its process-local maps: a server bounce,
 * a reviewer verdict racing the WebSocket command, and a reviewer-to-implementor hand-off all cross
 * async/process boundaries. The task feed is the owner-facing narrative; this table is the authority
 * that prevents that narrative from ever claiming delivery without a recipient run and acknowledgement.
 */
export class ReviewInjectionStore {
  constructor(private readonly db: Db) {}

  create(input: {
    threadId: string;
    lane: ReviewInjectionLane;
    episodeToken?: string | null;
    mode: ReviewInjectionMode;
    instruction: string;
    attachmentIds?: string[];
    status?: ReviewInjectionStatus;
    resolution?: string | null;
  }): ReviewInjection {
    const id = randomUUID();
    const at = Date.now();
    this.db.raw
      .prepare(
        `INSERT INTO review_injections
           (id, thread_id, lane, episode_token, mode, instruction, attachment_ids, status,
            resolution, created_at, updated_at)
         VALUES (@id, @threadId, @lane, @episodeToken, @mode, @instruction, @attachmentIds,
                 @status, @resolution, @at, @at)`,
      )
      .run({
        id,
        threadId: input.threadId,
        lane: input.lane,
        episodeToken: input.episodeToken ?? null,
        mode: input.mode,
        instruction: input.instruction.trim(),
        attachmentIds: JSON.stringify(input.attachmentIds ?? []),
        status: input.status ?? "accepted",
        resolution: input.resolution ?? null,
        at,
      });
    return this.get(id)!;
  }

  get(id: string): ReviewInjection | null {
    const row = this.db.raw.prepare("SELECT * FROM review_injections WHERE id=?").get(id) as Row | undefined;
    return row ? fromRow(row) : null;
  }

  listThread(threadId: string): ReviewInjection[] {
    return (this.db.raw.prepare("SELECT * FROM review_injections WHERE thread_id=? ORDER BY created_at, id").all(threadId) as Row[]).map(fromRow);
  }

  listOpen(threadId: string, lane?: ReviewInjectionLane, episodeToken?: string | null): ReviewInjection[] {
    // Statuses come from a closed constant, not caller input, so literals keep this a simple named-bind
    // query without mixing better-sqlite3's anonymous and named parameter modes.
    const statusSql = OPEN_STATUSES.map((status) => `'${status}'`).join(",");
    const where = ["thread_id=@threadId", `status IN (${statusSql})`];
    const named: Record<string, unknown> = { threadId };
    if (lane) {
      where.push("lane=@lane");
      named.lane = lane;
    }
    if (episodeToken !== undefined) {
      where.push(episodeToken === null ? "episode_token IS NULL" : "episode_token=@episodeToken");
      if (episodeToken !== null) named.episodeToken = episodeToken;
    }
    const sql = `SELECT * FROM review_injections WHERE ${where.join(" AND ")} ORDER BY created_at, id`;
    return (this.db.raw.prepare(sql).all(named) as Row[]).map(fromRow);
  }

  pendingReviewer(threadId: string, lane: ReviewInjectionLane, episodeToken?: string | null): ReviewInjection[] {
    const clauses = [
      "thread_id=@threadId",
      "lane=@lane",
      "reviewer_acknowledged_at IS NULL",
      "status IN ('accepted','delivered_reviewer','implemented')",
    ];
    const args: Record<string, unknown> = { threadId, lane };
    if (episodeToken !== undefined) {
      clauses.push(episodeToken === null ? "episode_token IS NULL" : "episode_token=@episodeToken");
      if (episodeToken !== null) args.episodeToken = episodeToken;
    }
    return (this.db.raw.prepare(`SELECT * FROM review_injections WHERE ${clauses.join(" AND ")} ORDER BY created_at, id`).all(args) as Row[]).map(fromRow);
  }

  pendingImplementor(threadId: string, lane?: ReviewInjectionLane, episodeToken?: string | null): ReviewInjection[] {
    const clauses = ["thread_id=@threadId", "status='queued_implementor'"];
    const args: Record<string, unknown> = { threadId };
    if (lane) {
      clauses.push("lane=@lane");
      args.lane = lane;
    }
    if (episodeToken !== undefined) {
      clauses.push(episodeToken === null ? "episode_token IS NULL" : "episode_token=@episodeToken");
      if (episodeToken !== null) args.episodeToken = episodeToken;
    }
    return (this.db.raw.prepare(`SELECT * FROM review_injections WHERE ${clauses.join(" AND ")} ORDER BY created_at, id`).all(args) as Row[]).map(fromRow);
  }

  reassignOpenToEpisode(threadId: string, lane: ReviewInjectionLane, episodeToken: string): ReviewInjection[] {
    const at = Date.now();
    this.db.raw
      .prepare(
        `UPDATE review_injections
            SET episode_token=@episodeToken, status='accepted', reviewer_run_id=NULL,
                reviewer_delivered_at=NULL, reviewer_acknowledgement=NULL,
                reviewer_acknowledged_at=NULL, resolution=NULL, updated_at=@at
          WHERE thread_id=@threadId AND lane=@lane
            AND mode='append'
            AND status IN ('accepted','delivered_reviewer','acknowledged_reviewer',
                           'queued_implementor','delivered_implementor','implemented')`,
      )
      .run({ threadId, lane, episodeToken, at });
    return this.listOpen(threadId, lane, episodeToken);
  }

  requeueForReviewer(ids: string[], reason: string, episodeToken?: string | null): ReviewInjection[] {
    if (!ids.length) return [];
    const at = Date.now();
    this.updateIds(
      ids,
      `status='accepted', episode_token=@episodeToken, reviewer_run_id=NULL,
       reviewer_delivered_at=NULL, reviewer_acknowledgement=NULL,
       reviewer_acknowledged_at=NULL, resolution=@reason, updated_at=@at`,
      { episodeToken: episodeToken ?? null, reason, at },
    );
    return this.getMany(ids);
  }

  markReviewerDelivered(ids: string[], runId: string): ReviewInjection[] {
    if (!ids.length) return [];
    const at = Date.now();
    this.updateIds(
      ids,
      `status='delivered_reviewer', reviewer_run_id=@runId,
       reviewer_delivered_at=@at, updated_at=@at`,
      { runId, at },
    );
    return this.getMany(ids);
  }

  acknowledgeFromSummary(rows: ReviewInjection[], summary: string): ReviewInjection[] {
    if (!/^\s*ACK\b/i.test(summary)) return [];
    const acknowledged = rows.filter((row) => injectionMentioned(summary, row.id));
    if (!acknowledged.length) return [];
    const at = Date.now();
    this.updateIds(
      acknowledged.map((row) => row.id),
      `status='acknowledged_reviewer', reviewer_acknowledgement=@summary,
       reviewer_acknowledged_at=@at, updated_at=@at`,
      { summary, at },
    );
    return this.getMany(acknowledged.map((row) => row.id));
  }

  queueForImplementor(ids: string[], reason: string): ReviewInjection[] {
    if (!ids.length) return [];
    const at = Date.now();
    this.updateIds(
      ids,
      `status='queued_implementor', implementor_queued_at=COALESCE(implementor_queued_at,@at),
       resolution=@reason, updated_at=@at`,
      { reason, at },
    );
    return this.getMany(ids);
  }

  markImplementorDelivered(ids: string[], runId: string): ReviewInjection[] {
    if (!ids.length) return [];
    const at = Date.now();
    this.updateIds(
      ids,
      `status='delivered_implementor', implementor_run_id=@runId,
       implementor_delivered_at=@at, updated_at=@at`,
      { runId, at },
    );
    return this.getMany(ids);
  }

  markImplemented(ids: string[], resolution: string): ReviewInjection[] {
    if (!ids.length) return [];
    const at = Date.now();
    this.updateIds(
      ids,
      `status='implemented', implementor_completed_at=@at, resolution=@resolution,
       reviewer_acknowledgement=NULL, reviewer_acknowledged_at=NULL, updated_at=@at`,
      { resolution, at },
    );
    return this.getMany(ids);
  }

  resolve(ids: string[], resolution: string): ReviewInjection[] {
    if (!ids.length) return [];
    const at = Date.now();
    this.updateIds(ids, `status='handled', resolution=@resolution, updated_at=@at`, { resolution, at });
    return this.getMany(ids);
  }

  fail(ids: string[], reason: string): ReviewInjection[] {
    if (!ids.length) return [];
    const at = Date.now();
    this.updateIds(ids, `status='failed', resolution=@reason, updated_at=@at`, { reason, at });
    return this.getMany(ids);
  }

  deleteThread(threadId: string): void {
    this.db.raw.prepare("DELETE FROM review_injections WHERE thread_id=?").run(threadId);
  }

  private getMany(ids: string[]): ReviewInjection[] {
    if (!ids.length) return [];
    const placeholders = ids.map(() => "?").join(",");
    return (this.db.raw.prepare(`SELECT * FROM review_injections WHERE id IN (${placeholders}) ORDER BY created_at, id`).all(...ids) as Row[]).map(fromRow);
  }

  private updateIds(ids: string[], setSql: string, args: Record<string, unknown>): void {
    const placeholders = ids.map((_, index) => `@id${index}`).join(",");
    const bound = { ...args, ...Object.fromEntries(ids.map((id, index) => [`id${index}`, id])) };
    this.db.raw.prepare(`UPDATE review_injections SET ${setSql} WHERE id IN (${placeholders})`).run(bound);
  }
}

export function reviewInjectionLabel(id: string): string {
  return `RI-${id.slice(0, 8)}`;
}

export function injectionMentioned(summary: string, id: string): boolean {
  const lower = summary.toLowerCase();
  return lower.includes(id.toLowerCase()) || lower.includes(reviewInjectionLabel(id).toLowerCase());
}

export function reviewInjectionPrompt(rows: ReviewInjection[]): string {
  const labels = rows.map((row) => reviewInjectionLabel(row.id));
  return [
    `[CURRENT OWNER INSTRUCTION${rows.length === 1 ? "" : "S"} -- ${labels.join(", ")}]`,
    ...rows.flatMap((row) => [
      `${reviewInjectionLabel(row.id)} (${row.mode}):`,
      row.instruction,
      "",
    ]),
    `[/${rows.length === 1 ? "CURRENT OWNER INSTRUCTION" : "CURRENT OWNER INSTRUCTIONS"}]`,
    "",
    "These arrived during this review and invalidate any verdict drafted before you saw them.",
    `Your next structured summary MUST begin with \`ACK ${labels.join(" + ")}:\` and state what you did in response.`,
    "Act on each instruction now if the read-only reviewer can do so. If it requires edits, git integration, " +
      "conflict resolution, commit, or push, do not pretend it happened: return accept:false with a concrete " +
      "implementor issue explaining exactly what must be done.",
  ].join("\n");
}
