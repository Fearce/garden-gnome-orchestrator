// Which connected subscriptions may be offered to other office members as Director capacity, and why.
//
// This is a provider-terms decision, not a technical one. Checked against each provider's published
// terms on 2026-10-02:
//   - Claude Free/Pro/Max OAuth: "Anthropic does not permit third-party developers ... to route requests
//     through Free, Pro, or Max plan credentials on behalf of their users."
//     https://code.claude.com/docs/en/legal-and-compliance
//   - ChatGPT plan (Codex sign-in) and SuperGrok (Grok sign-in): "You may not share your account
//     credentials or make your account available to anyone else."
//     https://openai.com/policies/row-terms-of-use/ · https://x.ai/legal/terms-of-service
//   - z.ai GLM Coding Plan: "Account sharing or multi-user access is prohibited."
//     https://docs.z.ai/devpack/usage-policy
//   - OpenAI API and xAI API keys are billed per token to the key owner, whose business terms cover
//     serving their own end users through an application:
//     https://openai.com/policies/services-agreement/ · https://x.ai/legal/terms-of-service-enterprise
// So only an API-key subscription can be shared. Every other connected subscription is still LISTED, with
// the reason, so the owner sees it was considered rather than wondering where it went.

/** A subscription that can serve shared Director calls: an OpenAI-compatible chat-completions endpoint
 *  billed to the donor's own API key. Lives only on the donor's host; nothing here crosses the relay. */
export interface ShareableEndpoint {
  baseUrl: string;
  apiKey: string;
}

export type DirectorShareSubscriptionKind = "openai-api" | "xai-api" | "claude" | "codex-chatgpt" | "grok-login" | "zai";

export interface DirectorShareSubscription {
  id: string;
  kind: DirectorShareSubscriptionKind;
  label: string;
  providerLabel: string;
  shareable: boolean;
  /** Why it can or cannot be shared, in one sentence the settings panel shows as is. */
  reason: string;
  sourceUrl: string;
}

export interface DirectorShareSources {
  claudeAccounts: { id: string; label: string }[];
  /** The stored OpenAI API key (an `sk-` key), when one is configured. */
  openaiApiKey?: string;
  codexChatgptLogin: boolean;
  xaiApiKey?: string;
  grokLogin: boolean;
  zaiConfigured: boolean;
}

const OPENAI_API_BASE = process.env.DIRECTOR_SHARE_OPENAI_BASE_URL?.trim() || "https://api.openai.com/v1";
const XAI_API_BASE = process.env.DIRECTOR_SHARE_XAI_BASE_URL?.trim() || "https://api.x.ai/v1";

const NOT_SHAREABLE = {
  claude: {
    reason: "Anthropic does not allow Claude plan sign-ins to serve requests for other people.",
    sourceUrl: "https://code.claude.com/docs/en/legal-and-compliance",
  },
  codexChatgpt: {
    reason: "OpenAI's terms do not allow a ChatGPT plan to be made available to anyone else.",
    sourceUrl: "https://openai.com/policies/row-terms-of-use/",
  },
  grokLogin: {
    reason: "xAI's terms do not allow a Grok subscription to be made available to anyone else.",
    sourceUrl: "https://x.ai/legal/terms-of-service",
  },
  zai: {
    reason: "z.ai prohibits account sharing and multi-user access on the GLM Coding Plan.",
    sourceUrl: "https://docs.z.ai/devpack/usage-policy",
  },
} as const;

/** Every connected subscription, in settings order, each marked shareable or not. */
export function directorShareSubscriptions(src: DirectorShareSources): DirectorShareSubscription[] {
  const out: DirectorShareSubscription[] = [];
  if (isOpenAiApiKey(src.openaiApiKey)) {
    out.push({
      id: "openai-api",
      kind: "openai-api",
      label: "OpenAI API key",
      providerLabel: "OpenAI API",
      shareable: true,
      reason: "Billed per token to your OpenAI API key. Calls run on this machine; the key never leaves it.",
      sourceUrl: "https://openai.com/policies/services-agreement/",
    });
  }
  if (src.xaiApiKey?.trim()) {
    out.push({
      id: "xai-api",
      kind: "xai-api",
      label: "xAI API key",
      providerLabel: "xAI API",
      shareable: true,
      reason: "Billed per token to your xAI API key. Calls run on this machine; the key never leaves it.",
      sourceUrl: "https://x.ai/legal/terms-of-service-enterprise",
    });
  }
  for (const account of src.claudeAccounts) {
    out.push({ id: `claude:${account.id}`, kind: "claude", label: `Claude · ${account.label}`, providerLabel: "Claude plan", shareable: false, ...NOT_SHAREABLE.claude });
  }
  if (src.codexChatgptLogin) {
    out.push({ id: "codex-chatgpt", kind: "codex-chatgpt", label: "Codex · ChatGPT sign-in", providerLabel: "ChatGPT plan", shareable: false, ...NOT_SHAREABLE.codexChatgpt });
  }
  if (src.grokLogin) {
    out.push({ id: "grok-login", kind: "grok-login", label: "Grok · SuperGrok sign-in", providerLabel: "Grok plan", shareable: false, ...NOT_SHAREABLE.grokLogin });
  }
  if (src.zaiConfigured) {
    out.push({ id: "zai", kind: "zai", label: "z.ai · GLM Coding Plan", providerLabel: "GLM Coding Plan", shareable: false, ...NOT_SHAREABLE.zai });
  }
  return out;
}

/** The donor-side endpoint for a shareable subscription id, resolved at call time so a key the owner
 *  removes or rotates takes effect on the very next request. */
export function directorShareEndpoint(id: string, src: Pick<DirectorShareSources, "openaiApiKey" | "xaiApiKey">): ShareableEndpoint | undefined {
  if (id === "openai-api" && isOpenAiApiKey(src.openaiApiKey)) return { baseUrl: OPENAI_API_BASE, apiKey: src.openaiApiKey!.trim() };
  if (id === "xai-api" && src.xaiApiKey?.trim()) return { baseUrl: XAI_API_BASE, apiKey: src.xaiApiKey.trim() };
  return undefined;
}

function isOpenAiApiKey(key: string | undefined): boolean {
  return !!key && /^sk-/.test(key.trim());
}
