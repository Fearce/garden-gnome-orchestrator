import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { SCHEMA } from "./schema.js";
import type {
  AgentRun,
  AgentRunState,
  AttachmentRef,
  ChatCursor,
  ChatMessage,
  ChatRoomSummary,
  ChatScope,
  DirectorMessage,
  Effort,
  Finding,
  FindingKind,
  Message,
  Question,
  QuestionOption,
  Role,
  Severity,
  StageOutputs,
  Thread,
  ThreadLane,
  ThreadState,
} from "../types.js";

export function newId(): string {
  return randomUUID();
}

const now = () => Date.now();

type Row = Record<string, unknown>;

function rowToThread(r: Row): Thread {
  return {
    id: r.id as string,
    title: r.title as string,
    state: r.state as ThreadState,
    workspace: r.workspace as string,
    brief: r.brief as string,
    rawPrompt: r.raw_prompt as string,
    error: (r.error as string | null) ?? null,
    effortOverride: (r.effort_override as Effort | null) ?? null,
    closedAt: (r.closed_at as number | null) ?? null,
    // The state a closed task came from: kept for restore, and surfaced so the UI can mark tasks that
    // finished correctly (closed_prev_state === 'done') with a checkmark. Null on never-closed rows.
    closedPrevState: (r.closed_prev_state as ThreadState | null) ?? null,
    // Dispatch lane: null = normal pipeline, 'read' = the read-only reader lane. A small scalar the UI
    // reads for the READ badge, so it belongs on the DTO (unlike the heavy stage_outputs blob).
    lane: (r.lane as ThreadLane | null) ?? null,
    createdAt: r.created_at as number,
    updatedAt: r.updated_at as number,
  };
}

function rowToRun(r: Row): AgentRun {
  return {
    id: r.id as string,
    threadId: r.thread_id as string,
    role: r.role as Role,
    model: r.model as string,
    account: (r.account as string | null) ?? null,
    effort: (r.effort as Effort | null) ?? null,
    sessionId: (r.session_id as string | null) ?? null,
    state: r.state as AgentRunState,
    costUsd: (r.cost_usd as number | null) ?? null,
    numTurns: (r.num_turns as number | null) ?? null,
    error: (r.error as string | null) ?? null,
    startedAt: r.started_at as number,
    endedAt: (r.ended_at as number | null) ?? null,
  };
}

function rowToFinding(r: Row): Finding {
  return {
    id: r.id as string,
    threadId: r.thread_id as string,
    fromRunId: (r.from_run_id as string | null) ?? null,
    fromRole: (r.from_role as Role | null) ?? null,
    kind: ((r.kind as string | null) ?? "finding") as FindingKind,
    summary: r.summary as string,
    detail: (r.detail as string | null) ?? null,
    path: (r.path as string | null) ?? null,
    label: (r.label as string | null) ?? null,
    severity: r.severity as Severity,
    routed: Boolean(r.routed),
    createdAt: r.created_at as number,
  };
}

function rowToQuestion(r: Row): Question {
  return {
    id: r.id as string,
    threadId: (r.thread_id as string | null) ?? null,
    runId: (r.run_id as string | null) ?? null,
    header: r.header as string,
    question: r.question as string,
    options: JSON.parse((r.options as string) || "[]") as QuestionOption[],
    multiSelect: Boolean(r.multi_select),
    answer: (r.answer as string | null) ?? null,
    answeredAt: (r.answered_at as number | null) ?? null,
    createdAt: r.created_at as number,
  };
}

function rowToChat(r: Row): ChatMessage {
  return {
    id: r.id as string,
    room: r.room as string,
    scope: r.scope as ChatScope,
    workspace: (r.workspace as string | null) ?? null,
    threadId: (r.thread_id as string | null) ?? null,
    runId: (r.run_id as string | null) ?? null,
    role: r.role as ChatMessage["role"],
    kind: r.kind as ChatMessage["kind"],
    body: r.body as string,
    senderName: (r.sender_name as string | null) ?? null,
    createdAt: r.created_at as number,
  };
}

function rowToMessage(r: Row): Message {
  const refs = parseAttachments(r.attachments);
  return {
    id: r.id as string,
    threadId: r.thread_id as string,
    runId: (r.run_id as string | null) ?? null,
    role: r.role as Message["role"],
    kind: r.kind as Message["kind"],
    content: r.content as string,
    attachments: refs.length ? refs : undefined,
    createdAt: r.created_at as number,
  };
}

function rowToDirectorMessage(r: Row): DirectorMessage {
  const refs = parseAttachments(r.attachments);
  return {
    id: r.id as string,
    role: r.role as DirectorMessage["role"],
    kind: r.kind as DirectorMessage["kind"],
    content: r.content as string,
    attachments: refs.length ? refs : undefined,
    threadId: (r.thread_id as string | null) ?? null,
    createdAt: r.created_at as number,
  };
}

// Escape the LIKE wildcards in a user query so a literal % or _ matches itself, not "any run of
// chars". Paired with `ESCAPE '\'` on the statement. Backslash is escaped first so it can't
// double-escape a following wildcard.
function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (c) => "\\" + c);
}

export class Db {
  readonly raw: Database.Database;

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.raw = new Database(path);
    this.raw.pragma("journal_mode = WAL");
    // Enforce ON DELETE CASCADE for thread children. The pragma is connection-scoped and
    // off by default in SQLite, so assert it here (not just in SCHEMA) — deleteThread relies on it.
    this.raw.pragma("foreign_keys = ON");
    this.raw.exec(SCHEMA);
    this.migrate();
  }

  private migrate(): void {
    // Add columns introduced after a DB may already exist. Duplicate-column
    // errors are expected on an up-to-date DB and ignored.
    for (const stmt of [
      "ALTER TABLE agent_runs ADD COLUMN account TEXT",
      "ALTER TABLE agent_runs ADD COLUMN effort TEXT",
      "ALTER TABLE director_messages ADD COLUMN attachments TEXT NOT NULL DEFAULT '[]'",
      "ALTER TABLE messages ADD COLUMN attachments TEXT NOT NULL DEFAULT '[]'",
      "ALTER TABLE threads ADD COLUMN stage_outputs TEXT",
      "ALTER TABLE threads ADD COLUMN effort_override TEXT",
      "ALTER TABLE threads ADD COLUMN closed_at INTEGER",
      "ALTER TABLE threads ADD COLUMN closed_prev_state TEXT",
      "ALTER TABLE chat_messages ADD COLUMN sender_name TEXT",
      "ALTER TABLE findings ADD COLUMN kind TEXT NOT NULL DEFAULT 'finding'",
      "ALTER TABLE findings ADD COLUMN path TEXT",
      "ALTER TABLE findings ADD COLUMN label TEXT",
      "ALTER TABLE director_messages ADD COLUMN thread_id TEXT",
      "ALTER TABLE threads ADD COLUMN lane TEXT",
    ]) {
      try {
        this.raw.exec(stmt);
      } catch {
        /* column already present */
      }
    }
    this.backfillDirectorThreadLinks();
  }

  // One-time: attribute each pre-existing director message to the task its turn dispatched, so the
  // search's "go to task" jump works for history recorded before message→task links existed. New messages
  // are linked exactly at dispatch time (Director), so this only backfills the past. The rule is
  // ROLE-AWARE, because a prompt and a note sit on opposite sides of the dispatch — and it only links
  // when it's CONFIDENT, leaving everything else null (no chip) rather than inventing a wrong jump target:
  //   - a USER prompt reliably precedes its dispatch → the FIRST task created at/after it.
  //   - a DIRECTOR note is only confidently a DISPATCH CONFIRMATION when a task was created in the short
  //     window just BEFORE it (the "dispatched X" note is written right after api.dispatch returns) → link
  //     to that task. Enrichment replies, clarifying questions and error notices have no task in that
  //     window → they stay null. (This is the fix for the v1 bug, where a single at/after rule sent every
  //     confirmation to the FOLLOWING task, and an unguarded nearest-task rule mislinked every non-dispatch
  //     director note to a neighbouring task.)
  // It recomputes EVERY row (not just nulls) because v1 already wrote wrong links into existing DBs that
  // must be corrected; the corrected director rule only ever yields the confirmation's own task or null,
  // so it can't produce a wrong jump target. The v2 flag guards against re-running.
  private backfillDirectorThreadLinks(): void {
    if (this.kvGet("director_thread_backfill_v2")) return;
    const CONFIRMATION_WINDOW_MS = 15000;
    this.raw
      .prepare(
        `UPDATE director_messages
         SET thread_id = CASE director_messages.role
           WHEN 'user' THEN (
             SELECT t.id FROM threads t
             WHERE t.created_at >= director_messages.created_at
             ORDER BY t.created_at ASC LIMIT 1
           )
           ELSE (
             SELECT t.id FROM threads t
             WHERE t.created_at <= director_messages.created_at
               AND director_messages.created_at - t.created_at <= ?
             ORDER BY t.created_at DESC LIMIT 1
           )
         END`,
      )
      .run(CONFIRMATION_WINDOW_MS);
    this.kvSet("director_thread_backfill_v2", "1");
  }

  // ---- kv ----
  kvGet(key: string): string | null {
    const r = this.raw.prepare("SELECT value FROM kv WHERE key = ?").get(key) as Row | undefined;
    return r ? (r.value as string) : null;
  }
  kvSet(key: string, value: string): void {
    this.raw
      .prepare("INSERT INTO kv(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .run(key, value);
  }

  // ---- threads ----
  createThread(input: { title: string; workspace: string; rawPrompt: string; brief?: string; effortOverride?: Effort | null; lane?: ThreadLane | null }): Thread {
    const t: Thread = {
      id: newId(),
      title: input.title,
      state: "intake",
      workspace: input.workspace,
      brief: input.brief ?? "",
      rawPrompt: input.rawPrompt,
      error: null,
      effortOverride: input.effortOverride ?? null,
      lane: input.lane ?? null,
      createdAt: now(),
      updatedAt: now(),
    };
    this.raw
      .prepare(
        `INSERT INTO threads(id, title, state, workspace, brief, raw_prompt, error, effort_override, lane, created_at, updated_at)
         VALUES(@id, @title, @state, @workspace, @brief, @rawPrompt, @error, @effortOverride, @lane, @createdAt, @updatedAt)`,
      )
      .run(t);
    return t;
  }

  getThread(id: string): Thread | null {
    const r = this.raw.prepare("SELECT * FROM threads WHERE id = ?").get(id) as Row | undefined;
    return r ? rowToThread(r) : null;
  }

  listThreads(): Thread[] {
    return (this.raw.prepare("SELECT * FROM threads ORDER BY created_at DESC").all() as Row[]).map(rowToThread);
  }

  /** Permanently delete a thread and all its children. agent_runs/findings/messages drop via FK
   *  ON DELETE CASCADE (the foreign_keys pragma is asserted in the constructor). questions.thread_id
   *  is nullable with NO FK — a question can be threadless — so its rows are deleted explicitly.
   *  Wrapped in a transaction so the thread and its questions go together or not at all. */
  deleteThread(id: string): void {
    this.raw.transaction((tid: string) => {
      this.raw.prepare("DELETE FROM questions WHERE thread_id = ?").run(tid);
      this.raw.prepare("DELETE FROM threads WHERE id = ?").run(tid);
    })(id);
  }

  updateThread(id: string, patch: Partial<Pick<Thread, "title" | "state" | "brief" | "workspace" | "error">>): Thread | null {
    const current = this.getThread(id);
    if (!current) return null;
    const next = { ...current, ...patch, updatedAt: now() };
    this.raw
      .prepare(
        `UPDATE threads SET title=@title, state=@state, brief=@brief, workspace=@workspace, error=@error, updated_at=@updatedAt WHERE id=@id`,
      )
      .run(next);
    return next;
  }

  /** Soft-close a thread: stamp state='closed', remember the state it came from (closed_prev_state,
   *  for restore), and start the 30-day auto-purge clock (closed_at). Managed only here and in
   *  restoreThread — the generic updateThread SQL never writes these columns, so a normal state change
   *  can't clobber them. */
  closeThread(id: string): Thread | null {
    const current = this.getThread(id);
    if (!current) return null;
    const at = now();
    this.raw
      .prepare(
        `UPDATE threads SET state='closed', closed_at=@at, closed_prev_state=@prev, updated_at=@at WHERE id=@id`,
      )
      .run({ id, at, prev: current.state });
    return { ...current, state: "closed", closedAt: at, closedPrevState: current.state, updatedAt: at };
  }

  /** Restore a closed thread back to the state it was closed from (closed_prev_state; fallback
   *  'review' if it's somehow missing), clearing the close bookkeeping so the purge clock stops. */
  restoreThread(id: string): Thread | null {
    const r = this.raw.prepare("SELECT closed_prev_state FROM threads WHERE id = ?").get(id) as Row | undefined;
    if (!r) return null;
    const prev = ((r.closed_prev_state as string | null) ?? "review") as ThreadState;
    const at = now();
    this.raw
      .prepare(
        `UPDATE threads SET state=@prev, closed_at=NULL, closed_prev_state=NULL, updated_at=@at WHERE id=@id`,
      )
      .run({ id, prev, at });
    return this.getThread(id);
  }

  /** Closed threads whose 30-day window has elapsed (closed_at strictly before `cutoff`) — the boot
   *  + daily auto-purge sweep deletes these permanently. */
  listClosedBefore(cutoff: number): Thread[] {
    return (
      this.raw
        .prepare("SELECT * FROM threads WHERE state='closed' AND closed_at IS NOT NULL AND closed_at < ?")
        .all(cutoff) as Row[]
    ).map(rowToThread);
  }

  /** Saved per-stage pipeline outputs for resume, or {} if none yet. Deliberately NOT folded into
   *  rowToThread/the Thread DTO: this JSON (plan + research + kickoff) can be multi-KB and the UI
   *  never needs it, so it stays off every thread.upsert frame — only the resume path reads it. */
  getThreadStageOutputs(id: string): StageOutputs {
    const r = this.raw.prepare("SELECT stage_outputs FROM threads WHERE id = ?").get(id) as Row | undefined;
    return r ? parseStageOutputs(r.stage_outputs) : {};
  }

  /** Additively merge a stage's output into the saved set — read-merge-write so persisting a later
   *  stage (e.g. research) never wipes an earlier one (plan). Sibling keys are preserved. */
  updateThreadStageOutputs(id: string, patch: Partial<StageOutputs>): void {
    const r = this.raw.prepare("SELECT stage_outputs FROM threads WHERE id = ?").get(id) as Row | undefined;
    if (!r) return;
    const next = { ...parseStageOutputs(r.stage_outputs), ...patch };
    this.raw.prepare("UPDATE threads SET stage_outputs = ? WHERE id = ?").run(JSON.stringify(next), id);
  }

  /** Wipe a thread's prior attempt for a from-scratch retry: delete its agent_runs (incl. the
   *  implementor session a resume would otherwise reuse), findings, feed messages and questions,
   *  and clear every saved stage output + the error — keeping the thread row itself (title/brief/
   *  workspace) so the pipeline can re-run from the original brief. The office chat_messages are
   *  intentionally left (a durable cross-task record, no thread FK). Transactional so the wipe is
   *  all-or-nothing. */
  resetThreadForRetry(id: string): void {
    this.raw.transaction((tid: string) => {
      this.raw.prepare("DELETE FROM agent_runs WHERE thread_id = ?").run(tid);
      this.raw.prepare("DELETE FROM findings WHERE thread_id = ?").run(tid);
      this.raw.prepare("DELETE FROM messages WHERE thread_id = ?").run(tid);
      this.raw.prepare("DELETE FROM questions WHERE thread_id = ?").run(tid);
      this.raw.prepare("UPDATE threads SET stage_outputs = NULL, error = NULL WHERE id = ?").run(tid);
    })(id);
  }

  // ---- agent runs ----
  createRun(input: { threadId: string; role: Role; model: string; account?: string | null; effort?: Effort | null }): AgentRun {
    const r: AgentRun = {
      id: newId(),
      threadId: input.threadId,
      role: input.role,
      model: input.model,
      account: input.account ?? null,
      effort: input.effort ?? null,
      sessionId: null,
      state: "starting",
      costUsd: null,
      numTurns: null,
      error: null,
      startedAt: now(),
      endedAt: null,
    };
    this.raw
      .prepare(
        `INSERT INTO agent_runs(id, thread_id, role, model, account, effort, session_id, state, cost_usd, num_turns, error, started_at, ended_at)
         VALUES(@id, @threadId, @role, @model, @account, @effort, @sessionId, @state, @costUsd, @numTurns, @error, @startedAt, @endedAt)`,
      )
      .run(r);
    return r;
  }

  updateRun(
    id: string,
    patch: Partial<Pick<AgentRun, "sessionId" | "state" | "costUsd" | "numTurns" | "error" | "endedAt">>,
  ): void {
    const sets: string[] = [];
    const params: Row = { id };
    const map: Record<string, string> = {
      sessionId: "session_id",
      state: "state",
      costUsd: "cost_usd",
      numTurns: "num_turns",
      error: "error",
      endedAt: "ended_at",
    };
    for (const [k, col] of Object.entries(map)) {
      if (k in patch) {
        sets.push(`${col} = @${k}`);
        params[k] = (patch as Row)[k] ?? null;
      }
    }
    if (!sets.length) return;
    this.raw.prepare(`UPDATE agent_runs SET ${sets.join(", ")} WHERE id = @id`).run(params);
  }

  getRun(id: string): AgentRun | null {
    const r = this.raw.prepare("SELECT * FROM agent_runs WHERE id = ?").get(id) as Row | undefined;
    return r ? rowToRun(r) : null;
  }

  listRuns(threadId: string): AgentRun[] {
    return (
      this.raw.prepare("SELECT * FROM agent_runs WHERE thread_id = ? ORDER BY started_at ASC").all(threadId) as Row[]
    ).map(rowToRun);
  }

  /** All runs (ASC), or — for the connect snapshot — the most recent `limit` (still returned ASC) so
   *  the hello frame can't grow unbounded as months of history accumulate. */
  listAllRuns(limit?: number): AgentRun[] {
    const rows = limit
      ? (this.raw.prepare("SELECT * FROM agent_runs ORDER BY started_at DESC LIMIT ?").all(limit) as Row[]).reverse()
      : (this.raw.prepare("SELECT * FROM agent_runs ORDER BY started_at ASC").all() as Row[]);
    return rows.map(rowToRun);
  }

  /** Runs the DB still believes are live (no terminal state, no end time) — orphans after a
   *  restart, since every in-memory AgentRun is gone. Used to reconcile the live count on boot. */
  listActiveRuns(): AgentRun[] {
    return (
      this.raw
        .prepare(
          "SELECT * FROM agent_runs WHERE state IN ('starting','running','idle') AND ended_at IS NULL ORDER BY started_at ASC",
        )
        .all() as Row[]
    ).map(rowToRun);
  }

  // ---- findings ----
  addFinding(input: {
    threadId: string;
    fromRunId?: string | null;
    fromRole?: Role | null;
    kind?: FindingKind;
    summary: string;
    detail?: string | null;
    path?: string | null;
    label?: string | null;
    severity?: Severity;
  }): Finding {
    const f: Finding = {
      id: newId(),
      threadId: input.threadId,
      fromRunId: input.fromRunId ?? null,
      fromRole: input.fromRole ?? null,
      kind: input.kind ?? "finding",
      summary: input.summary,
      detail: input.detail ?? null,
      path: input.path ?? null,
      label: input.label ?? null,
      severity: input.severity ?? "note",
      routed: false,
      createdAt: now(),
    };
    this.raw
      .prepare(
        `INSERT INTO findings(id, thread_id, from_run_id, from_role, kind, summary, detail, path, label, severity, routed, created_at)
         VALUES(@id, @threadId, @fromRunId, @fromRole, @kind, @summary, @detail, @path, @label, @severity, 0, @createdAt)`,
      )
      .run(f);
    return f;
  }

  getFinding(id: string): Finding | null {
    const r = this.raw.prepare("SELECT * FROM findings WHERE id = ?").get(id) as Row | undefined;
    return r ? rowToFinding(r) : null;
  }

  markFindingRouted(id: string): void {
    this.raw.prepare("UPDATE findings SET routed = 1 WHERE id = ?").run(id);
  }

  listFindings(threadId?: string, limit?: number): Finding[] {
    if (threadId) {
      return (this.raw.prepare("SELECT * FROM findings WHERE thread_id = ? ORDER BY created_at ASC").all(threadId) as Row[]).map(rowToFinding);
    }
    // Cross-thread read (the connect snapshot): bound to the most recent `limit`, returned ASC.
    const rows = limit
      ? (this.raw.prepare("SELECT * FROM findings ORDER BY created_at DESC LIMIT ?").all(limit) as Row[]).reverse()
      : (this.raw.prepare("SELECT * FROM findings ORDER BY created_at ASC").all() as Row[]);
    return rows.map(rowToFinding);
  }

  // ---- questions ----
  addQuestion(input: {
    threadId: string | null;
    runId?: string | null;
    header: string;
    question: string;
    options: QuestionOption[];
    multiSelect: boolean;
  }): Question {
    const q: Question = {
      id: newId(),
      threadId: input.threadId,
      runId: input.runId ?? null,
      header: input.header,
      question: input.question,
      options: input.options,
      multiSelect: input.multiSelect,
      answer: null,
      answeredAt: null,
      createdAt: now(),
    };
    this.raw
      .prepare(
        `INSERT INTO questions(id, thread_id, run_id, header, question, options, multi_select, answer, answered_at, created_at)
         VALUES(@id, @threadId, @runId, @header, @question, @options, @multiSelect, NULL, NULL, @createdAt)`,
      )
      .run({ ...q, options: JSON.stringify(q.options), multiSelect: q.multiSelect ? 1 : 0 });
    return q;
  }

  answerQuestion(id: string, answer: string): Question | null {
    this.raw.prepare("UPDATE questions SET answer = ?, answered_at = ? WHERE id = ?").run(answer, now(), id);
    const r = this.raw.prepare("SELECT * FROM questions WHERE id = ?").get(id) as Row | undefined;
    return r ? rowToQuestion(r) : null;
  }

  getQuestion(id: string): Question | null {
    const r = this.raw.prepare("SELECT * FROM questions WHERE id = ?").get(id) as Row | undefined;
    return r ? rowToQuestion(r) : null;
  }

  listOpenQuestions(): Question[] {
    return (
      this.raw.prepare("SELECT * FROM questions WHERE answer IS NULL ORDER BY created_at ASC").all() as Row[]
    ).map(rowToQuestion);
  }

  // ---- messages ----
  addMessage(input: {
    threadId: string;
    runId?: string | null;
    role: Message["role"];
    kind: Message["kind"];
    content: string;
    attachments?: AttachmentRef[];
  }): Message {
    const m: Message = {
      id: newId(),
      threadId: input.threadId,
      runId: input.runId ?? null,
      role: input.role,
      kind: input.kind,
      content: input.content,
      attachments: input.attachments?.length ? input.attachments : undefined,
      createdAt: now(),
    };
    this.raw
      .prepare(
        `INSERT INTO messages(id, thread_id, run_id, role, kind, content, attachments, created_at)
         VALUES(@id, @threadId, @runId, @role, @kind, @content, @attachments, @createdAt)`,
      )
      .run({ ...m, attachments: JSON.stringify(m.attachments ?? []) });
    return m;
  }

  listMessages(threadId: string): Message[] {
    return (
      this.raw.prepare("SELECT * FROM messages WHERE thread_id = ? ORDER BY created_at ASC").all(threadId) as Row[]
    ).map(rowToMessage);
  }

  /** The most recent message of a given role+kind for a thread, or null — a single indexed lookup so
   *  callers (e.g. the auto-resume "looks done?" check) don't materialize the whole message history. */
  lastMessageOf(threadId: string, role: Message["role"], kind: Message["kind"]): Message | null {
    const row = this.raw
      .prepare("SELECT * FROM messages WHERE thread_id = ? AND role = ? AND kind = ? ORDER BY created_at DESC LIMIT 1")
      .get(threadId, role, kind) as Row | undefined;
    return row ? rowToMessage(row) : null;
  }

  // ---- director conversation ----
  addDirectorMessage(input: {
    role: "user" | "director";
    kind: Message["kind"];
    content: string;
    attachments?: AttachmentRef[];
  }): DirectorMessage {
    const m: DirectorMessage = {
      id: newId(),
      role: input.role,
      kind: input.kind,
      content: input.content,
      attachments: input.attachments?.length ? input.attachments : undefined,
      createdAt: now(),
    };
    this.raw
      .prepare(
        `INSERT INTO director_messages(id, role, kind, content, attachments, created_at)
         VALUES(@id, @role, @kind, @content, @attachments, @createdAt)`,
      )
      .run({ ...m, attachments: JSON.stringify(m.attachments ?? []) });
    return m;
  }

  /** Link the given director messages to the task their conversation turn dispatched, so a search hit
   *  can jump to it. Only fills still-unlinked rows (thread_id IS NULL), so an earlier dispatch in the
   *  same turn keeps ownership of the shared lead-up messages when a second task is dispatched after. */
  linkDirectorMessagesToThread(messageIds: string[], threadId: string): void {
    if (!messageIds.length) return;
    const placeholders = messageIds.map(() => "?").join(",");
    this.raw
      .prepare(`UPDATE director_messages SET thread_id = ? WHERE thread_id IS NULL AND id IN (${placeholders})`)
      .run(threadId, ...messageIds);
  }

  /** The director conversation (ASC), or — for the connect snapshot — the most recent `limit`
   *  (returned ASC) so a months-long chat doesn't bloat every hello/reconnect frame. */
  listDirectorMessages(limit?: number): DirectorMessage[] {
    const rows = limit
      ? (this.raw.prepare("SELECT * FROM director_messages ORDER BY created_at DESC LIMIT ?").all(limit) as Row[]).reverse()
      : (this.raw.prepare("SELECT * FROM director_messages ORDER BY created_at ASC").all() as Row[]);
    return rows.map(rowToDirectorMessage);
  }

  /** Substring search across the ENTIRE director conversation (both the user's prompts and the
   *  director's replies) — the "find where I mentioned X across every task" search, so it spans the
   *  whole table, not the bounded snapshot slice. Newest-first, capped. Match is case-insensitive for
   *  ASCII (SQLite LIKE's built-in fold); non-ASCII letters match case-sensitively. */
  searchDirectorMessages(query: string, limit = 100): DirectorMessage[] {
    const q = query.trim();
    if (!q) return [];
    const rows = this.raw
      .prepare(
        `SELECT * FROM director_messages
         WHERE content LIKE ? ESCAPE '\\'
         ORDER BY created_at DESC LIMIT ?`,
      )
      .all(`%${escapeLike(q)}%`, limit) as Row[];
    return rows.map(rowToDirectorMessage);
  }

  // ---- office chat ----
  addChatMessage(input: {
    room: string;
    scope: ChatScope;
    workspace?: string | null;
    threadId?: string | null;
    runId?: string | null;
    role: ChatMessage["role"];
    kind?: ChatMessage["kind"];
    body: string;
    senderName?: string | null;
  }): ChatMessage {
    const m: ChatMessage = {
      id: newId(),
      room: input.room,
      scope: input.scope,
      workspace: input.workspace ?? null,
      threadId: input.threadId ?? null,
      runId: input.runId ?? null,
      role: input.role,
      kind: input.kind ?? "chat",
      body: input.body,
      senderName: input.senderName ?? null,
      createdAt: now(),
    };
    this.raw
      .prepare(
        `INSERT INTO chat_messages(id, room, scope, workspace, thread_id, run_id, role, kind, body, sender_name, created_at)
         VALUES(@id, @room, @scope, @workspace, @threadId, @runId, @role, @kind, @body, @senderName, @createdAt)`,
      )
      .run(m);
    return m;
  }

  /** Messages in one room (ASC), optionally only the most recent `limit` (still returned ASC). */
  listRoomMessages(room: string, limit?: number): ChatMessage[] {
    const rows = limit
      ? (this.raw.prepare("SELECT * FROM chat_messages WHERE room = ? ORDER BY created_at DESC LIMIT ?").all(room, limit) as Row[]).reverse()
      : (this.raw.prepare("SELECT * FROM chat_messages WHERE room = ? ORDER BY created_at ASC").all(room) as Row[]);
    return rows.map(rowToChat);
  }

  /** One page of a room's history for the lazily-loaded chatroom view. Without `before` this returns the
   *  most recent `limit` messages; with a `before` cursor it returns the `limit` messages immediately
   *  older than that cursor. Always ASC. `hasMore` says whether still-older messages exist beyond this
   *  page, so the client knows when to stop fetching as the user scrolls up. Keyset-paginated on
   *  (created_at, id) — id (a UUID) is the deterministic tie-break within a millisecond, so no message is
   *  skipped or duplicated at a page boundary even when several land in the same tick. */
  listRoomMessagePage(room: string, limit: number, before?: ChatCursor): { messages: ChatMessage[]; hasMore: boolean } {
    const probe = limit + 1; // fetch one extra to detect whether older messages remain
    const rows = before
      ? (this.raw
          .prepare(
            `SELECT * FROM chat_messages
             WHERE room = ? AND (created_at < @createdAt OR (created_at = @createdAt AND id < @id))
             ORDER BY created_at DESC, id DESC LIMIT @probe`,
          )
          .all(room, { createdAt: before.createdAt, id: before.id, probe }) as Row[])
      : (this.raw.prepare("SELECT * FROM chat_messages WHERE room = ? ORDER BY created_at DESC, id DESC LIMIT ?").all(room, probe) as Row[]);
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    return { messages: page.reverse().map(rowToChat), hasMore };
  }

  /** The most recent `limit` chat messages across ALL rooms (returned ASC) — the connect-snapshot
   *  slice, bounded so a months-long office history doesn't bloat every hello frame. */
  listRecentChat(limit: number): ChatMessage[] {
    return (this.raw.prepare("SELECT * FROM chat_messages ORDER BY created_at DESC LIMIT ?").all(limit) as Row[])
      .reverse()
      .map(rowToChat);
  }

  /** Whether a task already has any message in a room — used to announce each participant exactly
   *  once when a project group forms (durable across restarts, unlike an in-memory guard). */
  chatThreadInRoom(room: string, threadId: string): boolean {
    const r = this.raw
      .prepare("SELECT 1 FROM chat_messages WHERE room = ? AND thread_id = ? LIMIT 1")
      .get(room, threadId) as Row | undefined;
    return !!r;
  }

  /** Rolled-up project (per-repo) rooms with their distinct participant task ids — drives which tasks
   *  show a "Chatroom" button. General-room rows are excluded (every active agent is in general; it's
   *  not a per-task collaboration). Newest-active room first. */
  listProjectRooms(): ChatRoomSummary[] {
    const rows = this.raw
      .prepare(
        `SELECT room,
                MAX(workspace)      AS workspace,
                COUNT(*)            AS message_count,
                MAX(created_at)     AS last_at,
                GROUP_CONCAT(DISTINCT thread_id) AS thread_ids
         FROM chat_messages
         WHERE scope = 'project'
         GROUP BY room
         ORDER BY last_at DESC`,
      )
      .all() as Row[];
    return rows.map((r) => ({
      room: r.room as string,
      workspace: (r.workspace as string | null) ?? "",
      threadIds: String(r.thread_ids ?? "")
        .split(",")
        .filter(Boolean),
      messageCount: r.message_count as number,
      lastAt: r.last_at as number,
    }));
  }

  // ---- attachments (image bytes; served on demand over HTTP, refs over WS) ----
  addAttachment(input: { name: string; mediaType: string; data: string }): AttachmentRef {
    const id = newId();
    this.raw
      .prepare(`INSERT INTO attachments(id, name, media_type, data, created_at) VALUES(?, ?, ?, ?, ?)`)
      .run(id, input.name, input.mediaType, input.data, now());
    return { id, name: input.name, mediaType: input.mediaType };
  }

  getAttachment(id: string): { name: string; mediaType: string; data: string } | null {
    const r = this.raw.prepare("SELECT name, media_type, data FROM attachments WHERE id = ?").get(id) as Row | undefined;
    return r ? { name: r.name as string, mediaType: r.media_type as string, data: r.data as string } : null;
  }
}

function parseStageOutputs(raw: unknown): StageOutputs {
  if (typeof raw !== "string" || !raw) return {};
  try {
    const v = JSON.parse(raw);
    return v && typeof v === "object" && !Array.isArray(v) ? (v as StageOutputs) : {};
  } catch {
    return {};
  }
}

function parseAttachments(raw: unknown): AttachmentRef[] {
  if (typeof raw !== "string" || !raw) return [];
  try {
    const v = JSON.parse(raw);
    if (!Array.isArray(v)) return [];
    return v.filter(
      (x): x is AttachmentRef =>
        !!x && typeof x.id === "string" && typeof x.name === "string" && typeof x.mediaType === "string",
    );
  } catch {
    return [];
  }
}
