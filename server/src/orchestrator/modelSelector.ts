import { currentCodexModel } from "../agents/codexModelGeneration.js";
// Auto model selection: ONE cheap judgement call, made just before the implementor starts, that picks
// which model implements this task and how hard it should think.
//
// It runs on the DIRECTOR's model over the same raw OAuth fetch the titler and the resume compressor
// use (a subscription token, no metered API key) — not as an agent role: it has no tools, no office, no
// turns. Everything it needs to judge is already on hand by the time it runs — the brief, and the plan
// the planner produced after reading the actual repo — plus two things only the orchestrator knows: which
// models are dispatchable at this instant, and how earlier auto-picked tasks actually turned out.
//
// Contract: best-effort. Any failure (no token, network, unparseable reply, a model id that isn't on the
// roster) returns null and the caller falls back to normal usage-based routing — a dispatch is never
// blocked by this, and a hallucinated model id never reaches a spawn.

import { EFFORTS, type Effort, type ImplementorProvider, type ModelEffortStat, type ModelPick, type ModelStat } from "../types.js";
import { isPolicyApprovedFlagship } from "./modelRoutingPolicy.js";
import { claudeOpusVersion, isRetiredClaudeOpus } from "./claudeOpusFloor.js";

const SELECTOR_TIMEOUT_MS = 45_000;
const MAX_OUTPUT_TOKENS = 300;
const BRIEF_CHARS = 4000;
const PLAN_CHARS = 3000;
const MAX_REASON_CHARS = 200;
/**
 * An owner-facing reason that claims the pick AVOIDS frontier spend, matched only where it is a
 * negation of "frontier". The reported defect was Astra — the single most expensive model on the
 * roster — being announced as chosen "without needing frontier spend"; the prompt instruction alone
 * left that at the mercy of one free-form JSON string, so this is the deterministic half.
 *
 * Every alternative is an explicit negation/avoidance, and the small word windows let normal phrasing
 * sit between it and "frontier" ("does not REQUIRE frontier spend", "no NEED for frontier spend")
 * without reaching across punctuation into a legitimate justification. A reason that argues FOR the
 * spend ("frontier-tier spend is justified by the migration risk", "needs frontier capacity") carries
 * no negation and is deliberately left untouched — the selector is instructed to write exactly that,
 * and rewriting it would destroy the evidence the owner needs.
 *
 * Deliberately NOT global: `scrubFrontierAvoidance` uses `.test()`/`.exec()` per clause, and a /g regex
 * carries `lastIndex` between calls, which would make every second check skip the start of its string.
 */
const FRONTIER_AVOIDANCE_CLAIM =
  /\b(?:(?:do(?:es)?|did|will|would|can|could)\s+not\s+(?:(?:need|require)\s+(?:to\s+(?:use|spend)\s+)?|(?:\w+\s+){0,2})|\w+n['’]t\s+(?:(?:need|require)\s+(?:to\s+(?:use|spend)\s+)?|(?:\w+\s+){0,2})|without\s+(?:\w+\s+){0,2}|no\s+(?:(?:need|reason)\s+(?:for\s+|to\s+(?:use|spend)\s+)?)?|not\s+(?:(?:worth|using|needing|requiring|spending)\s+)?|(?:\w+\s+enough\s+to\s+)?avoid(?:s|ing)?\s+|(?:\w+\s+enough\s+to\s+)?skip(?:s|ping)?\s+|instead\s+of\s+|rather\s+than\s+|away\s+from\s+|(?:keep(?:s|ing)?\s+(?:\w+\s+){0,3})?off\s+)(?:a\s+|the\s+|any\s+)?frontier(?:[-\s]?tier)?(?:\s+(?:spend|costs?|model|capacity|tokens?|run|route|tier|budget))?\b/i;
const CODEX_CLI_BRIDGE_NOTE = "separate CLI with no interactive bus tools, but text bridges preserve office chat, owner notes, and deliverables";

type Block = { type?: string; text?: string };

/** One dispatchable (provider, model) pair the selector may choose, with a factual note on what it is. */
export interface ModelCandidate {
  provider: ImplementorProvider;
  model: string;
  note: string;
  /** Exact effort tiers this model/backend can accept under the operator's configured ceiling. */
  efforts: Effort[];
  /** Live quota/runway facts for the pool this exact model would consume. */
  capacity?: string;
}

export interface SelectionContext {
  title: string;
  workspace: string;
  brief: string;
  /** The planner's own words about this task — its summary, steps (with files) and risks. */
  planText?: string;
  /** Deterministic task-route capability floor. When present, it outranks cheapest-capable/history. */
  policyText?: string;
  candidates: ModelCandidate[];
  efforts: Effort[];
  repoStats: ModelStat[]; // how auto-picked tasks scored in THIS repo
  globalStats: ModelStat[]; // …and everywhere
  repoEffortStats?: ModelEffortStat[];
  globalEffortStats?: ModelEffortStat[];
}

const PROVIDER_LABEL: Record<ImplementorProvider, string> = {
  claude: "Anthropic Claude",
  codex: "OpenAI Codex CLI",
  grok: "xAI Grok CLI",
  zai: "z.ai GLM",
};

/**
 * A short, factual note on what a model is, keyed off its family. This exists because a model id alone
 * ("glm-5.1", "gpt-5.6-sol") tells the selector nothing about cost or capability, and a selector guessing
 * at that is exactly the failure this feature is supposed to fix. Kept descriptive — the historical
 * scoreboard, not this line, is what should move the decision once there is any history.
 */
export function modelNote(provider: ImplementorProvider, model: string): string {
  const id = model.trim().toLowerCase();
  if (provider === "codex") return codexModelNote(id);
  if (provider === "grok") return "capable generalist, frontier-tier reasoning; separate CLI with no interactive bus tools, but text bridges preserve office chat, owner notes, and deliverables";
  if (provider === "zai") return "GLM coding-plan model on an Anthropic-compatible endpoint — keeps every tool a Claude run has; solid mid-tier coder";
  if (id.includes("haiku")) return "fastest and cheapest; well suited to small, well-scoped, mechanical changes";
  if (id.includes("sonnet")) return "balanced cost and capability; the workhorse for ordinary feature work and refactors";
  if (id.includes("fable")) return "frontier reasoning, drawn from its own separate limited allowance — worth spending on genuinely hard work";
  if (id.includes("opus")) return "the strongest Claude tier; multi-file features, subtle debugging, long-horizon work";
  return "general-purpose coding model";
}

function codexModelNote(id: string): string {
  if (/^gpt-6-sol(?:[-.]|$)/i.test(id)) return `GPT-6 workhorse for complex coding and agentic workflows below Astra; ${CODEX_CLI_BRIDGE_NOTE}`;
  if (/^gpt-6-luna(?:[-.]|$)/i.test(id)) return `budget GPT-6 tier for focused and high-volume work; prefer the smallest confident effort; ${CODEX_CLI_BRIDGE_NOTE}`;
  if (/^gpt-6-astra(?:[-.]|$)/i.test(id)) return `highest-cost Codex frontier-tier model; reserve for work that truly needs maximum autonomous reasoning and justify the spend; ${CODEX_CLI_BRIDGE_NOTE}`;
  if (/^gpt-5\.6-sol(?:[-.]|$)/i.test(id)) return `premium GPT-5.6 Codex tier; strong autonomous coding below Astra, suited to high-uncertainty implementation when Terra/Luna are too small; ${CODEX_CLI_BRIDGE_NOTE}`;
  if (/^gpt-5\.6-terra(?:[-.]|$)/i.test(id)) return `balanced GPT-5.6 Codex workhorse; cheaper than Sol/Astra and suitable for ordinary multi-file implementation at the smallest confident effort; ${CODEX_CLI_BRIDGE_NOTE}`;
  if (/^gpt-5\.6-luna(?:[-.]|$)/i.test(id)) return `budget GPT-5.6 Codex tier; low/medium effort should usually beat legacy GPT-5.5/5.4 on both quality and cost for small or mechanical work; ${CODEX_CLI_BRIDGE_NOTE}`;
  if (isLegacyCodexId(id)) return `older/non-GPT-5.6 Codex tier; automatic routing should use it only when no GPT-5.6+ Codex option is dispatchable and should avoid extra-high spend; ${CODEX_CLI_BRIDGE_NOTE}`;
  return `Codex CLI coding model; compare exact outcomes and token-window burn before spending high effort; ${CODEX_CLI_BRIDGE_NOTE}`;
}

function codexGpt5Minor(model: string): number | null {
  const match = /^gpt-5\.(\d+)(?:[-.]|$)/i.exec(model.trim());
  return match ? Number(match[1]) : null;
}

function isPreferredCodexId(model: string): boolean {
  const id = model.trim();
  return /^gpt-6(?:[-.]|$)/i.test(id) || (codexGpt5Minor(id) ?? 0) >= 6 || /^gpt-daybreak-blue-latest(?:[-.]|$)/i.test(id);
}

function isLegacyCodexId(model: string): boolean {
  const id = model.trim().toLowerCase();
  if (isPreferredCodexId(id)) return false;
  const gpt = /^gpt-(\d+)(?:\.(\d+))?(?:[-.]|[a-z]|$)/i.exec(id);
  if (gpt) {
    const major = Number(gpt[1]);
    const minor = gpt[2] == null ? null : Number(gpt[2]);
    return major < 5 || (major === 5 && (minor == null || minor < 6));
  }
  return /^o\d/i.test(id) || /^codex(?:[-.]|$)/i.test(id);
}

export function isPreferredCodexAutoModel(candidate: Pick<ModelCandidate, "provider" | "model">): boolean {
  if (candidate.provider !== "codex") return false;
  return isPreferredCodexId(candidate.model);
}

export function isLegacyCodexAutoModel(candidate: Pick<ModelCandidate, "provider" | "model">): boolean {
  if (candidate.provider !== "codex") return false;
  return isLegacyCodexId(candidate.model);
}

/** A Claude Opus older than the version floor — the same shape as a legacy Codex id, on the other
 *  backend. Non-Opus Claude models (Sonnet, Fable, Haiku) are cheaper tiers, not outdated flagships,
 *  and stay selectable. */
export function isRetiredClaudeAutoModel(candidate: Pick<ModelCandidate, "provider" | "model">): boolean {
  return candidate.provider === "claude" && isRetiredClaudeOpus(candidate.model);
}

function isCurrentClaudeOpusAutoModel(candidate: Pick<ModelCandidate, "provider" | "model">): boolean {
  if (candidate.provider !== "claude") return false;
  const version = claudeOpusVersion(candidate.model);
  return version !== null && !isRetiredClaudeOpus(candidate.model);
}

export function filterAutoSelectionCandidates<T extends Pick<ModelCandidate, "provider" | "model">>(candidates: readonly T[]): T[] {
  const preferredCodexAvailable = candidates.some(isPreferredCodexAutoModel);
  // Each backend's floor is gated on ITS own current option being dispatchable: a roster that offers
  // only the retired tier must stay selectable rather than removing the backend from the choice.
  const currentOpusAvailable = candidates.some(isCurrentClaudeOpusAutoModel);
  return candidates.filter((candidate) => {
    if (candidate.provider === "codex" && currentCodexModel(candidate.model) !== candidate.model.trim()) return false;
    if (preferredCodexAvailable && isLegacyCodexAutoModel(candidate)) return false;
    return !currentOpusAvailable || !isRetiredClaudeAutoModel(candidate);
  });
}

export function autoSelectableEffortsForCandidate(
  candidate: Pick<ModelCandidate, "provider" | "model">,
  efforts: readonly Effort[],
): Effort[] {
  if (!isLegacyCodexAutoModel(candidate)) return [...efforts];
  const capped = efforts.filter((effort) => EFFORTS.indexOf(effort) <= EFFORTS.indexOf("high"));
  return capped.length ? capped : [...efforts];
}

function isFrontierTierCandidate(candidate: ModelCandidate): boolean {
  return isPolicyApprovedFlagship(candidate) || /\bfrontier(?:[-\s]?tier| reasoning)\b/i.test(candidate.note);
}

/** What replaces a scrubbed claim. A whole sentence, because the scrub removes whole clauses. */
const FRONTIER_DELIBERATE_NOTE = "Frontier-tier capacity chosen deliberately.";
/** A trailing word the offending clause was leading INTO — keeping it strands a dangling connective. */
const DANGLING_TAIL =
  /(?:\b(?:and|or|but|so|yet|while|because|since|although|though|whereas|that|which|who|to|for|of|in|on|at|by|with|from|as|than|then|thus|is|are|was|were|be|being|been|it|this|these|those|the|a|an|its|our|we|I)\b|[,;:\-–—]+)\s*$/i;

/**
 * Remove an owner-facing claim that a frontier-tier pick avoids frontier spend, at CLAUSE level.
 *
 * The first shape of this guard spliced a replacement phrase in place of the matched words, which is
 * not a safe edit on free-form prose: it shipped "picked to using frontier-tier capacity deliberately
 * while keeping quality", "This using frontier-tier capacity deliberately." and "Handles this using
 * frontier-tier capacity deliberately costs." into the same owner-facing finding the reported bug was
 * about. A clause either makes the contradictory claim or it does not, so the only edit guaranteed to
 * stay grammatical is to drop the claim and everything it governs, keep whatever full clause preceded
 * it, and state the honest fact in one appended sentence.
 */
function scrubFrontierAvoidance(reason: string): string {
  // Sentence/semicolon boundaries only. A comma-level split shreds ordinary lists ("scheduler, UI,
  // process control"); a decimal model id ("gpt-5.6") is safe because a boundary needs trailing space.
  const clauses = reason.split(/(?<=[.!?;])\s+|;\s*/).map((c) => c.trim()).filter(Boolean);
  let scrubbed = false;
  const kept: string[] = [];
  for (const clause of clauses) {
    const hit = FRONTIER_AVOIDANCE_CLAIM.exec(clause);
    if (!hit) {
      kept.push(clause);
      continue;
    }
    scrubbed = true;
    // Keep the clause's prefix only when it still reads as a statement on its own: everything AFTER the
    // claim was governed by it ("… frontier spend WHILE KEEPING QUALITY") and cannot be salvaged.
    // Repeat until stable: a run-up to the claim strands several at once (", and it does not need …").
    let prefix = clause.slice(0, hit.index).trim();
    for (let next = prefix.replace(DANGLING_TAIL, "").trim(); next !== prefix; next = prefix.replace(DANGLING_TAIL, "").trim()) prefix = next;
    if (prefix.split(/\s+/).filter(Boolean).length >= 3) kept.push(prefix);
  }
  if (!scrubbed) return reason;
  // Re-punctuate rather than re-join the originals: two surviving SENTENCES would otherwise read
  // "Alpha.; Beta." One terminal stop is added once, at the end, below.
  const body = kept.map((c) => c.replace(/[\s.,;:!?]+$/, "")).filter(Boolean).join("; ");
  if (!body) return FRONTIER_DELIBERATE_NOTE;
  const sentence = /[.!?]$/.test(body) ? body : `${body}.`;
  const room = MAX_REASON_CHARS - FRONTIER_DELIBERATE_NOTE.length - 1;
  return `${sentence.length > room ? clampWords(sentence, room) : sentence} ${FRONTIER_DELIBERATE_NOTE}`;
}

/** Cut at a word boundary so the appended sentence never lands after half a word. */
function clampWords(text: string, max: number): string {
  const cut = text.slice(0, max);
  const space = cut.lastIndexOf(" ");
  return `${(space > 0 ? cut.slice(0, space) : cut).replace(/[\s,;:.]+$/, "")}.`;
}

function sanitizeReason(reason: string, candidate: ModelCandidate): string {
  const normalized = reason.trim().replace(/\s+/g, " ");
  if (!normalized) return "";
  const safe = isFrontierTierCandidate(candidate) ? scrubFrontierAvoidance(normalized) : normalized;
  return safe.slice(0, MAX_REASON_CHARS);
}

export function defaultCandidateEffort(candidate: Pick<ModelCandidate, "efforts">): Effort {
  if (candidate.efforts.includes("high")) return "high";
  for (let i = EFFORTS.length - 1; i >= 0; i--) {
    const effort = EFFORTS[i]!;
    if (candidate.efforts.includes(effort)) return effort;
  }
  return "high";
}

function clip(s: string, n: number): string {
  const t = (s ?? "").trim();
  return t.length > n ? `${t.slice(0, n)}\n…[clipped]` : t;
}

function statLine(s: ModelStat): string {
  const burn = s.avgTotalTokens == null
    ? `token burn unknown (${Math.round(s.tokenSampleRate * 100)}% complete telemetry)`
    : `${formatTokens(s.avgTotalTokens)} tokens (${formatTokens(s.avgOutputTokens ?? 0)} output, ${formatTokens(s.avgCacheTokens ?? 0)} cache; ${Math.round(s.tokenSampleRate * 100)}% complete telemetry)`;
  return `- ${s.model} — ${s.picks} task${s.picks === 1 ? "" : "s"}, avg score ${s.avgScore}, ${Math.round(s.doneRate * 100)}% accepted, ${s.avgQaRounds} QA rounds, $${s.avgCostUsd.toFixed(2)}, ${burn}, ${s.avgMinutes} min`;
}

function effortStatLine(s: ModelEffortStat): string {
  return `${statLine(s).replace(`- ${s.model}`, `- ${s.model} @ ${s.effort}`)}`;
}

function formatTokens(n: number): string {
  return new Intl.NumberFormat("en", { notation: n >= 10_000 ? "compact" : "standard", maximumFractionDigits: 1 }).format(n);
}

function statBlock(stats: ModelStat[], emptyNote: string): string {
  return stats.length ? stats.map(statLine).join("\n") : emptyNote;
}

/** The whole prompt, built as one message. Exported so a gate can assert its content without a network call. */
export function buildSelectionPrompt(ctx: SelectionContext): string {
  const roster = ctx.candidates
    .map((c) => `- ${c.model} — ${PROVIDER_LABEL[c.provider]} — effort ${c.efforts.join(" | ")}: ${c.note}${c.capacity ? `\n  Live capacity: ${c.capacity}` : ""}`)
    .join("\n");
  return [
    "You are choosing which AI coding model will IMPLEMENT one task in an autonomous pipeline, and how hard it should think.",
    "",
    "Honor any mandatory task route policy first. Within the eligible roster, pick the CHEAPEST option you are confident can finish this job unattended. Cost means BOTH dollars and subscription/token-window burn: a $0 subscription run can still waste scarce allowance. Both mistakes are real: too weak and the work bounces through QA fix-rounds or lands on a human, which costs far more than the stronger model would have; too strong or too-high effort and limited tokens are spent on work a smaller/shallower choice would have nailed. Judge the work in front of you — its size, how many files and systems it spans, how much of it is mechanical versus genuinely uncertain.",
    "Live capacity is a hard operational constraint, not a benchmark: prefer a pool with enough stated runway for the whole task. Do not put substantial work on an at-risk pool when a viable pool is listed. A reset inside the expected task duration is already accounted for in the runway note.",
    "Candidate notes may include a daily cached LiveBench score. Treat it as a secondary capability prior: exact-model evidence is stronger than an explicitly labelled older-family prior; this orchestrator's own task outcomes are more relevant to autonomous reliability. Use category scores that fit THIS task, and use benchmarked effort variants to choose the smallest reasoning effort that preserves quality.",
    "",
    "## The task",
    `Repository: ${ctx.workspace}`,
    `Title: ${ctx.title}`,
    "",
    clip(ctx.brief, BRIEF_CHARS),
    ...(ctx.planText ? ["", "## What the planner found after reading this repository", "", clip(ctx.planText, PLAN_CHARS)] : []),
    ...(ctx.policyText ? ["", "## Mandatory task route policy", "", ctx.policyText] : []),
    "",
    "## Models that can be dispatched right now (nothing else is available)",
    roster,
    "",
    "## Effort levels",
    `${ctx.efforts.join(" | ")} — how much reasoning the model spends per turn. Each model's exact available subset is shown beside it above; choose only a tier listed for the model you pick.`,
    "",
    "## How earlier auto-picked tasks actually scored",
    "100 = accepted with no human involvement; 40 = the task ended up needing a human; each QA fix-round past the first costs 12 more. Dollars, tokens, turns and time cover the WHOLE pipeline, so a cheap model that needed three QA rounds reads as expensive here. Prefer this evidence over your priors about these models. Never treat $0 as free when token burn is known.",
    "",
    "### In this repository",
    statBlock(ctx.repoStats, "(no graded tasks in this repository yet)"),
    "",
    "### Across all repositories",
    statBlock(ctx.globalStats, "(no graded tasks yet — judge from the task itself)"),
    "",
    "### Model + effort outcomes in this repository",
    ctx.repoEffortStats?.length ? ctx.repoEffortStats.map(effortStatLine).join("\n") : "(no effort-specific history in this repository yet)",
    "",
    "### Model + effort outcomes across all repositories",
    ctx.globalEffortStats?.length ? ctx.globalEffortStats.map(effortStatLine).join("\n") : "(no effort-specific history yet)",
    "",
    "If you pick a candidate described as frontier-tier or frontier reasoning, the reason must say why that spend is justified. Never say that pick avoids, skips, or does not need frontier spend.",
    "",
    "Reply with ONE JSON object and nothing else:",
    `{"model": "<exact id from the list above>", "effort": "${ctx.efforts.join("|")}", "reason": "<20 words or fewer: why this model for this task>"}`,
  ].join("\n");
}

const RETRY_SUFFIX =
  "\n\nYour previous reply could not be used. Answer with a single JSON object and no other text, and the `model` value must be copied EXACTLY from the list of models that can be dispatched right now.";

/** Pull the first balanced JSON object out of a reply that may be fenced or prefaced with prose. */
function extractJsonObject(text: string): unknown {
  const start = text.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    if (text[i] === "{") depth++;
    else if (text[i] === "}" && --depth === 0) {
      try {
        return JSON.parse(text.slice(start, i + 1));
      } catch {
        return null;
      }
    }
  }
  return null;
}

/**
 * Validate a raw reply into a pick, or null. The model id must match the roster EXACTLY (case- and
 * whitespace-insensitively) — the provider comes from the matched roster entry, never from the reply, so
 * a model that names the wrong backend can't route a task to a CLI that has no such model. An
 * unrecognized or model-incompatible effort degrades to that candidate's `high` tier rather than
 * voiding an otherwise good pick. Every implementor backend supports high, so the fallback is safe.
 */
export function parseSelection(text: string, ctx: Pick<SelectionContext, "candidates" | "efforts">): ModelPick | null {
  const obj = extractJsonObject(text);
  if (!obj || typeof obj !== "object") return null;
  const raw = obj as { model?: unknown; effort?: unknown; reason?: unknown };
  if (typeof raw.model !== "string") return null;
  const wanted = raw.model.trim().toLowerCase();
  const candidate = ctx.candidates.find((c) => c.model.toLowerCase() === wanted);
  if (!candidate) return null;
  const selectableEfforts = autoSelectableEffortsForCandidate(candidate, candidate.efforts);
  const requested = String(raw.effort ?? "").trim().toLowerCase();
  const effort = selectableEfforts.find((e) => e === requested) ?? defaultCandidateEffort({ efforts: selectableEfforts });
  const reason = typeof raw.reason === "string" ? sanitizeReason(raw.reason, candidate) : "";
  return { provider: candidate.provider, model: candidate.model, effort, reason };
}

async function ask(prompt: string, token: string, model: string): Promise<string | null> {
  const body = JSON.stringify({ model, max_tokens: MAX_OUTPUT_TOKENS, messages: [{ role: "user", content: prompt }] });
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
        signal: AbortSignal.timeout(SELECTOR_TIMEOUT_MS),
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

/**
 * Pick the implementor model for one task, or null to leave normal routing in charge. One call, one
 * corrective retry when the reply can't be used (a reply naming a model that isn't on the roster is the
 * realistic failure, and a model told plainly to copy an id usually complies). Never throws.
 */
export async function selectImplementorModel(
  ctx: SelectionContext,
  token: string | undefined,
  selectorModel: string,
): Promise<ModelPick | null> {
  if (!token || ctx.candidates.length === 0) return null;
  // One dispatchable model = nothing to choose; skip the call rather than pay for a foregone conclusion.
  if (ctx.candidates.length === 1) {
    const only = ctx.candidates[0]!;
    return { provider: only.provider, model: only.model, effort: defaultCandidateEffort(only), reason: "only dispatchable model" };
  }
  const prompt = buildSelectionPrompt(ctx);
  const first = await ask(prompt, token, selectorModel).catch(() => null);
  const pick = first ? parseSelection(first, ctx) : null;
  if (pick) return pick;
  const retry = await ask(prompt + RETRY_SUFFIX, token, selectorModel).catch(() => null);
  return retry ? parseSelection(retry, ctx) : null;
}
