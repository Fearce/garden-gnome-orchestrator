import { normalizeRecentRepo, recentRepoKey } from "../types.js";

/** The composer's recent-repo list after remembering `path`: its canonical spelling in front, and any
 *  other spelling of the same workspace gone, exactly as the server will store it. */
export function withRecentRepo(list: readonly string[], path: string, max: number): string[] {
  const p = normalizeRecentRepo(path);
  if (!p) return [...list];
  const key = recentRepoKey(p);
  return [p, ...list.filter((x) => recentRepoKey(x) !== key)].slice(0, max);
}

/** The list after forgetting `path`, under whatever spelling it was given. */
export function withoutRecentRepo(list: readonly string[], path: string): string[] {
  const key = recentRepoKey(path);
  return list.filter((x) => recentRepoKey(x) !== key);
}

/** Whether a typed or picked workspace is the repo a chip stands for. */
export function isSameRepo(chip: string, workspace: string): boolean {
  return !!workspace.trim() && recentRepoKey(chip) === recentRepoKey(workspace);
}
