import { randomUUID } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import type { AgentRunLike, UserContent } from "../agents/runner.js";
import type { Db } from "../db/db.js";
import type { EventHub } from "../events.js";
import type { AgentEvent, InjectionReceipt, InjectionReceiptStatus, InjectionRecipient, Role, ThreadState } from "../types.js";

// Read receipts for injected owner messages: the gnome checkmark in the task feed.
//
// An injection takes many routes (live send, interrupt, queue to the implementor's hand-off, a buffer
// folded into a kickoff, a cold resume, a QA or auto-review lane) and most of them hold the text for a
// while before any agent sees it. So a receipt is never advanced by the route. It is advanced only by
// what happens at a run's input:
//
//   pending   -> sent       the instruction's text was handed to a live run (send or kickoff)
//   sent      -> delivered  that run's provider proved the input reached the model (AgentRunLike
//                           onInputConsumed: Claude/z.ai echo the message uuid on the turn that consumed
//                           it; Codex/Grok/free providers produce model output for the turn carrying it)
//   delivered -> read       the consuming run answered with this input's unique `ACK IR-…:` token
//
// Outbound inputs name the open receipts whose instructions they carry on whole lines. For routes
// that echo after sending, AsyncLocalStorage restricts late binding to that exact injection operation.
// This prevents a repeated instruction borrowing an older input's proof. Retries keep the same rows.

/** Thread states in which a planner can still take an instruction. */
const PLANNER_STATES: ReadonlySet<ThreadState> = new Set([
  "intake", "enriching", "queued", "awaiting_user", "planning", "researching", "awaiting_approval",
]);
const SETTLED_STATES: ReadonlySet<ThreadState> = new Set(["done", "cancelled", "closed"]);

/** Inputs remembered per lane while their run lives; enough to cover an echo that trails its send. */
const RECENT_INPUTS = 8;

/** `ACK:` (or `ACK -` with any dash) at the start of a line, tolerating markdown emphasis around it. A
 *  reviewer names the instructions it answers first (`ACK RI-1a2b3c4d + RI-5e6f7a8b:`). */
const DASHES = String.fromCharCode(0x2013, 0x2014);
const ACK_RE = new RegExp(`(?:^|\\n)[\\s*_\`>#]*ACK\\b(?:\\s+(?:RI-\\w+|IR-[\\w-]+)(?:\\s*\\+\\s*(?:RI-\\w+|IR-[\\w-]+))*)?[*_\`]*\\s*[:\\-${DASHES}]`);

export function acknowledges(text: string): boolean {
  return ACK_RE.test(text);
}

/** The receipt lane a task run of `role` serves; roles no injection is addressed to have none. */
export function receiptRecipientOf(role: Role): InjectionRecipient | undefined {
  return role === "implementor" || role === "qa" || role === "reviewer" || role === "planner" ? role : undefined;
}

/** Whether `text` carries `instruction` as whole lines. Every route puts the owner's words on lines of
 *  their own (the steering frame, an RI prompt, a numbered standing directive, notes joined by blank
 *  lines), so a whole-line match follows all of them while a short instruction like "ok" cannot bind
 *  to an unrelated input that merely contains the word. Whitespace inside the instruction may differ. */
export function carriesInstruction(text: string, instruction: string): boolean {
  const words = instruction.trim().split(/\s+/).filter(Boolean);
  if (!words.length) return false;
  const body = words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("\\s+");
  return new RegExp(`(?:^|\\n)[ \\t]*(?:\\d+\\.[ \\t]+|[-*][ \\t]+|RI-\\w+:[ \\t]*)?${body}[ \\t]*(?:\\r?\\n|$)`).test(text);
}

function contentText(content: UserContent): string {
  if (typeof content === "string") return content;
  return content
    .map((b) => (b && typeof b === "object" && (b as { type?: unknown }).type === "text" ? String((b as { text?: unknown }).text ?? "") : ""))
    .join("\n");
}

function ackTexts(e: AgentEvent): string[] {
  if (e.type === "text") return [e.text];
  if (e.type !== "result") return [];
  const summary = (e.structuredOutput as { summary?: unknown } | undefined)?.summary;
  return [summary, e.result].filter((s): s is string => typeof s === "string");
}

function acknowledgesInput(e: AgentEvent, marker: string): boolean {
  return ackTexts(e).some((text) => text.split(/\r?\n/).some((line) =>
    acknowledges(line) && new RegExp(`\\b${marker}\\b`).test(line.split(/[:\u2013\u2014]/, 1)[0] ?? ""),
  ));
}

function laneKey(threadId: string, recipient: InjectionRecipient): string {
  return `${threadId}:${recipient}`;
}

type Row = Record<string, unknown>;

function fromRow(r: Row): InjectionReceipt {
  return {
    id: String(r.id),
    messageId: String(r.message_id),
    threadId: String(r.thread_id),
    recipient: r.recipient as InjectionRecipient,
    status: r.status as InjectionReceiptStatus,
    runId: (r.run_id as string | null) ?? null,
    provider: (r.provider as string | null) ?? null,
    detail: (r.detail as string | null) ?? null,
    createdAt: Number(r.created_at),
    sentAt: (r.sent_at as number | null) ?? null,
    deliveredAt: (r.delivered_at as number | null) ?? null,
    readAt: (r.read_at as number | null) ?? null,
    failedAt: (r.failed_at as number | null) ?? null,
  };
}

/** The run an outbound input went to, as the caller knows it at send time. */
export interface ReceiptTarget {
  run: AgentRunLike;
  runId?: string;
  provider: string;
}

/** One input a live run was handed, with the id its provider will confirm consumption by. */
interface SentInput {
  target: ReceiptTarget;
  inputId: string | undefined;
  text: string;
  marker?: string;
  contextId?: string;
  receiptIds: string[];
}

export class InjectionReceipts {
  /** receipt id -> runs it is handed to and not yet taken by, with their consumption-watch unsubscribes. */
  private readonly bound = new Map<string, Map<AgentRunLike, (() => void)[]>>();
  /** run -> receipts it has delivered and that now wait for its ACK. */
  private readonly awaitingAck = new Map<AgentRunLike, Map<string, Set<string>>>();
  /** thread:recipient -> recent inputs of that lane's live runs (see observe). */
  private readonly recent = new Map<string, SentInput[]>();
  private readonly context = new AsyncLocalStorage<{ threadId: string; instruction: string; id: string }>();
  private readonly prepared = new Map<string, { contextId?: string; receiptIds: string[] }>();

  constructor(private readonly db: Db, private readonly hub: EventHub) {}

  /** Scope retroactive binding to this injection operation, never an earlier identical message. */
  withInjection<T>(threadId: string, instruction: string, action: () => T): T {
    return this.context.run({ threadId, instruction, id: randomUUID() }, action);
  }

  /** Give the actual outbound input a unique acknowledgement token. Existing review ACK contracts
   * remain intact; structured agents put the additional receipt line in their summary. */
  prepare(threadId: string, recipient: InjectionRecipient, run: AgentRunLike, content: UserContent): UserContent {
    const text = contentText(content);
    const context = this.context.getStore();
    const current = context?.threadId === threadId && carriesInstruction(text, context.instruction) ? context : undefined;
    const receiptIds = (this.db.raw.prepare("SELECT id, instruction FROM injection_receipts WHERE thread_id=? AND recipient=? AND status IN ('pending','sent','delivered')")
      .all(threadId, recipient) as Row[]).filter((r) => carriesInstruction(text, String(r.instruction))).map((r) => String(r.id));
    if (!current && !receiptIds.length) return content;
    const marker = `IR-${randomUUID()}`;
    this.prepared.set(marker, { contextId: current?.id, receiptIds });
    run.onEnd(() => this.prepared.delete(marker));
    const note = `\n\n[GGO receipt ${marker}]\nAfter taking the instruction(s) above, include a separate acknowledgement line: ACK ${marker}: followed by how you will apply them. For a structured response, include that line in the summary field. Also satisfy any existing RI acknowledgement requirements. This token acknowledges only this input.`;
    return typeof content === "string" ? content + note : [...content, { type: "text", text: note }];
  }

  list(threadId: string): InjectionReceipt[] {
    return (this.db.raw.prepare("SELECT * FROM injection_receipts WHERE thread_id=? ORDER BY created_at, recipient").all(threadId) as Row[]).map(fromRow);
  }

  get(id: string): InjectionReceipt | undefined {
    const row = this.db.raw.prepare("SELECT * FROM injection_receipts WHERE id=?").get(id) as Row | undefined;
    return row ? fromRow(row) : undefined;
  }

  /** Open one pending receipt per recipient for the feed message that carries `instruction`. An empty
   *  instruction (an images-only inject) has no text to follow, so it gets no receipt. A live run of the
   *  lane that was already handed the text (the route sent before it echoed) binds it straight away. */
  expect(threadId: string, messageId: string, instruction: string, recipients: InjectionRecipient[], detail?: string): InjectionReceipt[] {
    const text = instruction.trim();
    if (!text) return [];
    const now = Date.now();
    const created: InjectionReceipt[] = [];
    const insert = this.db.raw.prepare(
      `INSERT OR IGNORE INTO injection_receipts (id, message_id, thread_id, recipient, instruction, status, detail, created_at)
       VALUES (@id, @messageId, @threadId, @recipient, @instruction, 'pending', @detail, @now)`,
    );
    for (const recipient of new Set(recipients)) {
      const id = randomUUID();
      if (insert.run({ id, messageId, threadId, recipient, instruction: text, detail: detail ?? null, now }).changes) {
        const row = this.get(id);
        if (row) created.push(row);
      }
    }
    for (const row of created) {
      this.publish(row);
      this.bindRecent(row.id, threadId, row.recipient, text);
    }
    return created.map((row) => this.get(row.id) ?? row);
  }

  /** Open the receipts already failed: the route that echoed `messageId` could not hand it to anyone. */
  refuse(threadId: string, messageId: string, instruction: string, recipients: InjectionRecipient[], reason: string): void {
    for (const row of this.expect(threadId, messageId, instruction, recipients)) this.fail(row.id, reason);
  }

  /** Called with every input handed to a run of `threadId` in `recipient`'s lane. Binds each open
   *  receipt whose instruction the content carries, then waits for the provider's consumption proof.
   *  The input is also remembered while its run lives, because some routes echo the feed row (and so
   *  open the receipt) only after the send, or after an awaited interrupt let a resume start. */
  observe(threadId: string, recipient: InjectionRecipient, target: ReceiptTarget, content: UserContent): void {
    const text = contentText(content);
    if (!text.trim()) return;
    const marker = text.match(/\[GGO receipt (IR-[\w-]+)\]/)?.[1];
    const prepared = marker ? this.prepared.get(marker) : undefined;
    const context = this.context.getStore();
    const input: SentInput = { target, inputId: target.run.lastInputId, text, marker, contextId: prepared?.contextId ?? (context?.threadId === threadId && carriesInstruction(text, context.instruction) ? context.id : undefined), receiptIds: prepared?.receiptIds ?? [] };
    this.remember(laneKey(threadId, recipient), input);
    const open = this.db.raw
      .prepare("SELECT * FROM injection_receipts WHERE thread_id=? AND recipient=? AND status IN ('pending','sent','delivered') ORDER BY created_at")
      .all(threadId, recipient) as Row[];
    for (const row of open) {
      if (input.receiptIds.includes(String(row.id)) || (!marker && carriesInstruction(text, String(row.instruction)))) this.bind(String(row.id), input);
    }
  }

  /** Fail receipts whose lane can no longer receive anything in `state`. Other parks (paused, review,
   *  failed) keep them open, because a resume can still deliver the text. */
  settleLane(threadId: string, state: ThreadState): void {
    const settled = SETTLED_STATES.has(state);
    if (!settled && PLANNER_STATES.has(state)) return;
    const lanes: InjectionRecipient[] = settled ? ["implementor", "qa", "reviewer", "planner"] : ["planner"];
    const reason = settled
      ? `The task was ${state} before this agent took the message.`
      : "Planning ended before the planner took the message.";
    const rows = this.db.raw
      .prepare(`SELECT id FROM injection_receipts WHERE thread_id=? AND status IN ('pending','sent') AND recipient IN (${lanes.map(() => "?").join(",")})`)
      .all(threadId, ...lanes) as Row[];
    for (const row of rows) this.fail(String(row.id), reason);
  }

  /** In-memory bindings die with the process: a receipt handed to a run that GGO lost on restart is
   *  pending again, and the resumed run's kickoff binds it afresh. Delivered and read stay as proven. */
  recoverAfterRestart(): void {
    this.db.raw
      .prepare("UPDATE injection_receipts SET status='pending', run_id=NULL, detail=? WHERE status='sent'")
      .run("GGO restarted before the agent took it; it goes out again with the resumed run.");
  }

  /** Bind a just-opened receipt to the newest live input of its lane that already carried the text. */
  private bindRecent(id: string, threadId: string, recipient: InjectionRecipient, instruction: string): void {
    const inputs = this.recent.get(laneKey(threadId, recipient)) ?? [];
    const context = this.context.getStore();
    if (context?.threadId !== threadId) return;
    const latest = [...inputs].reverse().find((input) => input.contextId === context.id && carriesInstruction(input.text, instruction));
    if (latest) this.bind(id, latest);
  }

  private remember(key: string, input: SentInput): void {
    const { run } = input.target;
    const list = this.recent.get(key) ?? [];
    if (!list.some((i) => i.target.run === run)) {
      run.onEnd(() => {
        const left = (this.recent.get(key) ?? []).filter((i) => i.target.run !== run);
        if (left.length) this.recent.set(key, left);
        else this.recent.delete(key);
      });
    }
    list.push(input);
    this.recent.set(key, list.slice(-RECENT_INPUTS));
  }

  /** Hand receipt `id` to `input`'s run. A resend of the same text to a run already holding it adds a
   *  watch on the new input, because either input being consumed proves the text arrived. */
  private bind(id: string, input: SentInput): void {
    const { target, inputId } = input;
    const { run } = target;
    const watchable = !!inputId && typeof run.onInputConsumed === "function";
    const runs = this.bound.get(id) ?? new Map<AgentRunLike, (() => void)[]>();
    this.bound.set(id, runs);
    const firstOnRun = !runs.has(run);
    const offs = runs.get(run) ?? [];
    runs.set(run, offs);
    this.update(id, ["pending", "sent"], {
      status: "sent",
      run_id: target.runId ?? null,
      provider: target.provider,
      detail: watchable ? null : "This agent gives no read signal; the message was handed to its input.",
      sent_at: Date.now(),
    }, true);
    if (watchable) {
      offs.push(run.onInputConsumed!(inputId!, () => {
        this.unbind(id, run);
        this.deliver(id, target, input.marker);
      }));
    }
    if (!firstOnRun) return;
    run.onEnd(() => {
      if (!this.bound.get(id)?.has(run)) return;
      this.unbind(id, run);
      if (this.bound.get(id)?.size) return;
      this.update(id, ["sent"], { status: "pending", detail: "The run ended before taking it; it goes out again with the next run." });
    });
  }

  private unbind(id: string, run: AgentRunLike): void {
    const runs = this.bound.get(id);
    if (!runs) return;
    for (const off of runs.get(run) ?? []) off();
    runs.delete(run);
    if (!runs.size) this.bound.delete(id);
  }

  private deliver(id: string, target: ReceiptTarget, marker?: string): void {
    const changed = this.update(id, ["pending", "sent", "delivered"], {
      status: "delivered",
      run_id: target.runId ?? null,
      provider: target.provider,
      detail: null,
      delivered_at: Date.now(),
    });
    if (!changed) return;
    if (!marker) return;
    const waiting = this.awaitingAck.get(target.run);
    if (waiting) {
      const tokens = waiting.get(id) ?? new Set<string>();
      tokens.add(marker);
      waiting.set(id, tokens);
      return;
    }
    this.awaitingAck.set(target.run, new Map([[id, new Set([marker])]]));
    const off = target.run.onEvent((e) => {
      const ids = this.awaitingAck.get(target.run);
      if (!ids?.size) return;
      const now = Date.now();
      for (const [rid, tokens] of ids) {
        if (![...tokens].some((token) => acknowledgesInput(e, token))) continue;
        ids.delete(rid);
        this.update(rid, ["delivered"], { status: "read", read_at: now, run_id: target.runId ?? null, provider: target.provider });
      }
    });
    target.run.onEnd(() => {
      off();
      this.awaitingAck.delete(target.run);
    });
  }

  private fail(id: string, reason: string): void {
    for (const run of [...(this.bound.get(id)?.keys() ?? [])]) this.unbind(id, run);
    this.update(id, ["pending", "sent"], { status: "failed", detail: reason, failed_at: Date.now() });
  }

  /** Apply `patch` only while the receipt is in one of `from`; returns whether it changed. `keepFirstSent`
   *  keeps the earliest sent_at so a resend does not move the time the owner first saw. */
  private update(id: string, from: InjectionReceiptStatus[], patch: Record<string, string | number | null>, keepFirstSent = false): boolean {
    const sets = Object.keys(patch).map((k) => ((keepFirstSent && k === "sent_at") || k === "delivered_at" ? `${k} = COALESCE(${k}, @${k})` : `${k} = @${k}`));
    const res = this.db.raw
      .prepare(`UPDATE injection_receipts SET ${sets.join(", ")} WHERE id = @id AND status IN (${from.map((s) => `'${s}'`).join(",")})`)
      .run({ ...patch, id });
    if (!res.changes) return false;
    const row = this.get(id);
    if (row) this.publish(row);
    return true;
  }

  private publish(receipt: InjectionReceipt): void {
    this.hub.publish({ type: "thread.receipt", threadId: receipt.threadId, receipt });
  }
}
