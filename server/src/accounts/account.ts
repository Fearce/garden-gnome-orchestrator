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
   * for that single GET and nothing else. Absent is the normal state: without it the account reports
   * its banked resets as unconfigured rather than as none.
   *
   * Set from `ACCOUNT_<n>_PROFILE_TOKEN` at boot, or from Settings → Subscriptions at runtime
   * (`AccountManager.setProfileToken`), which is why it is not readonly.
   */
  profileToken?: string;
}
