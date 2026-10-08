export interface Account {
  id: string;
  label: string;
  /** CLAUDE_CODE_OAUTH_TOKEN for this subscription (empty = inherit the CLI login). */
  token: string;
  /**
   * OPTIONAL second token for this subscription, carrying the `user:profile` scope.
   *
   * `token` above is a setup-token, which Anthropic scopes to `user:inference` only — enough to run
   * every agent, and not enough to read `/api/oauth/usage`, where banked resets live. This one is used
   * for identity/balance reads and opted-in credit-eligible cloud subtasks. Absent is the normal state: without it the account reports
   * its banked resets as unconfigured rather than as none.
   *
   * Set from `ACCOUNT_<n>_PROFILE_TOKEN` at boot, or at runtime by GGO's own Claude sign-in, which
   * replaces it on every renewal (`AccountManager.profileAccess`) — which is why it is not readonly.
   */
  profileToken?: string;
}
