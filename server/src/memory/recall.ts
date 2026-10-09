import type { SearchCandidate } from "./indexStore.js";
import { parseJsonObject, type MemoryModels, type ModelAnswer, type ModelFailure } from "./models.js";

// Retrieval is two stages: the worker's FTS5 index proposes candidates (cheap, local, no model), then
// Haiku — or Luna when no Claude subscription has room — reads those candidates and keeps the ones that
// actually bear on the query. The second stage is what replaces the old embedding similarity: it
// understands paraphrase, and unlike a cosine score it can answer "none of these", which is what keeps
// unrelated prompts from collecting a memory block every turn.

export type RecallMode = "prompt" | "session" | "search";

export interface RankedMemory extends SearchCandidate {
  /** How the memory was judged: by a model, or by lexical fallback. */
  judgedBy: "model" | "lexical";
}

export interface RecallResult {
  memories: RankedMemory[];
  /** Model that judged relevance, or null when the lexical fallback answered. */
  model: string | null;
  /** Why the model stage was skipped or failed, when it was. */
  fallbackReason: string | null;
  cached: boolean;
  ms: number;
}

const CANDIDATES: Record<RecallMode, number> = { prompt: 16, session: 16, search: 24 };
const EXCERPT_CHARS: Record<RecallMode, number> = { prompt: 420, session: 300, search: 420 };
const QUERY_CHARS = 2_400;
const CACHE_TTL_MS = 10 * 60_000;
const CACHE_MAX = 400;
/** Lexical fallback gate: share of query terms a memory must cover to be injected without a model. */
const LEXICAL_MIN_COVERAGE: Record<RecallMode, number> = { prompt: 0.5, session: 0.5, search: 0 };

const FALLBACK_REASON: Record<ModelFailure["failure"], string> = {
  busy: "model lane busy",
  "no-capacity": "no Haiku or Luna capacity",
  unusable: "model answer was unusable",
};

const INSTRUCTIONS: Record<RecallMode, string> = {
  prompt:
    "You select long-term memories for an AI coding agent. The agent is about to act on the message below. " +
    "Each candidate is a stored memory (a lesson, preference, decision, gotcha or reference). Pick only memories whose " +
    "specific content would change or materially inform how the agent handles THIS message. A shared word or a " +
    "generic overlap is not enough. Most messages need zero or one memory.",
  session:
    "You select long-term memories for an AI coding agent that is starting work in the directory described below. " +
    "Pick only memories that are specifically about this project, repository or directory: its conventions, " +
    "gotchas, services or state. General advice that merely mentions similar words does not qualify.",
  search:
    "You rank stored memories for a search. Order the candidates by how well each answers or relates to the query, " +
    "most relevant first. Include every candidate that is plausibly relevant and leave out the ones that are not.",
};

export class MemoryRecall {
  private readonly cache = new Map<string, { at: number; value: Omit<RecallResult, "cached" | "ms"> }>();
  private readonly inFlight = new Map<string, Promise<Omit<RecallResult, "cached" | "ms">>>();
  private revision = 0;

  constructor(
    private readonly candidates: (query: string, limit: number) => Promise<SearchCandidate[]>,
    private readonly models: MemoryModels | null,
    private readonly modelsEnabled: () => boolean,
  ) {}

  async recall(query: string, mode: RecallMode, limit: number, timeoutMs: number): Promise<RecallResult> {
    const started = Date.now();
    const text = query.trim().slice(0, QUERY_CHARS);
    const key = `${mode}|${limit}|${text}`;
    const hit = this.cache.get(key);
    if (hit && Date.now() - hit.at < CACHE_TTL_MS) return { ...hit.value, cached: true, ms: Date.now() - started };
    // A run prefetches its kickoff's recall while the CLI boots; the hook asking the same question joins it.
    const pending = this.inFlight.get(key);
    if (pending) return { ...(await pending), cached: true, ms: Date.now() - started };
    const work = this.answer(key, text, mode, limit, timeoutMs, started);
    this.inFlight.set(key, work);
    try {
      return { ...(await work), cached: false, ms: Date.now() - started };
    } finally {
      if (this.inFlight.get(key) === work) this.inFlight.delete(key);
    }
  }

  private async answer(key: string, text: string, mode: RecallMode, limit: number, timeoutMs: number, started: number): Promise<Omit<RecallResult, "cached" | "ms">> {
    const revision = this.revision;
    const pool = await this.candidates(text, Math.max(limit, CANDIDATES[mode]));
    const value = await this.judge(text, mode, limit, pool, timeoutMs - (Date.now() - started));
    if (value.model && revision === this.revision) this.remember(key, value);
    return value;
  }

  clearCache(): void {
    this.revision++;
    this.cache.clear();
    this.inFlight.clear();
  }

  private async judge(query: string, mode: RecallMode, limit: number, pool: SearchCandidate[], budgetMs: number): Promise<Omit<RecallResult, "cached" | "ms">> {
    if (!pool.length) return { memories: [], model: null, fallbackReason: null };
    const lexical = (reason: string) => ({ memories: lexicalPick(pool, mode, limit), model: null, fallbackReason: reason });
    if (!this.models || !this.modelsEnabled()) return lexical("model ranking is turned off");
    if (budgetMs < 1_500) return lexical("no time left for a model call");
    const shown = pool.slice(0, CANDIDATES[mode]);
    const answer = await this.models.complete({
      system: `${INSTRUCTIONS[mode]}\n\nReply with JSON only: {"ids":[...]} listing at most ${limit} candidate ids, best first. Use [] when none qualify. Never invent ids.`,
      user: renderCandidates(query, mode, shown),
      maxTokens: 120,
      purpose: mode === "search" ? "search" : "recall",
      lane: "interactive",
      timeoutMs: budgetMs,
      accept: (reply) => parseIds(reply, shown.length) != null,
    });
    if ("failure" in answer) return lexical(FALLBACK_REASON[answer.failure]);
    return { memories: modelPick(answer, shown, pool, mode, limit), model: answer.model, fallbackReason: null };
  }

  private remember(key: string, value: Omit<RecallResult, "cached" | "ms">): void {
    if (this.cache.size >= CACHE_MAX) {
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) this.cache.delete(oldest);
    }
    this.cache.set(key, { at: Date.now(), value });
  }
}

function renderCandidates(query: string, mode: RecallMode, shown: SearchCandidate[]): string {
  const label = mode === "session" ? "Directory" : mode === "search" ? "Query" : "Message";
  const lines = [`${label}:\n${query}`, "", "Candidates:"];
  shown.forEach((candidate, i) => {
    const excerpt = candidate.excerpt.replace(/\s+/g, " ").slice(0, EXCERPT_CHARS[mode]);
    lines.push(`[${i + 1}] ${candidate.name} — ${candidate.description}${excerpt ? `\n    ${excerpt}` : ""}`);
  });
  return lines.join("\n");
}

/** The model's chosen candidate numbers (1-based), or null when the reply is not usable. */
export function parseIds(reply: string, count: number): number[] | null {
  const parsed = parseJsonObject(reply);
  if (!parsed || !Array.isArray(parsed.ids)) return null;
  const ids: number[] = [];
  for (const raw of parsed.ids) {
    const n = typeof raw === "number" ? raw : Number(String(raw).replace(/[^\d]/g, ""));
    if (Number.isInteger(n) && n >= 1 && n <= count && !ids.includes(n)) ids.push(n);
  }
  return ids;
}

function modelPick(answer: ModelAnswer, shown: SearchCandidate[], pool: SearchCandidate[], mode: RecallMode, limit: number): RankedMemory[] {
  const picked = (parseIds(answer.text, shown.length) ?? []).map((n) => ({ ...shown[n - 1]!, judgedBy: "model" as const }));
  if (mode !== "search") {
    // A trigger phrase is the author's explicit "summon me for this" and outranks the model's judgement.
    const declared = pool.filter((candidate) => candidate.triggerHit).map((candidate) => ({ ...candidate, judgedBy: "lexical" as const }));
    const seen = new Set<string>();
    return [...declared, ...picked].filter((memory) => !seen.has(memory.file) && !!seen.add(memory.file)).slice(0, limit);
  }
  // A search lists the model's picks first, then the remaining lexical matches, so nothing the index
  // found is hidden from someone browsing.
  const chosen = new Set(picked.map((memory) => memory.file));
  const rest = pool.filter((candidate) => !chosen.has(candidate.file)).map((candidate) => ({ ...candidate, judgedBy: "lexical" as const }));
  return [...picked, ...rest].slice(0, limit);
}

function lexicalPick(pool: SearchCandidate[], mode: RecallMode, limit: number): RankedMemory[] {
  const minimum = LEXICAL_MIN_COVERAGE[mode];
  return pool
    .filter((candidate) => mode === "search" || candidate.triggerHit || candidate.coverage >= minimum)
    .slice(0, limit)
    .map((candidate) => ({ ...candidate, judgedBy: "lexical" as const }));
}
