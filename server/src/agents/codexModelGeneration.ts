/** Owner policy: Codex runs use GPT-6 only, including saved pins and recovery. */
export function isGpt6Model(model: string): boolean {
  return /^gpt-6(?:-|$)/i.test(model.trim());
}

export function currentCodexModel(model: string): string {
  const id = model.trim();
  if (isGpt6Model(id)) return id;
  if (/^gpt-5\.6-(?:sol|terra)(?:[-.]|$)/i.test(id) || /^gpt-daybreak-/i.test(id)) return "gpt-6-sol";
  if (/^gpt-5\.6-luna(?:[-.]|$)/i.test(id) || /^(?:gpt-(?:[34](?:\.\d+)?|5(?:\.[0-5])?)(?:-|$)|o\d|codex(?:-|$))/i.test(id)) return "gpt-6-luna";
  return id;

}

/** Catalogs describe availability: do not invent successors absent from the actual catalog. */
export function currentCodexModels(models: readonly string[]): string[] {
  return [...new Set(models.filter(isGpt6Model))];
}
