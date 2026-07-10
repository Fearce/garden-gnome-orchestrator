import { CODEX_MODELS } from "../types.js";

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

export function codexModelOptions(liveModels: readonly string[]): string[] {
  return mergeModelOptions(CODEX_MODELS, liveModels);
}
