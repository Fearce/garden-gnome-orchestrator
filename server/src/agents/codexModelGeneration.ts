/** Owner policy: never launch a superseded Sol/Luna generation, including saved pins.
 * Terra and specialized models stay unchanged until a named successor exists. */
export function currentCodexModel(model: string): string {
  const id = model.trim();
  const match = /^gpt-5\.6-(sol|luna)(?:[-.].*)?$/i.exec(id);
  return match ? `gpt-6-${match[1]!.toLowerCase()}` : id;
}

export function currentCodexModels(models: readonly string[]): string[] {
  return [...new Set(models.map(currentCodexModel))];
}
