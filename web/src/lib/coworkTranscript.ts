import type { CoworkMessage } from "../types.js";

/** Folding the tool noise out of a Co-work transcript so it reads as a conversation.
 *
 * A real pairing turn emits one `tool` message per call and one `tool_result` per return, and they
 * arrive interleaved with the reply. Rendered one row each, a two-minute turn buries its own answer
 * under thirty collapsed boxes. Two foldings fix that, and both are pure functions so the gate can
 * drive them without a browser:
 *
 *   1. PAIR. A call and its result are ONE thing that happened, joined on the provider's own tool id
 *      (`meta.id`), never on adjacency: results come back out of order under parallel tool use.
 *   2. GROUP. Consecutive calls with no prose between them are one work burst, shown as a single
 *      accordion ("worked 2m - 14 calls"). Prose closes a burst, because that is where the agent
 *      stopped working and started talking.
 */

export interface CoworkToolCall {
  /** The tool message's own id: the stable React key, and what the expand state is remembered by. */
  id: string;
  name: string;
  /** The provider's tool-use id, which is what the result is matched on. */
  callId: string | null;
  input: unknown;
  /** The tool's own output, once it arrives. Null while a call is still in flight. */
  result: string | null;
  failed: boolean;
  at: number;
}

export type CoworkTranscriptItem =
  | { kind: "message"; key: string; message: CoworkMessage }
  | { kind: "tools"; key: string; calls: CoworkToolCall[]; startedAt: number; endedAt: number };

const TOOL_KINDS = new Set(["tool", "tool_result"]);

function metaOf(message: CoworkMessage): Record<string, unknown> | null {
  return message.meta && typeof message.meta === "object" ? (message.meta as Record<string, unknown>) : null;
}

function callIdOf(message: CoworkMessage): string | null {
  const id = metaOf(message)?.id;
  return typeof id === "string" ? id : null;
}

/** One line for the collapsed row: what the call did, not how it did it. Long inputs are the reason
 *  the transcript was unreadable, so this is a label, never the payload. */
export function toolCallSummary(call: CoworkToolCall): string {
  const input = call.input && typeof call.input === "object" ? (call.input as Record<string, unknown>) : null;
  const first = input
    ? ["command", "file_path", "path", "pattern", "url", "query", "description", "prompt"]
      .map((key) => input[key])
      .find((value): value is string => typeof value === "string" && !!value.trim())
    : null;
  const detail = first ?? (typeof call.input === "string" ? call.input : "");
  return detail.trim().split("\n")[0]?.slice(0, 120) ?? "";
}

/** The first useful line of a tool's output, for the same collapsed row. */
export function toolResultSummary(call: CoworkToolCall): string {
  if (call.result == null) return "running…";
  const line = call.result.split("\n").map((part) => part.trim()).find(Boolean) ?? "";
  return line.replace(/^["[{]?\s*/, "").slice(0, 120) || "(no output)";
}

/** Group a durable transcript into what the panel renders. Order is preserved exactly: this only ever
 *  folds neighbouring rows together, so nothing can be reordered or dropped. */
export function groupCoworkTranscript(messages: CoworkMessage[]): CoworkTranscriptItem[] {
  const items: CoworkTranscriptItem[] = [];
  const calls = new Map<string, CoworkToolCall>();
  // Results are matched by tool id, so a result whose call has scrolled past (or arrived first) still
  // finds its row instead of rendering as an orphan block of JSON.
  const pending = new Map<string, CoworkMessage>();
  let burst: Extract<CoworkTranscriptItem, { kind: "tools" }> | null = null;

  const attachResult = (call: CoworkToolCall, result: CoworkMessage): void => {
    call.result = result.content;
    call.failed = metaOf(result)?.isError === true;
  };

  for (const message of messages) {
    if (!TOOL_KINDS.has(message.kind)) {
      burst = null;
      items.push({ kind: "message", key: message.id, message });
      continue;
    }
    if (message.kind === "tool_result") {
      const id = callIdOf(message);
      const call = id ? calls.get(id) : undefined;
      if (call) attachResult(call, message);
      else if (id) pending.set(id, message);
      // A result with no id at all cannot be paired with anything; it is shown as its own row rather
      // than silently dropped, since that is the case where an unexpected payload matters most.
      else {
        burst = null;
        items.push({ kind: "message", key: message.id, message });
      }
      continue;
    }
    const meta = metaOf(message);
    const callId = callIdOf(message);
    const call: CoworkToolCall = {
      id: message.id,
      name: typeof meta?.name === "string" ? meta.name : message.content,
      callId,
      input: meta?.input ?? meta,
      result: null,
      failed: false,
      at: message.createdAt,
    };
    if (callId) {
      calls.set(callId, call);
      const early = pending.get(callId);
      if (early) {
        attachResult(call, early);
        pending.delete(callId);
      }
    }
    if (!burst) {
      burst = { kind: "tools", key: `tools:${message.id}`, calls: [], startedAt: message.createdAt, endedAt: message.createdAt };
      items.push(burst);
    }
    burst.calls.push(call);
    burst.endedAt = Math.max(burst.endedAt, message.createdAt);
  }
  return items;
}

/** "worked 2m - 14 calls": the one line a folded burst shows. */
export function toolBurstLabel(item: Extract<CoworkTranscriptItem, { kind: "tools" }>): string {
  const seconds = Math.max(0, Math.round((item.endedAt - item.startedAt) / 1_000));
  const spent = seconds < 60 ? `${seconds}s` : seconds < 3_600 ? `${Math.round(seconds / 60)}m` : `${(seconds / 3_600).toFixed(1)}h`;
  const count = item.calls.length;
  return `worked ${spent} · ${count} call${count === 1 ? "" : "s"}`;
}

/** The distinct tools a burst used, most-used first: what it spent that time doing. */
export function toolBurstTools(item: Extract<CoworkTranscriptItem, { kind: "tools" }>): string[] {
  const counts = new Map<string, number>();
  for (const call of item.calls) counts.set(call.name, (counts.get(call.name) ?? 0) + 1);
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([name, count]) => (count > 1 ? `${name}×${count}` : name));
}
