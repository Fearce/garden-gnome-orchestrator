import { open, readdir } from "node:fs/promises";
import { join } from "node:path";
import type { TokenUsage } from "../types.js";
import { claudeTokenUsage } from "./runner.js";

/** Relative per-token prices shared by every current Claude model (input 1×, output 5×, cache read
 *  0.1×, 1h cache write 2× — GGO sessions cache at the 1h TTL). Only used to apportion a cumulative
 *  cost the CLI reports as one number, so a model-specific price table is unnecessary. */
const PRICE_WEIGHT = { input: 1, output: 5, cacheRead: 0.1, cacheCreation: 2 };

const ZERO: TokenUsage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadInputTokens: 0,
  cacheCreationInputTokens: 0,
  reasoningOutputTokens: 0,
  totalTokens: 0,
};

/** `a − b`, field by field, floored at zero. */
export function subtractTokenUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  const minus = (x: number, y: number) => Math.max(0, x - y);
  return {
    inputTokens: minus(a.inputTokens, b.inputTokens),
    outputTokens: minus(a.outputTokens, b.outputTokens),
    cacheReadInputTokens: minus(a.cacheReadInputTokens, b.cacheReadInputTokens),
    cacheCreationInputTokens: minus(a.cacheCreationInputTokens, b.cacheCreationInputTokens),
    reasoningOutputTokens: minus(a.reasoningOutputTokens, b.reasoningOutputTokens),
    totalTokens: minus(a.totalTokens, b.totalTokens),
  };
}

function addTokenUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadInputTokens: a.cacheReadInputTokens + b.cacheReadInputTokens,
    cacheCreationInputTokens: a.cacheCreationInputTokens + b.cacheCreationInputTokens,
    reasoningOutputTokens: a.reasoningOutputTokens + b.reasoningOutputTokens,
    totalTokens: a.totalTokens + b.totalTokens,
  };
}

function count(value: unknown): number {
  const n = Number(value ?? 0);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
}

/** The SDK result's own `usage`: this query only, never restored from an earlier process. */
function queryTokenUsage(usage: unknown): TokenUsage | undefined {
  if (!usage || typeof usage !== "object") return undefined;
  const u = usage as Record<string, unknown>;
  const q: TokenUsage = {
    ...ZERO,
    inputTokens: count(u.input_tokens),
    outputTokens: count(u.output_tokens),
    cacheReadInputTokens: count(u.cache_read_input_tokens),
    cacheCreationInputTokens: count(u.cache_creation_input_tokens),
  };
  q.totalTokens = q.inputTokens + q.outputTokens + q.cacheReadInputTokens + q.cacheCreationInputTokens;
  return q;
}

function priceWeight(u: TokenUsage): number {
  return (
    u.inputTokens * PRICE_WEIGHT.input +
    u.outputTokens * PRICE_WEIGHT.output +
    u.cacheReadInputTokens * PRICE_WEIGHT.cacheRead +
    u.cacheCreationInputTokens * PRICE_WEIGHT.cacheCreation
  );
}

export interface ClaudeResultUsage {
  modelUsage?: unknown;
  total_cost_usd?: unknown;
  usage?: unknown;
}

/**
 * Turns a Claude CLI result's session-cumulative accounting into this run's own.
 *
 * On `--resume` the CLI restores the session's saved totals, so `modelUsage` and `total_cost_usd` count
 * every earlier process too. The first result of the process pins that restored baseline as
 * `cumulative − this query's usage`; every later result is reported relative to it, which keeps side
 * calls (compaction, the small model) made after the first result. A fresh session has nothing
 * restored and passes through unchanged.
 */
export class ClaudeRunMeter {
  private baseline: { usage: TokenUsage; cost: number } | undefined;

  constructor(private readonly resumed: boolean) {}

  measure(result: ClaudeResultUsage): { tokenUsage?: TokenUsage; costUsd?: number } {
    const cumulative = claudeTokenUsage(result.modelUsage);
    const cost = typeof result.total_cost_usd === "number" ? result.total_cost_usd : undefined;
    if (!this.resumed || !cumulative) return { tokenUsage: cumulative, costUsd: cost };
    this.baseline ??= this.pinBaseline(cumulative, cost ?? 0, queryTokenUsage(result.usage));
    return {
      tokenUsage: subtractTokenUsage(cumulative, this.baseline.usage),
      costUsd: cost === undefined ? undefined : Math.max(0, cost - this.baseline.cost),
    };
  }

  private pinBaseline(cumulative: TokenUsage, cost: number, query: TokenUsage | undefined): { usage: TokenUsage; cost: number } {
    if (!query) return { usage: ZERO, cost: 0 };
    const usage = subtractTokenUsage(cumulative, query);
    const weight = priceWeight(cumulative);
    return { usage, cost: weight > 0 ? cost * (priceWeight(usage) / weight) : 0 };
  }
}

/** Bytes read from a rollout's end when looking for its last running total — a `token_count` event is
 *  written after every model call, so the newest one is always near the end. */
const ROLLOUT_TAIL_BYTES = 4 * 1024 * 1024;

async function findRollout(dir: string, threadId: string): Promise<string | undefined> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return undefined;
  }
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isFile() && entry.name.startsWith("rollout-") && entry.name.endsWith(`${threadId}.jsonl`)) return path;
    if (entry.isDirectory()) {
      const found = await findRollout(path, threadId);
      if (found) return found;
    }
  }
  return undefined;
}

async function readTail(path: string): Promise<string> {
  const file = await open(path, "r");
  try {
    const { size } = await file.stat();
    const length = Math.min(size, ROLLOUT_TAIL_BYTES);
    const buffer = Buffer.alloc(length);
    await file.read(buffer, 0, length, size - length);
    return buffer.toString("utf8");
  } finally {
    await file.close();
  }
}

function tokenCountTotal(line: string): TokenUsage | undefined {
  if (!line.includes('"token_count"')) return undefined;
  let event: { payload?: { type?: string; info?: { total_token_usage?: Record<string, unknown> } | null } };
  try {
    event = JSON.parse(line);
  } catch {
    return undefined;
  }
  const total = event.payload?.type === "token_count" ? event.payload.info?.total_token_usage : undefined;
  if (!total) return undefined;
  const inputTokens = count(total.input_tokens);
  const outputTokens = count(total.output_tokens);
  return {
    inputTokens,
    outputTokens,
    cacheReadInputTokens: count(total.cached_input_tokens),
    cacheCreationInputTokens: 0,
    reasoningOutputTokens: count(total.reasoning_output_tokens),
    totalTokens: count(total.total_tokens) || inputTokens + outputTokens,
  };
}

/**
 * A Codex thread's running token total as its rollout last recorded it — what `codex exec resume`'s
 * `turn.completed.usage` will count from. Undefined when the rollout or a total cannot be found.
 */
export async function codexRolloutTokenUsage(codexHome: string, threadId: string): Promise<TokenUsage | undefined> {
  const rollout = await findRollout(join(codexHome, "sessions"), threadId);
  if (!rollout) return undefined;
  const lines = (await readTail(rollout)).split("\n");
  for (const line of lines.reverse()) {
    const total = tokenCountTotal(line);
    if (total) return total;
  }
  return undefined;
}

/**
 * Turns Codex's thread-cumulative `turn.completed.usage` into this run's own. One run can span several
 * `exec` processes and, after a fresh-session fallback, more than one thread, so each thread is charged
 * from the total its rollout held when this run first touched it (zero for a thread the run started).
 */
export class CodexRunMeter {
  private readonly baselines = new Map<string, TokenUsage>();
  private readonly latest = new Map<string, TokenUsage>();

  constructor(private readonly codexHome: string) {}

  /** Pin a resumed thread's baseline — call before its CLI starts writing to the rollout. */
  async beginTurn(threadId: string | undefined): Promise<void> {
    if (!threadId || this.baselines.has(threadId)) return;
    this.baselines.set(threadId, (await codexRolloutTokenUsage(this.codexHome, threadId)) ?? ZERO);
  }

  record(threadId: string | undefined, cumulative: TokenUsage | undefined): TokenUsage | undefined {
    if (!threadId || !cumulative) return cumulative;
    if (!this.baselines.has(threadId)) this.baselines.set(threadId, ZERO);
    this.latest.set(threadId, cumulative);
    let run = ZERO;
    for (const [thread, total] of this.latest) run = addTokenUsage(run, subtractTokenUsage(total, this.baselines.get(thread) ?? ZERO));
    return run;
  }
}
