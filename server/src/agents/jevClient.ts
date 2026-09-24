import type { JevAnswer, JevJson, JevQuestion } from "../types.js";

/**
 * TypeSafe AI's Jev — a System One model. It takes a `state` plus a map of typed questions and returns
 * calibrated typed answers (a yes-probability, a chosen option with its distribution, or a rubric score).
 * It never generates text and never uses tools, so a Jev sub-agent is one HTTP call, not a session.
 *
 * API reference: https://docs.typesafe.ai/api (verified against the live endpoint 2026-09-24).
 */

export const JEV_API_BASE = "https://api.typesafe.ai";
export const JEV_DEFAULT_MODEL = "jev-latest";
/** Aliases the API documents. A versioned id (`jev-1.13.0`) is also accepted, so this is a hint, not a gate. */
export const JEV_MODELS = ["jev-latest", "jev-preview"] as const;
/** Charged per input token; output is free. $0.042 per million input tokens (docs.typesafe.ai/models). */
export const JEV_USD_PER_INPUT_TOKEN = 0.042 / 1_000_000;

// API limits, enforced before the call so a malformed request fails with a message the calling agent
// can act on rather than an opaque 422.
const MAX_CHOICE_OPTIONS = 255;
const MIN_SCORE_LEVELS = 2;
const MAX_SCORE_LEVELS = 10;
const MAX_QUESTIONS = 64;
/** ~64k tokens of context shared by state + questions; 4 chars/token is a generous upper estimate. */
const MAX_REQUEST_CHARS = 250_000;
const QUESTION_ID_RE = /^[A-Za-z0-9_.-]{1,64}$/;

const RETRY_STATUSES = new Set([429, 529, 500, 502, 503, 504]);
const MAX_ATTEMPTS = 4;
const REQUEST_TIMEOUT_MS = 60_000;

export interface JevResult {
  model: string;
  answers: Record<string, JevAnswer>;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

export class JevError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

/** Why a question map cannot be sent, or null when it matches the API's shape. */
export function invalidJevQuestions(questions: unknown): string | null {
  if (!questions || typeof questions !== "object" || Array.isArray(questions)) return "`questions` must be an object mapping a question id to a question.";
  const entries = Object.entries(questions as Record<string, unknown>);
  if (!entries.length) return "Ask at least one question.";
  if (entries.length > MAX_QUESTIONS) return `Ask at most ${MAX_QUESTIONS} questions in one call.`;
  for (const [id, raw] of entries) {
    if (!QUESTION_ID_RE.test(id)) return `Question id "${id}" must be 1-64 letters, digits, "_", "-" or ".".`;
    const problem = invalidQuestion(raw);
    if (problem) return `Question "${id}": ${problem}`;
  }
  return null;
}

function invalidQuestion(raw: unknown): string | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return "must be an object with `type` and `instructions`.";
  const q = raw as Record<string, unknown>;
  if (q.instructions === undefined || q.instructions === null || q.instructions === "") return "`instructions` is required.";
  if (q.type === "noul") {
    if (q.criteria !== undefined && (typeof q.criteria !== "object" || q.criteria === null || Array.isArray(q.criteria))) {
      return "a noul `criteria` must be an object with optional `true`/`false` descriptions.";
    }
    return null;
  }
  if (q.type === "choice") {
    if (!q.criteria || typeof q.criteria !== "object" || Array.isArray(q.criteria)) return "a choice needs `criteria`: an object mapping each option to a description (or null).";
    const n = Object.keys(q.criteria).length;
    if (n < 2) return "a choice needs at least two options.";
    if (n > MAX_CHOICE_OPTIONS) return `a choice accepts at most ${MAX_CHOICE_OPTIONS} options.`;
    return null;
  }
  if (q.type === "score") {
    if (!Array.isArray(q.criteria)) return "a score needs `criteria`: an ordered array of level descriptions.";
    if (q.criteria.length < MIN_SCORE_LEVELS || q.criteria.length > MAX_SCORE_LEVELS) return `a score needs ${MIN_SCORE_LEVELS}-${MAX_SCORE_LEVELS} levels.`;
    return null;
  }
  return '`type` must be "noul" (yes/no), "choice" (pick one option) or "score" (rate on a rubric).';
}

/** One evaluation. Retries rate-limit/overload responses with exponential backoff (the API asks for it)
 *  and honors `retry-after` when present. Never throws on a caller mistake without saying what to fix. */
export async function evaluateJev(input: {
  apiKey: string;
  model?: string;
  state: JevJson;
  questions: Record<string, JevQuestion>;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}): Promise<JevResult> {
  const problem = invalidJevQuestions(input.questions);
  if (problem) throw new JevError(problem);
  const body = JSON.stringify({ model: input.model?.trim() || JEV_DEFAULT_MODEL, state: input.state, questions: input.questions });
  if (body.length > MAX_REQUEST_CHARS) {
    throw new JevError(`The state plus questions is ${body.length.toLocaleString()} characters; Jev's context holds roughly ${MAX_REQUEST_CHARS.toLocaleString()}. Trim the state to what the questions need.`);
  }
  const doFetch = input.fetchImpl ?? fetch;
  const sleep = input.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  let lastError: JevError | undefined;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
    const signal = input.signal ? AbortSignal.any([input.signal, timeout]) : timeout;
    let res: Response;
    try {
      res = await doFetch(`${JEV_API_BASE}/v1/systemone`, {
        method: "POST",
        headers: { Authorization: `Bearer ${input.apiKey}`, "Content-Type": "application/json" },
        body,
        signal,
      });
    } catch (e) {
      if (input.signal?.aborted) throw new JevError("The Jev call was cancelled.");
      lastError = new JevError(`Could not reach the Jev API: ${e instanceof Error ? e.message : String(e)}`);
      if (attempt < MAX_ATTEMPTS) await sleep(backoffMs(attempt));
      continue;
    }
    if (res.ok) return parseResult(await res.json());
    const detail = await res.text().catch(() => "");
    lastError = new JevError(httpErrorText(res.status, detail), res.status);
    if (!RETRY_STATUSES.has(res.status) || attempt === MAX_ATTEMPTS) throw lastError;
    await sleep(retryAfterMs(res.headers.get("retry-after")) ?? backoffMs(attempt));
  }
  throw lastError ?? new JevError("The Jev call failed.");
}

function backoffMs(attempt: number): number {
  return Math.min(8_000, 500 * 2 ** (attempt - 1));
}

function retryAfterMs(header: string | null): number | undefined {
  if (!header) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(30_000, seconds * 1000);
  const at = Date.parse(header);
  return Number.isFinite(at) ? Math.max(0, Math.min(30_000, at - Date.now())) : undefined;
}

function httpErrorText(status: number, detail: string): string {
  const clipped = detail.trim().slice(0, 600);
  if (status === 401) return "Jev rejected the API key (401). Update the TypeSafe key in Settings.";
  if (status === 422) return `Jev rejected the request as malformed (422)${clipped ? `: ${clipped}` : ""}`;
  if (status === 429) return "Jev's rate limit was exceeded (429) after retries.";
  if (status === 529) return "Jev is overloaded (529) after retries.";
  return `Jev returned HTTP ${status}${clipped ? `: ${clipped}` : ""}`;
}

function parseResult(raw: unknown): JevResult {
  const v = raw as { model?: unknown; answers?: unknown; usage?: { input_tokens?: unknown; output_tokens?: unknown } };
  if (!v || typeof v !== "object" || !v.answers || typeof v.answers !== "object") throw new JevError("Jev returned a response without answers.");
  const inputTokens = Number(v.usage?.input_tokens ?? 0) || 0;
  return {
    model: typeof v.model === "string" ? v.model : JEV_DEFAULT_MODEL,
    answers: v.answers as Record<string, JevAnswer>,
    inputTokens,
    outputTokens: Number(v.usage?.output_tokens ?? 0) || 0,
    costUsd: inputTokens * JEV_USD_PER_INPUT_TOKEN,
  };
}

// ---- rendering: the one place an answer is turned into prose, for the feed and for the parent agent ----

function pct(p: number): string {
  return `${Math.round(p * 1000) / 10}%`;
}

function instructionText(q: JevQuestion): string {
  const i = q.instructions;
  if (typeof i === "string") return i;
  if (i && typeof i === "object" && !Array.isArray(i) && typeof (i as Record<string, JevJson>).question === "string") {
    return (i as Record<string, JevJson>).question as string;
  }
  return JSON.stringify(i);
}

/** One line per answer, e.g. `is_green (noul) — 98% yes`. */
export function jevAnswerLine(id: string, question: JevQuestion | undefined, answer: JevAnswer | undefined): string {
  if (!answer) return `- **${id}** — no answer returned`;
  const asked = question ? ` — _${instructionText(question).replace(/\s+/g, " ").slice(0, 200)}_` : "";
  if (answer.type === "noul") return `- **${id}** (yes/no): **${pct(answer.noul)} yes**${asked}`;
  if (answer.type === "choice") {
    const ranked = Object.entries(answer.probabilities ?? {})
      .sort((a, b) => b[1] - a[1])
      .slice(0, 4)
      .map(([k, p]) => `${k} ${pct(p)}`)
      .join(", ");
    return `- **${id}** (choice): **${answer.choice}** · confidence ${pct(answer.confidence)} · ${ranked}${asked}`;
  }
  const level = answer.legend?.[String(Math.round(answer.score))];
  return `- **${id}** (score): **${answer.score.toFixed(2)}**${level ? ` (≈ ${level})` : ""} · confidence ${pct(answer.confidence)}${asked}`;
}

/** Markdown for one evaluation, used both as the sub-task's feed row and as what the parent agent reads. */
export function formatJevEvaluation(e: { model: string; questions: Record<string, JevQuestion>; answers: Record<string, JevAnswer>; inputTokens: number; costUsd: number }): string {
  const lines = Object.keys(e.questions).map((id) => jevAnswerLine(id, e.questions[id], e.answers[id]));
  return [
    `**Jev answered** (${e.model} · ${e.inputTokens.toLocaleString()} input tokens · $${e.costUsd.toFixed(5)})`,
    "",
    ...lines,
  ].join("\n");
}
