import type { ImplementorProvider } from "../types.js";

export interface ProviderIntent {
  preferred?: ImplementorProvider;
  excluded: Set<ImplementorProvider>;
}

const TERMS: Record<ImplementorProvider, string> = {
  claude: "(?:claude|anthropic)",
  codex: "(?:gpt|codex|openai)",
  grok: "(?:grok|xai|x\\.ai)",
  zai: "(?:z\\.?ai|glm)",
};

const CAPACITY_SCOPE = /\b(?:capacity|quota|pool|model|window|runway|headroom|meter|allowance|limit|exhausted|capped|spent|unavailable|at[- ]risk|unsafe)\b/i;
const ROUTING_SIGNAL = /\b(?:use|prefer|require|run|route|dispatch|switch|choose|select|pick)\b/i;

/** Keep intent inside sentence/semicolon clauses. The old parser let a generic `not` reach 100
 * characters forward, so "Do not interrupt this task ... on Codex" became a Codex exclusion. */
function clauses(text: string): string[] {
  return text.match(/[^.!?;\n]+(?:[.!?;]+|$)/g)?.map((clause) => clause.trim()).filter(Boolean) ?? [];
}

function capacityScoped(clause: string, start: number, end: number): boolean {
  // Include both modifiers before the provider ("an exhausted Codex pool") and the resource noun
  // immediately after it ("Codex model pool"). Capacity policy is enforced by the router, not by
  // excluding the entire provider named in a pool-specific safeguard.
  return CAPACITY_SCOPE.test(clause.slice(Math.max(0, start - 8), Math.min(clause.length, end + 64)));
}

function hasExplicitExclusion(parts: string[], term: string): boolean {
  const negativeRoutes = new RegExp(
    `\\b(?:do\\s+not|don['’]t|never|must\\s+not)\\s+(?:use|prefer|choose|select|pick|route|dispatch|run|switch)\\b[^.!?;\\n]{0,90}\\b${term}\\b`,
    "ig",
  );
  const providerFirst = new RegExp(
    `\\b${term}\\b[^.!?;\\n]{0,24}\\b(?:is|remains|must\\s+be|should\\s+be)\\s+(?:expressly\\s+|explicitly\\s+|strictly\\s+)?(?:not\\s+(?:allowed|permitted|eligible)|forbidden|excluded|prohibited|disallowed)\\b`,
    "ig",
  );
  const providerPassive = new RegExp(
    `\\b${term}\\b[^.!?;\\n]{0,24}\\b(?:must|should)\\s+not\\s+be\\s+(?:used|selected|chosen|routed|dispatched)\\b`,
    "ig",
  );
  const imperative = new RegExp(
    `\\b(?:exclude\\s+(?:(?:using|choosing|selecting)\\s+)?|` +
      `avoid\\s+(?:(?:using|choosing|selecting)\\s+|(?:routing|dispatching|switching)[^.!?;\\n]{0,30}\\b(?:to|onto)\\s+|running[^.!?;\\n]{0,30}\\bon\\s+)?)(?:the\\s+)?${term}\\b`,
    "ig",
  );
  const contrast = new RegExp(`\\bnot\\s+${term}\\b`, "ig");
  const retention = new RegExp(`\\b(?:switch|route|move)\\b[^.!?;\\n]{0,30}\\baway\\s+from\\s+${term}\\b`, "i");

  for (const clause of parts) {
    for (const pattern of [negativeRoutes, providerFirst, providerPassive]) {
      pattern.lastIndex = 0;
      for (const match of clause.matchAll(pattern)) {
        const start = match.index ?? 0;
        if (!retention.test(match[0]) && !capacityScoped(clause, start, start + match[0].length)) return true;
      }
    }

    imperative.lastIndex = 0;
    for (const match of clause.matchAll(imperative)) {
      const start = match.index ?? 0;
      const prefix = clause.slice(Math.max(0, start - 18), start);
      if (
        !/(?:do\s+not|don['’]t|never|must\s+not)\s*$/i.test(prefix) &&
        !capacityScoped(clause, start, start + match[0].length)
      ) {
        return true;
      }
    }

    // "run on GPT, not Grok" is a concise explicit exclusion, but a bare "not" without an earlier
    // routing command is deliberately ignored (it is normally diagnostic or safety prose).
    contrast.lastIndex = 0;
    for (const match of clause.matchAll(contrast)) {
      const start = match.index ?? 0;
      if (ROUTING_SIGNAL.test(clause.slice(0, start)) && !capacityScoped(clause, start, start + match[0].length)) return true;
    }
  }
  return false;
}

function hasPositiveDirective(parts: string[], term: string): boolean {
  const providerFirst = new RegExp(
    `\\b${term}\\b[^.!?;\\n]{0,24}\\b(?:is|remains)\\s+(?:expressly\\s+|explicitly\\s+)?(?:allowed|required|preferred|mandatory)\\b|` +
      `\\b${term}\\b[^.!?;\\n]{0,24}\\b(?:must|should)\\s+be\\s+(?:used|selected|chosen)\\b`,
    "i",
  );
  const command = new RegExp(
    `\\b(?:use|prefer|require(?:s|d)?|must\\s+use|run[^.!?;\\n]{0,35}\\bon|route[^.!?;\\n]{0,35}\\bto|dispatch[^.!?;\\n]{0,35}\\bto|switch[^.!?;\\n]{0,35}\\bto|choose|select|pick)\\b[^.!?;\\n]{0,100}\\b${term}\\b`,
    "ig",
  );

  for (const clause of parts) {
    if (providerFirst.test(clause)) return true;
    command.lastIndex = 0;
    for (const match of clause.matchAll(command)) {
      const prefix = clause.slice(Math.max(0, (match.index ?? 0) - 18), match.index ?? 0);
      if (!/(?:do\s+not|don['’]t|never|must\s+not)\s*$/i.test(prefix)) return true;
    }
  }
  return false;
}

/** Extract only explicit operator routing language. Ordinary provider mentions and pool-specific
 * capacity safeguards do not count as provider exclusions. A genuine exclusion still wins if the
 * same provider is also requested, because that conflict requires operator clarification. */
export function providerIntent(text: string): ProviderIntent {
  const excluded = new Set<ImplementorProvider>();
  const preferred: ImplementorProvider[] = [];
  const parts = clauses(text);
  for (const provider of Object.keys(TERMS) as ImplementorProvider[]) {
    const term = TERMS[provider];
    if (hasExplicitExclusion(parts, term)) excluded.add(provider);
    if (hasPositiveDirective(parts, term) && !excluded.has(provider)) preferred.push(provider);
  }
  return { preferred: preferred.length === 1 ? preferred[0] : undefined, excluded };
}
