import { latestFamilyModel, withoutSupersededModels } from "./modelFamily.js";

/** Owner policy: Codex runs use GPT-6 only, including saved pins and recovery. */
export function isGpt6Model(model: string): boolean {
  return /^gpt-6(?:\.\d+)?(?:-|$)/i.test(model.trim());
}

/** A stored or requested Codex id as it must run today: pre-GPT-6 ids map onto their GPT-6 line, then
 *  every id moves to the newest member of its line the installed catalogs expose (gpt-6-sol → gpt-6.1-sol). */
export function currentCodexModel(model: string): string {
  const line = gpt6Line(model.trim());
  return /^gpt-/i.test(line) ? latestFamilyModel(line) : line;
}

function gpt6Line(id: string): string {
  if (isGpt6Model(id)) return id;
  if (/^gpt-5\.6-(?:sol|terra)(?:[-.]|$)/i.test(id) || /^gpt-daybreak-/i.test(id)) return "gpt-6-sol";
  if (/^gpt-5\.6-luna(?:[-.]|$)/i.test(id) || /^(?:gpt-(?:[34](?:\.\d+)?|5(?:\.[0-5])?)(?:-|$)|o\d|codex(?:-|$))/i.test(id)) return "gpt-6-luna";
  return id;
}

/** Catalogs describe availability: do not invent successors absent from the actual catalog, and never
 *  offer a line's older member beside its newer one. */
export function currentCodexModels(models: readonly string[]): string[] {
  return withoutSupersededModels([...new Set(models.filter(isGpt6Model))]);
}
