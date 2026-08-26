export const FREE_PROVIDER_IDS = ["gemini", "groq", "kilo", "mistral", "cohere", "cloudflare", "nvidia", "huggingface"] as const;

export type FreeProviderId = (typeof FREE_PROVIDER_IDS)[number];
export type ProviderTransport = "openai-compatible" | "native";
export type FreeTierKind =
  | "RECURRING_HOURLY"
  | "RECURRING_DAILY"
  | "RECURRING_MONTHLY"
  | "FREE_PROTOTYPING"
  | "UNKNOWN_DYNAMIC";

export type ProviderConnectionState =
  | "disabled"
  | "awaiting-auth"
  | "awaiting-validation"
  | "ready"
  | "auth-error"
  | "misconfigured"
  | "quota-exhausted"
  | "rate-limited"
  | "outage";

export type ProviderErrorKind =
  | "authentication"
  | "billing"
  | "rate-limit"
  | "provider-outage"
  | "timeout"
  | "network"
  | "context-length"
  | "invalid-model"
  | "invalid-configuration"
  | "unknown";

export type UsageSource =
  | "provider-api"
  | "response-header"
  | "response-usage"
  | "local-estimate"
  | "published-limit"
  | "unknown";

export type QuotaKind = "requests" | "tokens" | "credits-usd" | "neurons" | "mixed" | "prototype" | "unknown";
export type QuotaWindow = "hour" | "day" | "month" | "rolling" | "dynamic";

export interface ProviderSecondaryLimit {
  label: string;
  used?: number;
  remaining?: number;
  limit?: number;
  unit: string;
  resetAt?: string;
}

export interface ProviderUsageSnapshot {
  providerId: FreeProviderId;
  quotaKind: QuotaKind;
  source: UsageSource;
  used?: number;
  remaining?: number;
  limit?: number;
  unit?: string;
  window?: QuotaWindow;
  resetAt?: string;
  lastUpdatedAt: string;
  estimated: boolean;
  stale?: boolean;
  secondaryLimits?: ProviderSecondaryLimit[];
  message?: string;
  /** Server-composed, truth-qualified text used by the mandatory provider-card chip. */
  displayLabel?: string;
}

export type FreeStatusSource = "provider" | "catalog-price" | "published" | "configured" | "unknown";

export interface ProviderModel {
  providerId: FreeProviderId;
  id: string;
  displayName: string;
  contextWindow?: number;
  supportsStreaming: boolean;
  supportsTools: boolean | null;
  supportsVision?: boolean;
  supportsReasoning?: boolean;
  isFree: boolean;
  freeStatusSource: FreeStatusSource;
  inputPricePerMillion?: number;
  outputPricePerMillion?: number;
  /** Why a discovered model is not eligible for the one-request free probe. */
  ineligibleReason?: string;
  /** Provider-specific local unit rates; currently used for Workers AI Neuron estimates. */
  unitsPerMillionInput?: number;
  unitsPerMillionOutput?: number;
}

export interface ProviderHealth {
  state: ProviderConnectionState;
  message: string;
  checkedAt: string | null;
  httpStatus?: number;
  retryAt?: string;
}

export interface ProviderCapabilities {
  modelDiscovery: boolean;
  streaming: boolean;
  tools: boolean | "model-dependent";
  exactUsage: boolean;
  localEstimate: boolean;
  taskRouting: false;
}

export interface FreeProviderDTO {
  id: FreeProviderId;
  displayName: string;
  transport: ProviderTransport;
  tierKind: FreeTierKind;
  tierLabel: string;
  quotaSummary: string;
  docsUrl: string;
  signupUrl: string;
  credentialLabel: string;
  credentialHelp: string;
  optionalCredential: boolean;
  needsAccountId: boolean;
  enabled: boolean;
  configured: boolean;
  keyPresent: boolean;
  keyLast4: string | null;
  keySource: "stored" | "environment" | "anonymous" | "none";
  accountIdPresent: boolean;
  accountIdLast4: string | null;
  selectedModel: string | null;
  models: ProviderModel[];
  health: ProviderHealth;
  usage: ProviderUsageSnapshot;
  capabilities: ProviderCapabilities;
  billingWarning: string;
  routing: { eligible: false; reason: string };
}

export interface ProviderCredentials {
  apiKey?: string;
  accountId?: string;
}

export interface ProviderTool {
  name: string;
  description?: string;
  parameters: Record<string, unknown>;
}

export interface ProviderMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  toolCallId?: string;
  toolName?: string;
}

export interface NormalizedCompletionRequest {
  model: string;
  messages: ProviderMessage[];
  tools?: ProviderTool[];
  maxOutputTokens?: number;
}

export interface NormalizedToolCall {
  id: string;
  name: string;
  arguments: string;
}

export interface CompletionUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  costUsd?: number;
  estimatedUnits?: number;
}

export interface RateLimitReading {
  source: "response-header";
  requests?: { limit?: number; remaining?: number; resetAt?: string; window?: "minute" | "day" | "dynamic" };
  tokens?: { limit?: number; remaining?: number; resetAt?: string; window?: "minute" | "day" | "dynamic" };
  retryAt?: string;
}

export interface NormalizedCompletion {
  text: string;
  model: string;
  upstreamProvider?: string;
  toolCalls: NormalizedToolCall[];
  usage: CompletionUsage;
  rateLimit?: RateLimitReading;
  requestId?: string;
}

export type NormalizedStreamEvent =
  | { type: "text-delta"; text: string }
  | { type: "tool-call-delta"; index: number; id?: string; name?: string; arguments?: string }
  | { type: "usage"; usage: CompletionUsage }
  | { type: "done"; model?: string; upstreamProvider?: string };

export interface ProviderAdapter {
  listModels(credentials: ProviderCredentials): Promise<ProviderModel[]>;
  complete(credentials: ProviderCredentials, request: NormalizedCompletionRequest): Promise<NormalizedCompletion>;
  stream(credentials: ProviderCredentials, request: NormalizedCompletionRequest): AsyncIterable<NormalizedStreamEvent>;
  /** Optional account/quota endpoint. It must never consume a model request. */
  accountUsage?(credentials: ProviderCredentials): Promise<Partial<ProviderUsageSnapshot> | null>;
}

export interface UsageLedgerEvent {
  providerId: FreeProviderId;
  accountFingerprint: string;
  modelId: string;
  timestamp: number;
  requestCount: number;
  inputTokens?: number;
  outputTokens?: number;
  providerCostUsd?: number;
  estimatedUnits?: number;
  responseStatus: "ok" | "rejected" | "failed";
  freeClass: FreeTierKind;
  windowId: string;
}

export class ProviderRequestError extends Error {
  constructor(
    message: string,
    readonly kind: ProviderErrorKind,
    readonly status?: number,
    readonly retryAt?: string,
  ) {
    super(message);
    this.name = "ProviderRequestError";
  }
}
