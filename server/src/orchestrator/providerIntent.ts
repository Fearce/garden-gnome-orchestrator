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

/** Extract only explicit operator routing language. Ordinary mentions such as an error report naming
 *  Grok do not count; a negative instruction always wins over a positive-looking substring inside it. */
export function providerIntent(text: string): ProviderIntent {
  const excluded = new Set<ImplementorProvider>();
  const preferred: ImplementorProvider[] = [];
  for (const provider of Object.keys(TERMS) as ImplementorProvider[]) {
    const term = TERMS[provider];
    const negative = new RegExp(`\\b(?:do\\s+not|don't|never|must\\s+not|not)\\b[^.!?;\\n]{0,100}\\b${term}\\b`, "i");
    const positive = new RegExp(
      `\\b(?:use|prefer|require(?:s|d)?|must\\s+use|run[^.!?;\\n]{0,35}\\bon|route[^.!?;\\n]{0,35}\\bto|dispatch[^.!?;\\n]{0,35}\\bto|switch[^.!?;\\n]{0,35}\\bto)\\b[^.!?;\\n]{0,100}\\b${term}\\b`,
      "i",
    );
    if (negative.test(text)) excluded.add(provider);
    if (positive.test(text) && !excluded.has(provider)) preferred.push(provider);
  }
  return { preferred: preferred.length === 1 ? preferred[0] : undefined, excluded };
}
