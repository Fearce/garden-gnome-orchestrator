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

import type { Effort, ImplementorProvider, ModelEffortStat, ModelPick, ModelStat } from "../types.js";

const SELECTOR_TIMEOUT_MS = 45_000;
const MAX_OUTPUT_TOKENS = 300;
const BRIEF_CHARS = 4000;
const PLAN_CHARS = 3000;
const MAX_REASON_CHARS = 200;

type Block = { type?: string; text?: string };

/** One dispatchable (provider, model) pair the selector may choose, with a factual note on what it is. */
export interface ModelCandidate {
  provider: ImplementorProvider;
  model: string;
  note: string;
}

export interface SelectionContext {
  title: string;
  workspace: string;
  brief: string;
  /** The planner's own words about this task — its summary, steps (with files) and risks. */
  planText?: string;
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
 * ("glm-4.6", "gpt-5.6-sol") tells the selector nothing about cost or capability, and a selector guessing
 * at that is exactly the failure this feature is supposed to fix. Kept descriptive — the historical
 * scoreboard, not this line, is what should move the decision once there is any history.
 */
export function modelNote(provider: ImplementorProvider, model: string): string {
  const id = model.toLowerCase();
  if (provider === "codex") return "strong autonomous coder; runs as a separate CLI with no bus tools (it cannot post findings or deliverables)";
  if (provider === "grok") return "capable generalist; runs as a separate CLI with no bus tools (it cannot post findings or deliverables)";
  if (provider === "zai") return "GLM coding-plan model on an Anthropic-compatible endpoint — keeps every tool a Claude run has; solid mid-tier coder";
  if (id.includes("haiku")) return "fastest and cheapest; well suited to small, well-scoped, mechanical changes";
  if (id.includes("sonnet")) return "balanced cost and capability; the workhorse for ordinary feature work and refactors";
  if (id.includes("fable")) return "frontier reasoning, drawn from its own separate limited allowance — worth spending on genuinely hard work";
  if (id.includes("opus")) return "the strongest Claude tier; multi-file features, subtle debugging, long-horizon work";
  return "general-purpose coding model";
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
  const roster = ctx.candidates.map((c) => `- ${c.model} — ${PROVIDER_LABEL[c.provider]}: ${c.note}`).join("\n");
  return [
    "You are choosing which AI coding model will IMPLEMENT one task in an autonomous pipeline, and how hard it should think.",
    "",
    "Pick the CHEAPEST option you are confident can finish this job unattended. Cost means BOTH dollars and subscription/token-window burn: a $0 subscription run can still waste scarce allowance. Both mistakes are real: too weak and the work bounces through QA fix-rounds or lands on a human, which costs far more than the stronger model would have; too strong or too-high effort and limited tokens are spent on work a smaller/shallower choice would have nailed. Judge the work in front of you — its size, how many files and systems it spans, how much of it is mechanical versus genuinely uncertain.",
    "Candidate notes may include a daily cached LiveBench score. Treat it as a secondary capability prior: exact-model evidence is stronger than an explicitly labelled older-family prior; this orchestrator's own task outcomes are more relevant to autonomous reliability. Use category scores that fit THIS task, and use benchmarked effort variants to choose the smallest reasoning effort that preserves quality.",
    "",
    "## The task",
    `Repository: ${ctx.workspace}`,
    `Title: ${ctx.title}`,
    "",
    clip(ctx.brief, BRIEF_CHARS),
    ...(ctx.planText ? ["", "## What the planner found after reading this repository", "", clip(ctx.planText, PLAN_CHARS)] : []),
    "",
    "## Models that can be dispatched right now (nothing else is available)",
    roster,
    "",
    "## Effort levels",
    `${ctx.efforts.join(" | ")} — how much reasoning the model spends per turn. Each backend's own ceiling is applied automatically, so ask for what the task deserves.`,
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
 * unrecognized effort degrades to `high` rather than voiding an otherwise good pick.
 */
export function parseSelection(text: string, ctx: Pick<SelectionContext, "candidates" | "efforts">): ModelPick | null {
  const obj = extractJsonObject(text);
  if (!obj || typeof obj !== "object") return null;
  const raw = obj as { model?: unknown; effort?: unknown; reason?: unknown };
  if (typeof raw.model !== "string") return null;
  const wanted = raw.model.trim().toLowerCase();
  const candidate = ctx.candidates.find((c) => c.model.toLowerCase() === wanted);
  if (!candidate) return null;
  const effort = ctx.efforts.find((e) => e === String(raw.effort ?? "").trim().toLowerCase()) ?? "high";
  const reason = typeof raw.reason === "string" ? raw.reason.trim().replace(/\s+/g, " ").slice(0, MAX_REASON_CHARS) : "";
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
    return { provider: only.provider, model: only.model, effort: "high", reason: "only dispatchable model" };
  }
  const prompt = buildSelectionPrompt(ctx);
  const first = await ask(prompt, token, selectorModel).catch(() => null);
  const pick = first ? parseSelection(first, ctx) : null;
  if (pick) return pick;
  const retry = await ask(prompt + RETRY_SUFFIX, token, selectorModel).catch(() => null);
  return retry ? parseSelection(retry, ctx) : null;
}
