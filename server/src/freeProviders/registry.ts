import { requestJson } from "./http.js";
import { OpenAiCompatibleAdapter } from "./openAiAdapter.js";
import { GeminiAdapter } from "./geminiAdapter.js";
import { CohereAdapter } from "./cohereAdapter.js";
import type {
  FreeProviderId,
  FreeTierKind,
  ProviderAdapter,
  ProviderCredentials,
  ProviderModel,
  QuotaKind,
  QuotaWindow,
} from "./types.js";

type UnknownRecord = Record<string, unknown>;

export interface ProviderUsagePolicy {
  quotaKind: QuotaKind;
  window: QuotaWindow;
  timeZone: string;
  limit?: number;
  unit: string;
  localEstimate: boolean;
  summary: string;
}

export interface ProviderDefinition {
  id: FreeProviderId;
  displayName: string;
  transport: "openai-compatible" | "native";
  tierKind: FreeTierKind;
  tierLabel: string;
  quotaSummary: string;
  docsUrl: string;
  signupUrl: string;
  credentialLabel: string;
  credentialHelp: string;
  optionalCredential: boolean;
  needsAccountId: boolean;
  envKey: string;
  envAccountId?: string;
  billingWarning: string;
  usage: ProviderUsagePolicy;
  adapter: ProviderAdapter;
  preferredModels: string[];
}

function record(value: unknown): UnknownRecord | null {
  return value != null && typeof value === "object" && !Array.isArray(value) ? (value as UnknownRecord) : null;
}

function arrayAt(body: unknown): unknown[] {
  if (Array.isArray(body)) return body;
  const root = record(body);
  if (Array.isArray(root?.data)) return root.data;
  if (Array.isArray(root?.models)) return root.models;
  if (Array.isArray(root?.result)) return root.result;
  return [];
}

function finite(value: unknown): number | undefined {
  const n = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : Number.NaN;
  return Number.isFinite(n) ? n : undefined;
}

function boolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function idOf(value: UnknownRecord): string {
  const id = value.id ?? value.name ?? value.model;
  return typeof id === "string" ? id.replace(/^models\//, "") : "";
}

function displayName(value: UnknownRecord, id: string): string {
  const label = value.display_name ?? value.displayName ?? value.name;
  return typeof label === "string" && label !== id ? label : id;
}

function contextWindow(value: UnknownRecord): number | undefined {
  return finite(value.context_window ?? value.context_length ?? value.max_context_length ?? value.inputTokenLimit);
}

function capability(value: UnknownRecord, key: string): boolean | undefined {
  const capabilities = record(value.capabilities);
  const features = Array.isArray(value.supported_features) ? value.supported_features : Array.isArray(value.features) ? value.features : [];
  const direct = boolean(capabilities?.[key] ?? value[key]);
  if (direct != null) return direct;
  return features.some((feature) => typeof feature === "string" && feature.toLowerCase().includes(key.toLowerCase())) || undefined;
}

function price(value: UnknownRecord, ...keys: string[]): number | undefined {
  for (const parent of [record(value.pricing), record(value.price), value]) {
    for (const key of keys) {
      const found = finite(parent?.[key]);
      if (found != null) return found;
    }
  }
  return undefined;
}

function millionPrice(raw: number | undefined): number | undefined {
  if (raw == null) return undefined;
  // Gateway catalogs normally quote per-token prices; values >= 0.001 are already per-million.
  return raw < 0.001 ? raw * 1_000_000 : raw;
}

const GROQ_FREE_MODELS = new Set(["openai/gpt-oss-120b", "openai/gpt-oss-20b", "qwen/qwen3.6-27b"]);

export function normalizeGroqModels(body: unknown): ProviderModel[] {
  return arrayAt(body).flatMap((raw) => {
    const value = record(raw);
    if (!value) return [];
    const id = idOf(value);
    if (!id || value.active === false) return [];
    const eligible = GROQ_FREE_MODELS.has(id);
    return [{
      providerId: "groq" as const,
      id,
      displayName: displayName(value, id),
      contextWindow: contextWindow(value),
      supportsStreaming: true,
      supportsTools: capability(value, "tool_use") ?? null,
      isFree: eligible,
      freeStatusSource: eligible ? "published" as const : "unknown" as const,
      ineligibleReason: eligible ? undefined : "Not in GGO's currently verified Groq free-plan allowlist.",
    }];
  });
}

export function normalizeMistralModels(body: unknown): ProviderModel[] {
  return arrayAt(body).flatMap((raw) => {
    const value = record(raw);
    if (!value) return [];
    const id = idOf(value);
    if (!id) return [];
    const caps = record(value.capabilities);
    const canChat = boolean(caps?.completion_chat) ?? !/(embed|moderation|ocr)/i.test(id);
    if (!canChat) return [];
    return [{
      providerId: "mistral" as const,
      id,
      displayName: displayName(value, id),
      contextWindow: contextWindow(value) ?? finite(value.max_context_length),
      supportsStreaming: true,
      supportsTools: boolean(caps?.function_calling) ?? null,
      supportsVision: boolean(caps?.vision),
      isFree: true,
      freeStatusSource: "configured" as const,
    }];
  });
}

export function normalizeOpenRouterModels(body: unknown): ProviderModel[] {
  const found: ProviderModel[] = arrayAt(body).flatMap((raw) => {
    const value = record(raw);
    if (!value) return [];
    const id = idOf(value);
    if (!id) return [];
    const input = price(value, "prompt", "input", "input_price");
    const output = price(value, "completion", "output", "output_price");
    const request = price(value, "request", "request_price");
    const image = price(value, "image", "image_price");
    const internal = price(value, "internal_reasoning", "internal_reasoning_price");
    const zeroPriced = input === 0 && output === 0 && (request == null || request === 0) && (image == null || image === 0) && (internal == null || internal === 0);
    const free = id.endsWith(":free") && zeroPriced;
    const architecture = record(value.architecture);
    const supported = Array.isArray(value.supported_parameters) ? value.supported_parameters : [];
    return [{
      providerId: "openrouter" as const,
      id,
      displayName: displayName(value, id),
      contextWindow: contextWindow(value),
      supportsStreaming: true,
      supportsTools: supported.includes("tools") || supported.includes("tool_choice"),
      supportsVision: String(architecture?.input_modalities ?? "").includes("image"),
      isFree: free,
      freeStatusSource: zeroPriced ? "catalog-price" as const : "catalog-price" as const,
      inputPricePerMillion: millionPrice(input),
      outputPricePerMillion: millionPrice(output),
      ineligibleReason: free ? undefined : id.endsWith(":free") ? "Catalog pricing is no longer exactly zero." : "Only current :free variants are eligible.",
    }];
  });
  // The official free router is intentionally added even if a catalog deployment omits virtual routers.
  if (!found.some((model) => model.id === "openrouter/free")) {
    found.unshift({
      providerId: "openrouter",
      id: "openrouter/free",
      displayName: "OpenRouter Free",
      supportsStreaming: true,
      supportsTools: true,
      isFree: true,
      freeStatusSource: "provider",
    });
  }
  return found;
}

export function normalizeKiloModels(body: unknown): ProviderModel[] {
  const found: ProviderModel[] = arrayAt(body).flatMap((raw) => {
    const value = record(raw);
    if (!value) return [];
    const id = idOf(value);
    if (!id) return [];
    const input = price(value, "prompt", "input", "input_price");
    const output = price(value, "completion", "output", "output_price");
    const request = price(value, "request", "request_price");
    const zeroPriced = input === 0 && output === 0 && (request == null || request === 0);
    const freeName = id.endsWith(":free") || id === "kilo-auto/free";
    const free = freeName && zeroPriced;
    const supported = Array.isArray(value.supported_parameters) ? value.supported_parameters : [];
    return [{
      providerId: "kilo" as const,
      id,
      displayName: displayName(value, id),
      contextWindow: contextWindow(value),
      supportsStreaming: true,
      supportsTools: supported.length ? supported.includes("tools") || supported.includes("tool_choice") : null,
      isFree: free,
      freeStatusSource: "catalog-price" as const,
      inputPricePerMillion: millionPrice(input),
      outputPricePerMillion: millionPrice(output),
      ineligibleReason: free ? undefined : freeName ? "Catalog pricing is no longer exactly zero." : "Only current free routes are eligible.",
    }];
  });
  if (!found.some((model) => model.id === "kilo-auto/free")) {
    found.unshift({
      providerId: "kilo",
      id: "kilo-auto/free",
      displayName: "Kilo Auto Free",
      supportsStreaming: true,
      supportsTools: null,
      isFree: true,
      freeStatusSource: "provider",
    });
  }
  return found;
}

export const WORKERS_AI_NEURON_RATES: Readonly<Record<string, { input: number; output: number }>> = {
  "@cf/qwen/qwen2.5-coder-32b-instruct": { input: 60_000, output: 90_909 },
  "@cf/openai/gpt-oss-120b": { input: 31_818, output: 68_182 },
  "@cf/openai/gpt-oss-20b": { input: 18_182, output: 27_273 },
  "@cf/qwen/qwen3-30b-a3b-fp8": { input: 4_625, output: 30_475 },
  "@cf/zai-org/glm-4.7-flash": { input: 5_500, output: 36_400 },
  "@cf/ibm-granite/granite-4.0-h-micro": { input: 1_542, output: 10_158 },
};

const WORKERS_AI_PAID_ONLY = new Set([
  "@cf/moonshotai/kimi-k2.6",
  "@cf/moonshotai/kimi-k2.7-code",
  "@cf/zai-org/glm-5.2",
  "@cf/deepseek-ai/deepseek-v4-flash-0731",
  "@cf/deepseek-ai/deepseek-v4-pro-0813",
]);

export function normalizeCloudflareModels(body: unknown): ProviderModel[] {
  return arrayAt(body).flatMap((raw) => {
    const value = record(raw);
    if (!value) return [];
    // Cloudflare's model-search response uses an opaque UUID for `id`; `name` is the callable
    // @cf/... identifier accepted by the OpenAI-compatible completion endpoint.
    const id = typeof value.name === "string" ? value.name : idOf(value);
    if (!id) return [];
    const task = record(value.task);
    const taskName = String(task?.name ?? value.task ?? "");
    if (taskName && !/(text generation|text-generation|chat)/i.test(taskName)) return [];
    const rate = WORKERS_AI_NEURON_RATES[id];
    const paidOnly = WORKERS_AI_PAID_ONLY.has(id);
    const eligible = !!rate && !paidOnly;
    return [{
      providerId: "cloudflare" as const,
      id,
      displayName: displayName(value, id),
      contextWindow: contextWindow(value),
      supportsStreaming: true,
      supportsTools: capability(value, "tools") ?? null,
      isFree: eligible,
      freeStatusSource: eligible || paidOnly ? "published" as const : "unknown" as const,
      unitsPerMillionInput: rate?.input,
      unitsPerMillionOutput: rate?.output,
      ineligibleReason: paidOnly
        ? "Cloudflare currently documents this model as paid-plan only."
        : eligible
          ? undefined
          : "Neuron rates/free-plan eligibility are not verified by this build.",
    }];
  });
}

const CODING_MODEL = /(?:coder|code|gpt-oss|nemotron|deepseek|glm|qwen|mistral|llama|kimi|granite)/i;
const NON_CHAT_MODEL = /(?:embed|rerank|reward|guard|moderation|ocr|speech|audio|whisper|diffusion)/i;

export function normalizeNvidiaModels(body: unknown): ProviderModel[] {
  return arrayAt(body).flatMap((raw) => {
    const value = record(raw);
    if (!value) return [];
    const id = idOf(value);
    if (!id || NON_CHAT_MODEL.test(id) || !CODING_MODEL.test(id)) return [];
    return [{
      providerId: "nvidia" as const,
      id,
      displayName: displayName(value, id),
      contextWindow: contextWindow(value),
      supportsStreaming: true,
      supportsTools: capability(value, "tools") ?? capability(value, "tool_use") ?? null,
      isFree: true,
      freeStatusSource: "provider" as const,
    }];
  });
}

export function normalizeHuggingFaceModels(body: unknown): ProviderModel[] {
  return arrayAt(body).flatMap((raw) => {
    const value = record(raw);
    if (!value) return [];
    const baseId = idOf(value);
    if (!baseId || NON_CHAT_MODEL.test(baseId) || !CODING_MODEL.test(baseId)) return [];
    const architecture = record(value.architecture);
    const inputModalities = Array.isArray(architecture?.input_modalities) ? architecture.input_modalities : [];
    if (inputModalities.length && !inputModalities.includes("text")) return [];
    const providers = Array.isArray(value.providers) ? value.providers : [];
    return providers.flatMap((rawProvider) => {
      const provider = record(rawProvider);
      const providerId = typeof provider?.provider === "string" ? provider.provider : "";
      const pricing = record(provider?.pricing);
      const input = finite(pricing?.input);
      const output = finite(pricing?.output);
      if (!providerId || provider?.status !== "live" || input == null || output == null || input < 0 || output < 0) return [];
      return [{
        providerId: "huggingface" as const,
        id: `${baseId}:${providerId}`,
        displayName: `${baseId} · ${providerId}`,
        contextWindow: finite(provider.context_length),
        supportsStreaming: true,
        supportsTools: boolean(provider.supports_tools) ?? null,
        supportsVision: inputModalities.includes("image"),
        isFree: true,
        freeStatusSource: "configured" as const,
        inputPricePerMillion: input,
        outputPricePerMillion: output,
      }];
    });
  });
}

function authHeaders(credentials: ProviderCredentials): Record<string, string> {
  return credentials.apiKey ? { authorization: `Bearer ${credentials.apiKey}` } : {};
}

async function openRouterUsage(credentials: ProviderCredentials, fetchImpl?: typeof fetch) {
  if (!credentials.apiKey) return null;
  const response = await requestJson<unknown>(
    "https://openrouter.ai/api/v1/key",
    { headers: authHeaders(credentials) },
    { fetchImpl, secrets: [credentials.apiKey] },
  );
  const root = record(response.body);
  const data = record(root?.data) ?? root;
  if (!data) return null;
  const freeTier = boolean(data.is_free_tier);
  const creditLimit = finite(data.limit);
  const creditRemaining = finite(data.limit_remaining);
  const creditUsed = finite(data.usage);
  return {
    source: "provider-api" as const,
    secondaryLimits:
      creditLimit != null || creditRemaining != null || creditUsed != null
        ? [{ label: "Account credit", limit: creditLimit, remaining: creditRemaining, used: creditUsed, unit: "USD" }]
        : undefined,
    message: freeTier == null ? undefined : freeTier ? "OpenRouter reports this as a free-tier key." : "OpenRouter reports a funded account; free-model allowance is estimated at the funded tier.",
    // Service combines this private marker into the published 50/1,000 free-request estimate.
    freeTier,
  } as Partial<import("./types.js").ProviderUsageSnapshot> & { freeTier?: boolean };
}

async function huggingFaceIdentity(credentials: ProviderCredentials, fetchImpl?: typeof fetch) {
  if (!credentials.apiKey) return null;
  await requestJson<unknown>(
    "https://huggingface.co/api/whoami-v2",
    { headers: authHeaders(credentials) },
    { fetchImpl, secrets: [credentials.apiKey] },
  );
  return { message: "Hugging Face token validated. Account-wide credit balance remains in Hugging Face billing settings." };
}

export function createOpenAiDefinitions(fetchImpl?: typeof fetch): ProviderDefinition[] {
  const groq = new OpenAiCompatibleAdapter({
    providerId: "groq",
    modelsUrl: () => "https://api.groq.com/openai/v1/models",
    completionUrl: () => "https://api.groq.com/openai/v1/chat/completions",
    headers: authHeaders,
    normalizeModels: normalizeGroqModels,
    fetchImpl,
  });
  const openrouter = new OpenAiCompatibleAdapter({
    providerId: "openrouter",
    modelsUrl: () => "https://openrouter.ai/api/v1/models",
    completionUrl: () => "https://openrouter.ai/api/v1/chat/completions",
    headers: (credentials) => ({ ...authHeaders(credentials), "HTTP-Referer": "https://github.com/Fearce/garden-gnome-orchestrator", "X-Title": "GG Orchestrator" }),
    normalizeModels: normalizeOpenRouterModels,
    accountUsage: (credentials) => openRouterUsage(credentials, fetchImpl),
    fetchImpl,
  });
  const kilo = new OpenAiCompatibleAdapter({
    providerId: "kilo",
    modelsUrl: () => "https://api.kilo.ai/api/gateway/models",
    completionUrl: () => "https://api.kilo.ai/api/gateway/chat/completions",
    headers: authHeaders,
    normalizeModels: normalizeKiloModels,
    fetchImpl,
  });
  const mistral = new OpenAiCompatibleAdapter({
    providerId: "mistral",
    modelsUrl: () => "https://api.mistral.ai/v1/models",
    completionUrl: () => "https://api.mistral.ai/v1/chat/completions",
    headers: authHeaders,
    normalizeModels: normalizeMistralModels,
    fetchImpl,
  });
  const cloudflare = new OpenAiCompatibleAdapter({
    providerId: "cloudflare",
    modelsUrl: (credentials) => `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(credentials.accountId ?? "")}/ai/models/search?per_page=100`,
    completionUrl: (credentials) => `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(credentials.accountId ?? "")}/ai/v1/chat/completions`,
    headers: authHeaders,
    normalizeModels: normalizeCloudflareModels,
    fetchImpl,
  });
  const nvidia = new OpenAiCompatibleAdapter({
    providerId: "nvidia",
    modelsUrl: () => "https://integrate.api.nvidia.com/v1/models",
    completionUrl: () => "https://integrate.api.nvidia.com/v1/chat/completions",
    headers: authHeaders,
    normalizeModels: normalizeNvidiaModels,
    fetchImpl,
  });
  const huggingface = new OpenAiCompatibleAdapter({
    providerId: "huggingface",
    modelsUrl: () => "https://router.huggingface.co/v1/models",
    completionUrl: () => "https://router.huggingface.co/v1/chat/completions",
    headers: authHeaders,
    normalizeModels: normalizeHuggingFaceModels,
    accountUsage: (credentials) => huggingFaceIdentity(credentials, fetchImpl),
    fetchImpl,
  });

  return [
    {
      id: "groq",
      displayName: "Groq",
      transport: "openai-compatible",
      tierKind: "RECURRING_DAILY",
      tierLabel: "Free plan · daily",
      quotaSummary: "Model-specific RPD/TPD; GGO reads Groq's live response headers.",
      docsUrl: "https://console.groq.com/docs/rate-limits",
      signupUrl: "https://console.groq.com/keys",
      credentialLabel: "Groq API key",
      credentialHelp: "Create a key in GroqCloud. GGO stores it only on this server.",
      optionalCredential: false,
      needsAccountId: false,
      envKey: "GROQ_API_KEY",
      billingWarning: "Manual probes only. Groq plan/billing state is account-wide; GGO never falls through to another model.",
      usage: { quotaKind: "mixed", window: "day", timeZone: "UTC", unit: "requests", localEstimate: true, summary: "Local requests until Groq returns exact request/day and token/minute headers." },
      adapter: groq,
      preferredModels: ["openai/gpt-oss-120b", "qwen/qwen3.6-27b", "openai/gpt-oss-20b"],
    },
    {
      id: "openrouter",
      displayName: "OpenRouter",
      transport: "openai-compatible",
      tierKind: "RECURRING_DAILY",
      tierLabel: "Free models · daily",
      quotaSummary: "50 free-model requests/day, or 1,000/day after funding at least $10.",
      docsUrl: "https://openrouter.ai/docs/faq",
      signupUrl: "https://openrouter.ai/settings/keys",
      credentialLabel: "OpenRouter API key",
      credentialHelp: "Only :free models whose live catalog price is exactly zero can be probed.",
      optionalCredential: false,
      needsAccountId: false,
      envKey: "OPENROUTER_API_KEY",
      billingWarning: "GGO refreshes pricing immediately before every probe and rejects non-zero pricing. Paid fallback is impossible in this lab.",
      usage: { quotaKind: "requests", window: "day", timeZone: "UTC", unit: "free requests", localEstimate: true, summary: "Published allowance minus calls recorded by this GGO instance." },
      adapter: openrouter,
      preferredModels: ["openrouter/free"],
    },
    {
      id: "kilo",
      displayName: "Kilo Gateway",
      transport: "openai-compatible",
      tierKind: "RECURRING_HOURLY",
      tierLabel: "Free routes · rolling hour",
      quotaSummary: "200 free-model requests/hour/IP; an API key is optional.",
      docsUrl: "https://kilo.ai/docs/gateway/usage-and-billing",
      signupUrl: "https://app.kilo.ai/",
      credentialLabel: "Kilo API key (optional)",
      credentialHelp: "Leave blank for documented anonymous free access, or save a Kilo key.",
      optionalCredential: true,
      needsAccountId: false,
      envKey: "KILO_API_KEY",
      billingWarning: "Only live zero-priced free routes are eligible; the catalog is rechecked before each manual probe.",
      usage: { quotaKind: "requests", window: "rolling", timeZone: "UTC", limit: 200, unit: "free requests", localEstimate: true, summary: "Rolling-hour estimate for calls from this GGO instance; the real limit is shared by IP." },
      adapter: kilo,
      preferredModels: ["kilo-auto/free"],
    },
    {
      id: "mistral",
      displayName: "Mistral",
      transport: "openai-compatible",
      tierKind: "RECURRING_MONTHLY",
      tierLabel: "$10 included · monthly",
      quotaSummary: "Mistral's Free plan currently includes $10/month across applicable services.",
      docsUrl: "https://docs.mistral.ai/admin/billing-usage/usage-limits",
      signupUrl: "https://console.mistral.ai/api-keys",
      credentialLabel: "Mistral API key",
      credentialHelp: "Create a key while your workspace is in Mistral's Free plan.",
      optionalCredential: false,
      needsAccountId: false,
      envKey: "MISTRAL_API_KEY",
      billingWarning: "Mistral does not expose a reliable remaining-credit value here. Confirm the workspace is in Free mode; probes are never automatic.",
      usage: { quotaKind: "credits-usd", window: "month", timeZone: "UTC", limit: 10, unit: "USD credit", localEstimate: true, summary: "The $10 allowance is published; GGO's ledger uses calendar months while the workspace balance stays authoritative in Mistral Console." },
      adapter: mistral,
      preferredModels: ["codestral-latest", "devstral-small-latest", "mistral-small-latest"],
    },
    {
      id: "cloudflare",
      displayName: "Cloudflare Workers AI",
      transport: "openai-compatible",
      tierKind: "RECURRING_DAILY",
      tierLabel: "10K Neurons · daily",
      quotaSummary: "10,000 Neurons/day included; resets at 00:00 UTC.",
      docsUrl: "https://developers.cloudflare.com/workers-ai/platform/pricing/",
      signupUrl: "https://dash.cloudflare.com/profile/api-tokens",
      credentialLabel: "Cloudflare API token",
      credentialHelp: "Use a custom token with Workers AI Read + Edit, plus your account ID.",
      optionalCredential: false,
      needsAccountId: true,
      envKey: "CLOUDFLARE_API_TOKEN",
      envAccountId: "CLOUDFLARE_ACCOUNT_ID",
      billingWarning: "GGO excludes documented paid-only and unverified models. Neurons are estimated from published model rates and response tokens.",
      usage: { quotaKind: "neurons", window: "day", timeZone: "UTC", limit: 10_000, unit: "neurons", localEstimate: true, summary: "Local estimate; account-wide Cloudflare usage outside GGO is not visible." },
      adapter: cloudflare,
      preferredModels: ["@cf/qwen/qwen2.5-coder-32b-instruct", "@cf/openai/gpt-oss-120b", "@cf/zai-org/glm-4.7-flash"],
    },
    {
      id: "nvidia",
      displayName: "NVIDIA NIM",
      transport: "openai-compatible",
      tierKind: "FREE_PROTOTYPING",
      tierLabel: "Developer Program · prototype",
      quotaSummary: "NVIDIA advertises free hosted NIM endpoints for Developer Program prototyping; a numeric cap is not exposed.",
      docsUrl: "https://developer.nvidia.com/nim",
      signupUrl: "https://build.nvidia.com/",
      credentialLabel: "NVIDIA API key",
      credentialHelp: "Join the free NVIDIA Developer Program and create an API Catalog key.",
      optionalCredential: false,
      needsAccountId: false,
      envKey: "NVIDIA_API_KEY",
      billingWarning: "Hosted NIM Developer Program access is for development/testing, not production. GGO shows no invented remaining quota and sends probes only on confirmation.",
      usage: { quotaKind: "prototype", window: "dynamic", timeZone: "UTC", unit: "prototype requests", localEstimate: true, summary: "Free prototyping access; NVIDIA does not publish a machine-readable numeric allowance here. GGO records its own request/token evidence only." },
      adapter: nvidia,
      preferredModels: ["qwen/qwen3-coder-480b-a35b-instruct", "openai/gpt-oss-120b", "nvidia/llama-3.3-nemotron-super-49b-v1.5"],
    },
    {
      id: "huggingface",
      displayName: "Hugging Face Inference",
      transport: "openai-compatible",
      tierKind: "RECURRING_MONTHLY",
      tierLabel: "$0.10 routed credit · monthly",
      quotaSummary: "Free users currently receive $0.10/month for routed Inference Providers; BYOK calls do not use it.",
      docsUrl: "https://huggingface.co/docs/inference-providers/pricing",
      signupUrl: "https://huggingface.co/settings/tokens",
      credentialLabel: "Hugging Face token",
      credentialHelp: "Create a fine-grained token with Inference Providers permission. Do not select a BYOK provider if the routed credit is intended.",
      optionalCredential: false,
      needsAccountId: false,
      envKey: "HF_TOKEN",
      billingWarning: "The chip estimates only calls from this GGO. Provider keys configured in Hugging Face can bill those providers directly; explicit probes use an exact catalog provider and never auto-fail over.",
      usage: { quotaKind: "credits-usd", window: "month", timeZone: "UTC", limit: 0.1, unit: "USD credit", localEstimate: true, summary: "Calendar-month estimate using live per-provider catalog prices and GGO token usage; Hugging Face billing is authoritative." },
      adapter: huggingface,
      preferredModels: ["openai/gpt-oss-120b:deepinfra", "Qwen/Qwen3-Coder-480B-A35B-Instruct:novita", "zai-org/GLM-5.2:deepinfra"],
    },
  ];
}

export function createProviderRegistry(fetchImpl?: typeof fetch): ProviderDefinition[] {
  const compatible = createOpenAiDefinitions(fetchImpl);
  const byId = new Map(compatible.map((definition) => [definition.id, definition]));
  const gemini: ProviderDefinition = {
    id: "gemini",
    displayName: "Google Gemini API",
    transport: "native",
    tierKind: "RECURRING_DAILY",
    tierLabel: "API free tier · daily",
    quotaSummary: "Limits vary by model and project; active RPM/TPM/RPD live in Google AI Studio.",
    docsUrl: "https://ai.google.dev/gemini-api/docs/rate-limits",
    signupUrl: "https://aistudio.google.com/app/apikey",
    credentialLabel: "Gemini API key",
    credentialHelp: "Create a Google AI Studio key. GGO does not reuse Gemini CLI browser credentials.",
    optionalCredential: false,
    needsAccountId: false,
    envKey: "GEMINI_API_KEY",
    billingWarning: "Only currently verified free-tier Flash models are eligible. Limits are project-wide and dynamic; probes are manual only.",
    usage: { quotaKind: "mixed", window: "day", timeZone: "America/Los_Angeles", unit: "requests", localEstimate: true, summary: "Local request/token count; Google exposes exact active limits in AI Studio, not this API response." },
    adapter: new GeminiAdapter(fetchImpl),
    preferredModels: ["gemini-3.5-flash", "gemini-3.5-flash-lite", "gemini-3.1-flash-lite"],
  };
  const cohere: ProviderDefinition = {
    id: "cohere",
    displayName: "Cohere",
    transport: "native",
    tierKind: "RECURRING_MONTHLY",
    tierLabel: "Evaluation key · monthly",
    quotaSummary: "Evaluation keys currently receive 1,000 API calls/month; chat is commonly 20 RPM.",
    docsUrl: "https://docs.cohere.com/docs/rate-limits",
    signupUrl: "https://dashboard.cohere.com/api-keys",
    credentialLabel: "Cohere API key",
    credentialHelp: "Use a free evaluation key. A production key may follow a different billing policy.",
    optionalCredential: false,
    needsAccountId: false,
    envKey: "COHERE_API_KEY",
    billingWarning: "GGO cannot identify key type. Confirm this is an evaluation key; only explicit probes are enabled.",
    usage: { quotaKind: "requests", window: "month", timeZone: "UTC", limit: 1_000, unit: "API calls", localEstimate: true, summary: "Calendar-month estimate from calls made by this GGO instance; Cohere does not expose account-wide remaining calls here." },
    adapter: new CohereAdapter(fetchImpl),
    preferredModels: ["north-mini-code", "command-a-03-2025", "command-r7b-12-2024"],
  };
  const ordered = [gemini, byId.get("groq"), byId.get("openrouter"), byId.get("kilo"), byId.get("mistral"), cohere, byId.get("cloudflare"), byId.get("nvidia"), byId.get("huggingface")];
  return ordered.filter((definition): definition is ProviderDefinition => !!definition);
}
