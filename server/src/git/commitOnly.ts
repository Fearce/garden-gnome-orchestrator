/** One canonical interpretation of NO_PUSH_REPO_PATTERN. The setting is an intentional literal
 * substring, not a regular expression: operators can safely use punctuation from an origin URL and
 * every caller reaches the same case-insensitive decision. An empty setting never matches. */
export function isConfiguredCommitOnlyOrigin(originUrl: string | null | undefined, pattern: string): boolean {
  const expected = pattern.trim().toLowerCase();
  const origin = originUrl?.trim().toLowerCase() ?? "";
  return expected.length > 0 && origin.length > 0 && origin.includes(expected);
}
