export interface Account {
  id: string;
  label: string;
  /** CLAUDE_CODE_OAUTH_TOKEN for this subscription (empty = inherit the CLI login). */
  token: string;
}
