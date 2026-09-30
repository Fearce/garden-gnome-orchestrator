import { CODEX_MODELS, GROK_MODELS, ZAI_MODELS } from "../types.js";

export function mergeModelOptions(...groups: readonly (readonly string[])[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const group of groups) {
    for (const model of group) {
      const id = model.trim();
      if (!id || seen.has(id)) continue;
      seen.add(id);
      out.push(id);
    }
  }
  return out;
}

/** The server's list once it has arrived — it already carries the curated fallback, the live catalog and
 *  the saved pick, with every superseded same-family model removed (server `modelFamily.ts`). Merging the
 *  built-in suggestions back in would re-offer exactly those superseded ids, so they only stand in for a
 *  list that has not loaded yet. */
function serverModelsOr(fallback: readonly string[], serverModels: readonly string[]): string[] {
  return mergeModelOptions(serverModels.length ? serverModels : fallback);
}

export function codexModelOptions(serverModels: readonly string[]): string[] {
  return serverModelsOr(CODEX_MODELS, serverModels);
}

export function grokModelOptions(serverModels: readonly string[]): string[] {
  return serverModelsOr(GROK_MODELS, serverModels);
}

export function zaiModelOptions(serverModels: readonly string[]): string[] {
  return serverModelsOr(ZAI_MODELS, serverModels);
}
