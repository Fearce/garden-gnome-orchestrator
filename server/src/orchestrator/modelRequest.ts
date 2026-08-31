import type { ImplementorProvider, ModelRequest } from "../types.js";

/** One model the running installation actually knows how to address. Labels carry provider-native
 * human names (for example the rate-limit pool name) without making those names model ids. */
export interface ModelRequestCandidate {
  provider: ImplementorProvider;
  model: string;
  labels?: readonly string[];
}

const GENERIC_TOKENS = new Set([
  "the", "our", "model", "capacity", "usage", "allowance", "pool", "provider", "openai",
  "anthropic", "xai", "zai", "gpt", "codex", "claude", "glm",
]);

const PROVIDER_HINTS: Array<[ImplementorProvider, RegExp]> = [
  ["codex", /\b(?:gpt|codex|openai|spark|sol|terra|luna|daybreak)\b/i],
  ["claude", /\b(?:claude|anthropic|opus|sonnet|haiku|fable)\b/i],
  ["grok", /\b(?:grok|xai|x\.ai)\b/i],
  ["zai", /\b(?:z\.?ai|glm)\b/i],
];

/** Conservative legacy fallback. New Director bridges send `model` explicitly. This only recognizes
 * a direct owner-style command at the start of a sentence, so a task *about* phrases such as
 * "use GPT Spark" does not accidentally pin its own implementor. */
const DIRECTIVE = /^(?:please\s+)?(?:(?:can|could|would)\s+you\s+(?:please\s+)?(?:use|run|route|dispatch|select|choose)|(?:use|prefer|run|route|dispatch|select|choose|pick|allocate|spend)|(?:this|the)\s+(?:task|work|implementor|agent)\b[^.!?;\n]{0,40}\b(?:must|should|needs?\s+to)\s+(?:use|run))\b/i;
const PROVIDER_FIRST_DIRECTIVE = /\b(?:is|remains|must\s+be|should\s+be)\s+(?:strictly\s+|explicitly\s+)?(?:required|preferred|selected|used)\b/i;
const NEGATIVE_DIRECTIVE = /^(?:please\s+)?(?:do\s+not|don['’]t|never|avoid)\b/i;

function normalize(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokens(value: string): string[] {
  return normalize(value).split(" ").filter(Boolean);
}

function containsWords(haystack: string, needle: string): boolean {
  return !!needle && ` ${haystack} `.includes(` ${needle} `);
}

function providerHint(label: string): ImplementorProvider | null {
  const found = PROVIDER_HINTS.filter(([, pattern]) => pattern.test(label)).map(([provider]) => provider);
  return found.length === 1 ? found[0]! : null;
}

function cleanedCandidates(candidates: readonly ModelRequestCandidate[]): ModelRequestCandidate[] {
  const seen = new Set<string>();
  const out: ModelRequestCandidate[] = [];
  for (const candidate of candidates) {
    const model = candidate.model.trim();
    if (!model) continue;
    const key = `${candidate.provider}|${normalize(model)}`;
    if (seen.has(key)) {
      const prior = out.find((item) => `${item.provider}|${normalize(item.model)}` === key)!;
      prior.labels = [...new Set([...(prior.labels ?? []), ...(candidate.labels ?? [])])];
      continue;
    }
    seen.add(key);
    out.push({ ...candidate, model, labels: [...new Set(candidate.labels ?? [])] });
  }
  return out;
}

/** Distinctive one-word aliases are permitted only when they identify exactly one model in the live
 * roster. This is what resolves "Spark" without hardcoding `gpt-5.3-codex-spark`, while refusing an
 * ambiguous request such as bare "Opus" when several Opus versions are installed. */
function uniqueAliases(candidates: readonly ModelRequestCandidate[]): Map<string, string> {
  const owners = new Map<string, Set<string>>();
  for (const candidate of candidates) {
    const key = `${candidate.provider}|${normalize(candidate.model)}`;
    for (const value of [candidate.model, ...(candidate.labels ?? [])]) {
      for (const token of tokens(value)) {
        if (token.length < 3 || /^\d+$/.test(token) || GENERIC_TOKENS.has(token)) continue;
        const set = owners.get(token) ?? new Set<string>();
        set.add(key);
        owners.set(token, set);
      }
    }
  }
  const out = new Map<string, string>();
  for (const [alias, keys] of owners) if (keys.size === 1) out.set(alias, [...keys][0]!);
  return out;
}

interface Match {
  candidate: ModelRequestCandidate;
  score: number;
  mention: string;
}

function matchesFor(label: string, candidates: readonly ModelRequestCandidate[]): Match[] {
  const clean = cleanedCandidates(candidates);
  const wanted = normalize(label);
  if (!wanted) return [];
  const aliases = uniqueAliases(clean);
  const matches: Match[] = [];
  for (const candidate of clean) {
    const key = `${candidate.provider}|${normalize(candidate.model)}`;
    let best: Match | undefined;
    for (const rawAlias of [candidate.model, ...(candidate.labels ?? [])]) {
      const alias = normalize(rawAlias);
      if (!alias) continue;
      const exact = wanted === alias;
      const mentioned = containsWords(wanted, alias);
      if (exact || mentioned) {
        const score = (exact ? 10_000 : 5_000) + alias.length;
        if (!best || score > best.score) best = { candidate, score, mention: rawAlias };
      }
    }
    for (const token of tokens(label)) {
      if (aliases.get(token) !== key) continue;
      const score = 1_000 + token.length;
      if (!best || score > best.score) best = { candidate, score, mention: token };
    }
    if (best) matches.push(best);
  }
  return matches.sort((a, b) => b.score - a.score);
}

/** Resolve a Director bridge's explicit raw model label against live/configured candidates. An
 * unresolvable request is still returned and persisted: strict means "stop clearly", never silently
 * fall through to the normal router. */
export function resolveModelRequest(
  label: string,
  candidates: readonly ModelRequestCandidate[],
): ModelRequest {
  const requested = label.trim().slice(0, 160);
  const matches = matchesFor(requested, candidates);
  const top = matches[0];
  const tied = top ? matches.filter((match) => match.score === top.score) : [];
  if (top && tied.length === 1) {
    return { requested, provider: top.candidate.provider, model: top.candidate.model, strict: true };
  }
  const providers = new Set(matches.map((match) => match.candidate.provider));
  return {
    requested,
    provider: providers.size === 1 ? [...providers][0]! : providerHint(requested),
    model: null,
    strict: true,
  };
}

function clauses(text: string): string[] {
  // Examples and schemas in quoted/code text describe model requests; they are not requests themselves.
  const unquoted = text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`[^`\n]+`/g, " ")
    .replace(/["“][^"”\n]+["”]/g, " ");
  return unquoted.match(/[^.!?;\n]+(?:[.!?;]+|$)/g)?.map((part) => part.trim()).filter(Boolean) ?? [];
}

function directClause(clause: string): boolean {
  if (NEGATIVE_DIRECTIVE.test(clause)) return false;
  if (DIRECTIVE.test(clause)) return true;
  // Provider/model first: "Spark is explicitly required".
  return PROVIDER_FIRST_DIRECTIVE.test(clause) && /^(?:gpt|codex|claude|opus|sonnet|haiku|grok|glm|spark|sol|terra|luna|daybreak)\b/i.test(clause);
}

/** Keep the requested side of a contrast and discard its exclusion tail. Without this, legacy text
 * such as "Run this on GPT, not Grok" matches the only concrete model word (Grok) and pins the exact
 * backend the owner rejected. Provider-only wording remains the older providerIntent path. */
function requestedFragment(clause: string): string {
  return clause.replace(
    /\b(?:but\s+)?(?:do\s+not|don['’]t|never|not|avoid|except(?:\s+for)?|exclud(?:e|ing))\b[\s\S]*$/i,
    " ",
  );
}

/** Parse only strong, direct model commands from a persisted brief. This backstops old Director turns
 * (and skip-director dispatches) that have no bridge field, including "Use GPT Spark capacity...". */
export function detectModelRequest(
  text: string,
  candidates: readonly ModelRequestCandidate[],
): ModelRequest | null {
  for (const clause of clauses(text)) {
    if (!directClause(clause)) continue;
    const requested = requestedFragment(clause);
    const matches = matchesFor(requested, candidates);
    const top = matches[0];
    const tied = top ? matches.filter((match) => match.score === top.score) : [];
    if (top && tied.length === 1) {
      return {
        requested: top.mention,
        provider: top.candidate.provider,
        model: top.candidate.model,
        strict: true,
      };
    }

    // Preserve a recognizable request even before the provider's live catalog/pool snapshot arrives.
    // Canonical resolution is retried at the dispatch gate; until then this deliberately cannot run.
    const known = requested.match(/\b(?:gpt(?:[-\s]+\d+(?:\.\d+)?)?(?:[-\s]+codex)?[-\s]+spark|spark|gpt[-\s]+(?:sol|terra|luna)|sol|terra|luna|daybreak)\b/i);
    if (known) return resolveModelRequest(known[0], candidates);
  }
  return null;
}
