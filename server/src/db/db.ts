import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { SCHEMA } from "./schema.js";
import type {
  AgentRun,
  AgentRunState,
  DirectorMessage,
  Finding,
  Message,
  Question,
  QuestionOption,
  Role,
  Severity,
  Thread,
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
    summary: r.summary as string,
    detail: (r.detail as string | null) ?? null,
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

function rowToMessage(r: Row): Message {
  return {
    id: r.id as string,
    threadId: r.thread_id as string,
    runId: (r.run_id as string | null) ?? null,
    role: r.role as Message["role"],
    kind: r.kind as Message["kind"],
    content: r.content as string,
    createdAt: r.created_at as number,
  };
}

export class Db {
  readonly raw: Database.Database;

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.raw = new Database(path);
    this.raw.pragma("journal_mode = WAL");
    this.raw.exec(SCHEMA);
    this.migrate();
  }

  private migrate(): void {
    // Add columns introduced after a DB may already exist. Duplicate-column
    // errors are expected on an up-to-date DB and ignored.
    for (const stmt of ["ALTER TABLE agent_runs ADD COLUMN account TEXT"]) {
      try {
        this.raw.exec(stmt);
      } catch {
        /* column already present */
      }
    }
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
  createThread(input: { title: string; workspace: string; rawPrompt: string; brief?: string }): Thread {
    const t: Thread = {
      id: newId(),
      title: input.title,
      state: "intake",
      workspace: input.workspace,
      brief: input.brief ?? "",
      rawPrompt: input.rawPrompt,
      error: null,
      createdAt: now(),
      updatedAt: now(),
    };
    this.raw
      .prepare(
        `INSERT INTO threads(id, title, state, workspace, brief, raw_prompt, error, created_at, updated_at)
         VALUES(@id, @title, @state, @workspace, @brief, @rawPrompt, @error, @createdAt, @updatedAt)`,
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

  // ---- agent runs ----
  createRun(input: { threadId: string; role: Role; model: string; account?: string | null }): AgentRun {
    const r: AgentRun = {
      id: newId(),
      threadId: input.threadId,
      role: input.role,
      model: input.model,
      account: input.account ?? null,
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
        `INSERT INTO agent_runs(id, thread_id, role, model, account, session_id, state, cost_usd, num_turns, error, started_at, ended_at)
         VALUES(@id, @threadId, @role, @model, @account, @sessionId, @state, @costUsd, @numTurns, @error, @startedAt, @endedAt)`,
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

  listAllRuns(): AgentRun[] {
    return (this.raw.prepare("SELECT * FROM agent_runs ORDER BY started_at ASC").all() as Row[]).map(rowToRun);
  }

  // ---- findings ----
  addFinding(input: {
    threadId: string;
    fromRunId?: string | null;
    fromRole?: Role | null;
    summary: string;
    detail?: string | null;
    severity?: Severity;
  }): Finding {
    const f: Finding = {
      id: newId(),
      threadId: input.threadId,
      fromRunId: input.fromRunId ?? null,
      fromRole: input.fromRole ?? null,
      summary: input.summary,
      detail: input.detail ?? null,
      severity: input.severity ?? "note",
      routed: false,
      createdAt: now(),
    };
    this.raw
      .prepare(
        `INSERT INTO findings(id, thread_id, from_run_id, from_role, summary, detail, severity, routed, created_at)
         VALUES(@id, @threadId, @fromRunId, @fromRole, @summary, @detail, @severity, 0, @createdAt)`,
      )
      .run(f);
    return f;
  }

  markFindingRouted(id: string): void {
    this.raw.prepare("UPDATE findings SET routed = 1 WHERE id = ?").run(id);
  }

  listFindings(threadId?: string): Finding[] {
    const rows = threadId
      ? (this.raw.prepare("SELECT * FROM findings WHERE thread_id = ? ORDER BY created_at ASC").all(threadId) as Row[])
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
  }): Message {
    const m: Message = {
      id: newId(),
      threadId: input.threadId,
      runId: input.runId ?? null,
      role: input.role,
      kind: input.kind,
      content: input.content,
      createdAt: now(),
    };
    this.raw
      .prepare(
        `INSERT INTO messages(id, thread_id, run_id, role, kind, content, created_at)
         VALUES(@id, @threadId, @runId, @role, @kind, @content, @createdAt)`,
      )
      .run(m);
    return m;
  }

  listMessages(threadId: string): Message[] {
    return (
      this.raw.prepare("SELECT * FROM messages WHERE thread_id = ? ORDER BY created_at ASC").all(threadId) as Row[]
    ).map(rowToMessage);
  }

  // ---- director conversation ----
  addDirectorMessage(input: { role: "user" | "director"; kind: Message["kind"]; content: string }): DirectorMessage {
    const m: DirectorMessage = {
      id: newId(),
      role: input.role,
      kind: input.kind,
      content: input.content,
      createdAt: now(),
    };
    this.raw
      .prepare(`INSERT INTO director_messages(id, role, kind, content, created_at) VALUES(@id, @role, @kind, @content, @createdAt)`)
      .run(m);
    return m;
  }

  listDirectorMessages(): DirectorMessage[] {
    return (this.raw.prepare("SELECT * FROM director_messages ORDER BY created_at ASC").all() as Row[]).map((r) => ({
      id: r.id as string,
      role: r.role as DirectorMessage["role"],
      kind: r.kind as DirectorMessage["kind"],
      content: r.content as string,
      createdAt: r.created_at as number,
    }));
  }
}
