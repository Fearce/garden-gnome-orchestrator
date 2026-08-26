import { randomBytes } from "node:crypto";
import { redactProviderText } from "./http.js";
import { credentialFingerprint, UsageLedger, type KvStore } from "./ledger.js";
import { createProviderRegistry, type ProviderDefinition } from "./registry.js";
import { formatUsageChip } from "./usageChip.js";
import {
  FREE_PROVIDER_IDS,
  ProviderRequestError,
  type FreeProviderDTO,
  type FreeProviderId,
  type ProviderCredentials,
  type ProviderHealth,
  type ProviderModel,
  type ProviderUsageSnapshot,
  type RateLimitReading,
} from "./types.js";

interface StoredProviderConfig {
  enabled: boolean;
  apiKey?: string;
  accountId?: string;
  selectedModel?: string;
}

interface StoredModels {
  checkedAt: string;
  models: ProviderModel[];
}

interface StoredRemoteUsage extends Partial<ProviderUsageSnapshot> {
  checkedAt: string;
  freeTier?: boolean;
  rateLimit?: RateLimitReading;
}

export interface ProviderConfigPatch {
  enabled?: boolean;
  apiKey?: string;
  clearApiKey?: boolean;
  accountId?: string;
  clearAccountId?: boolean;
  selectedModel?: string | null;
}

export interface ProviderProbeResult {
  provider: FreeProviderDTO;
  response: {
    text: string;
    model: string;
    upstreamProvider?: string;
    requestId?: string;
    inputTokens?: number;
    outputTokens?: number;
    latencyMs: number;
  };
}

const CONFIG_PREFIX = "free_ai_provider_config_v1_";
const MODEL_PREFIX = "free_ai_provider_models_v1_";
const HEALTH_PREFIX = "free_ai_provider_health_v1_";
const USAGE_PREFIX = "free_ai_provider_remote_usage_v1_";
const FINGERPRINT_SALT_KEY = "free_ai_provider_fingerprint_salt_v1";
const MODEL_CACHE_MAX = 500;
const REFRESH_MS = 6 * 60 * 60_000;

function parseJson<T>(raw: string | null): T | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

function lastFour(value: string | undefined): string | null {
  return value && value.length >= 4 ? value.slice(-4) : value ? value : null;
}

function finite(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function clampRemaining(limit: number | undefined, used: number | undefined): number | undefined {
  return limit != null && used != null ? Math.max(0, limit - used) : undefined;
}

function nextUtcReset(window: "day" | "month", now = new Date()): string {
  return window === "day"
    ? new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1)).toISOString()
    : new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)).toISOString();
}

export function stateForProviderError(error: ProviderRequestError): ProviderHealth["state"] {
  if (error.kind === "authentication") return "auth-error";
  if (error.kind === "billing") return "quota-exhausted";
  if (error.kind === "rate-limit") return "rate-limited";
  if (error.kind === "provider-outage" || error.kind === "timeout" || error.kind === "network") return "outage";
  return "misconfigured";
}

function cleanConfigPatch(patch: ProviderConfigPatch): ProviderConfigPatch {
  const output: ProviderConfigPatch = {};
  if (typeof patch.enabled === "boolean") output.enabled = patch.enabled;
  if (typeof patch.clearApiKey === "boolean") output.clearApiKey = patch.clearApiKey;
  if (typeof patch.clearAccountId === "boolean") output.clearAccountId = patch.clearAccountId;
  if (typeof patch.apiKey === "string") {
    const value = patch.apiKey.trim();
    if (value.length > 4_096 || /[\r\n\0]/.test(value)) throw new ProviderRequestError("API key is malformed.", "invalid-configuration");
    output.apiKey = value;
  }
  if (typeof patch.accountId === "string") {
    const value = patch.accountId.trim();
    if (value.length > 160 || (value && !/^[A-Za-z0-9_-]+$/.test(value))) {
      throw new ProviderRequestError("Account ID may contain only letters, numbers, underscores, and hyphens.", "invalid-configuration");
    }
    output.accountId = value;
  }
  if (patch.selectedModel === null) output.selectedModel = null;
  else if (typeof patch.selectedModel === "string") {
    const value = patch.selectedModel.trim();
    if (value.length > 300 || /[\r\n\0]/.test(value)) throw new ProviderRequestError("Model ID is malformed.", "invalid-configuration");
    output.selectedModel = value;
  }
  return output;
}

export function chooseFreeModel(definition: ProviderDefinition, models: ProviderModel[], selected?: string): ProviderModel | null {
  const free = models.filter((model) => model.isFree && !model.ineligibleReason);
  if (selected) {
    const exact = free.find((model) => model.id === selected);
    if (exact) return exact;
  }
  for (const preferred of definition.preferredModels) {
    const exact = free.find((model) => model.id === preferred);
    if (exact) return exact;
  }
  return free.sort((a, b) => a.displayName.localeCompare(b.displayName))[0] ?? null;
}

export class FreeProviderService {
  private readonly definitions: ProviderDefinition[];
  private readonly byId: Map<FreeProviderId, ProviderDefinition>;
  private readonly ledger: UsageLedger;
  private readonly salt: string;
  private readonly refreshes = new Map<FreeProviderId, Promise<FreeProviderDTO>>();
  private refreshTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly store: KvStore,
    private readonly environment: NodeJS.ProcessEnv = process.env,
    fetchImpl?: typeof fetch,
  ) {
    this.definitions = createProviderRegistry(fetchImpl);
    this.byId = new Map(this.definitions.map((definition) => [definition.id, definition]));
    this.ledger = new UsageLedger(store);
    const existingSalt = store.kvGet(FINGERPRINT_SALT_KEY);
    this.salt = existingSalt || randomBytes(32).toString("hex");
    if (!existingSalt) store.kvSet(FINGERPRINT_SALT_KEY, this.salt);
  }

  start(): void {
    if (this.refreshTimer) return;
    this.refreshTimer = setInterval(() => {
      for (const definition of this.definitions) {
        const { config, credentials } = this.context(definition);
        if (!config.enabled || !this.hasRequiredCredentials(definition, credentials)) continue;
        void this.refresh(definition.id).catch(() => undefined);
      }
    }, REFRESH_MS);
    this.refreshTimer.unref?.();
  }

  stop(): void {
    if (this.refreshTimer) clearInterval(this.refreshTimer);
    this.refreshTimer = null;
  }

  has(id: string): id is FreeProviderId {
    return (FREE_PROVIDER_IDS as readonly string[]).includes(id) && this.byId.has(id as FreeProviderId);
  }

  list(): FreeProviderDTO[] {
    return this.definitions.map((definition) => this.dto(definition));
  }

  get(id: FreeProviderId): FreeProviderDTO {
    return this.dto(this.requireDefinition(id));
  }

  update(id: FreeProviderId, rawPatch: ProviderConfigPatch): FreeProviderDTO {
    const definition = this.requireDefinition(id);
    const patch = cleanConfigPatch(rawPatch);
    const current = this.storedConfig(id);
    const next: StoredProviderConfig = { ...current };
    if (patch.enabled != null) next.enabled = patch.enabled;
    if (patch.clearApiKey) delete next.apiKey;
    else if (patch.apiKey !== undefined) {
      if (patch.apiKey) next.apiKey = patch.apiKey;
      else delete next.apiKey;
    }
    if (patch.clearAccountId) delete next.accountId;
    else if (patch.accountId !== undefined) {
      if (patch.accountId) next.accountId = patch.accountId;
      else delete next.accountId;
    }
    if (patch.selectedModel === null) delete next.selectedModel;
    else if (patch.selectedModel !== undefined) next.selectedModel = patch.selectedModel;
    this.store.kvSet(`${CONFIG_PREFIX}${id}`, JSON.stringify(next));

    const { credentials } = this.context(definition);
    if (!this.hasRequiredCredentials(definition, credentials)) {
      this.writeHealth(definition, credentials, {
        state: "awaiting-auth",
        message: this.missingCredentialMessage(definition, credentials),
        checkedAt: null,
      });
    } else if (patch.apiKey !== undefined || patch.clearApiKey || patch.accountId !== undefined || patch.clearAccountId) {
      this.writeHealth(definition, credentials, {
        state: "awaiting-validation",
        message: "Credentials saved server-side. Refresh models to validate them without consuming inference quota.",
        checkedAt: null,
      });
    }
    return this.dto(definition);
  }

  refresh(id: FreeProviderId): Promise<FreeProviderDTO> {
    const existing = this.refreshes.get(id);
    if (existing) return existing;
    const pending = this.refreshNow(id).finally(() => this.refreshes.delete(id));
    this.refreshes.set(id, pending);
    return pending;
  }

  private async refreshNow(id: FreeProviderId): Promise<FreeProviderDTO> {
    const definition = this.requireDefinition(id);
    const { config, credentials, fingerprint } = this.context(definition);
    if (!config.enabled) {
      throw new ProviderRequestError("Enable this provider before validating it.", "invalid-configuration");
    }
    this.assertCredentials(definition, credentials);
    try {
      const models = await definition.adapter.listModels(credentials);
      const normalized = this.cleanModels(definition, models);
      this.writeModels(definition, fingerprint, normalized);
      const selected = chooseFreeModel(definition, normalized, config.selectedModel);
      if (!selected) {
        throw new ProviderRequestError(
          `Connected, but none of the ${normalized.length} discovered models is currently verified as free. No request was sent.`,
          "invalid-configuration",
        );
      }
      if (config.selectedModel !== selected.id) this.saveSelectedModel(id, selected.id);
      if (definition.adapter.accountUsage) {
        const account = await definition.adapter.accountUsage(credentials);
        if (account) this.writeRemoteUsage(definition, fingerprint, { ...account, checkedAt: new Date().toISOString() } as StoredRemoteUsage);
      }
      this.writeHealth(definition, credentials, {
        state: "ready",
        message: `${normalized.filter((model) => model.isFree && !model.ineligibleReason).length} verified free model${normalized.filter((model) => model.isFree && !model.ineligibleReason).length === 1 ? "" : "s"} ready for manual probes. Task routing remains off.`,
        checkedAt: new Date().toISOString(),
      });
      return this.dto(definition);
    } catch (error) {
      const normalized = this.asProviderError(error, credentials);
      this.writeHealth(definition, credentials, {
        state: stateForProviderError(normalized),
        message: normalized.message,
        checkedAt: new Date().toISOString(),
        httpStatus: normalized.status,
        retryAt: normalized.retryAt,
      });
      throw normalized;
    }
  }

  async probe(id: FreeProviderId): Promise<ProviderProbeResult> {
    const definition = this.requireDefinition(id);
    const initial = this.context(definition);
    if (!initial.config.enabled) throw new ProviderRequestError("Enable this provider before probing it.", "invalid-configuration");
    this.assertCredentials(definition, initial.credentials);

    // A fresh catalog read immediately before inference is the paid-spillover circuit breaker.
    await this.refresh(id);
    const { config, credentials, fingerprint } = this.context(definition);
    const models = this.readModels(definition, fingerprint)?.models ?? [];
    const selected = chooseFreeModel(definition, models, config.selectedModel);
    if (!selected || selected.id !== config.selectedModel) {
      throw new ProviderRequestError("The selected model is no longer verified free. Refresh and choose an eligible model.", "invalid-model");
    }
    const started = Date.now();
    try {
      const completion = await definition.adapter.complete(credentials, {
        model: selected.id,
        messages: [
          { role: "system", content: "This is a connectivity probe. Do not use tools. Follow the user's exact output request." },
          { role: "user", content: "Reply with exactly READY." },
        ],
        maxOutputTokens: 16,
      });
      const estimatedUnits = definition.id === "cloudflare"
        ? ((completion.usage.inputTokens ?? 0) * (selected.unitsPerMillionInput ?? 0) +
            (completion.usage.outputTokens ?? 0) * (selected.unitsPerMillionOutput ?? 0)) / 1_000_000
        : undefined;
      const providerCostUsd = completion.usage.costUsd ?? (definition.id === "huggingface"
        ? ((completion.usage.inputTokens ?? 0) * (selected.inputPricePerMillion ?? 0) +
            (completion.usage.outputTokens ?? 0) * (selected.outputPricePerMillion ?? 0)) / 1_000_000
        : undefined);
      this.ledger.record({
        providerId: id,
        accountFingerprint: fingerprint,
        modelId: selected.id,
        responseStatus: "ok",
        inputTokens: completion.usage.inputTokens,
        outputTokens: completion.usage.outputTokens,
        providerCostUsd,
        estimatedUnits,
        freeClass: definition.tierKind,
        window: definition.usage.window,
        timeZone: definition.usage.timeZone,
      });
      if (completion.rateLimit) {
        this.writeRemoteUsage(definition, fingerprint, {
          ...(this.readRemoteUsage(definition, fingerprint) ?? {}),
          rateLimit: completion.rateLimit,
          source: "response-header",
          checkedAt: new Date().toISOString(),
        });
      }
      this.writeHealth(definition, credentials, {
        state: "ready",
        message: `Probe succeeded on ${completion.model}${completion.upstreamProvider ? ` via ${completion.upstreamProvider}` : ""}. Automatic task routing remains off.`,
        checkedAt: new Date().toISOString(),
      });
      const latencyMs = Date.now() - started;
      this.logProbe({ provider: id, model: completion.model, upstreamProvider: completion.upstreamProvider, requestId: completion.requestId, latencyMs, usage: completion.usage });
      return {
        provider: this.dto(definition),
        response: {
          text: completion.text.slice(0, 500),
          model: completion.model,
          upstreamProvider: completion.upstreamProvider,
          requestId: completion.requestId,
          inputTokens: completion.usage.inputTokens,
          outputTokens: completion.usage.outputTokens,
          latencyMs,
        },
      };
    } catch (error) {
      const normalized = this.asProviderError(error, credentials);
      this.ledger.record({
        providerId: id,
        accountFingerprint: fingerprint,
        modelId: selected.id,
        requestCount: 0,
        responseStatus: normalized.kind === "rate-limit" || normalized.kind === "billing" ? "rejected" : "failed",
        freeClass: definition.tierKind,
        window: definition.usage.window,
        timeZone: definition.usage.timeZone,
      });
      this.writeHealth(definition, credentials, {
        state: stateForProviderError(normalized),
        message: normalized.message,
        checkedAt: new Date().toISOString(),
        httpStatus: normalized.status,
        retryAt: normalized.retryAt,
      });
      this.logProbe({ provider: id, model: selected.id, latencyMs: Date.now() - started, errorKind: normalized.kind, status: normalized.status });
      throw normalized;
    }
  }

  private requireDefinition(id: FreeProviderId): ProviderDefinition {
    const definition = this.byId.get(id);
    if (!definition) throw new ProviderRequestError("Unknown free provider.", "invalid-configuration");
    return definition;
  }

  private storedConfig(id: FreeProviderId): StoredProviderConfig {
    const parsed = parseJson<Partial<StoredProviderConfig>>(this.store.kvGet(`${CONFIG_PREFIX}${id}`));
    return {
      enabled: parsed?.enabled === true,
      ...(typeof parsed?.apiKey === "string" && parsed.apiKey ? { apiKey: parsed.apiKey } : {}),
      ...(typeof parsed?.accountId === "string" && parsed.accountId ? { accountId: parsed.accountId } : {}),
      ...(typeof parsed?.selectedModel === "string" && parsed.selectedModel ? { selectedModel: parsed.selectedModel } : {}),
    };
  }

  private context(definition: ProviderDefinition): {
    config: StoredProviderConfig;
    credentials: ProviderCredentials;
    fingerprint: string;
    keySource: FreeProviderDTO["keySource"];
  } {
    const config = this.storedConfig(definition.id);
    const envKey = this.environment[definition.envKey]?.trim();
    const envAccount = definition.envAccountId ? this.environment[definition.envAccountId]?.trim() : undefined;
    const apiKey = config.apiKey || envKey;
    const accountId = config.accountId || envAccount;
    const credentials = { apiKey, accountId };
    const fingerprint = credentialFingerprint(`${apiKey ?? "anonymous"}|${accountId ?? ""}`, this.salt, `${definition.id}:anonymous`);
    return {
      config,
      credentials,
      fingerprint,
      keySource: config.apiKey ? "stored" : envKey ? "environment" : definition.optionalCredential ? "anonymous" : "none",
    };
  }

  private hasRequiredCredentials(definition: ProviderDefinition, credentials: ProviderCredentials): boolean {
    return (definition.optionalCredential || !!credentials.apiKey) && (!definition.needsAccountId || !!credentials.accountId);
  }

  private missingCredentialMessage(definition: ProviderDefinition, credentials: ProviderCredentials): string {
    if (!definition.optionalCredential && !credentials.apiKey) return `Add ${definition.credentialLabel} to continue.`;
    if (definition.needsAccountId && !credentials.accountId) return "Add the provider account ID to continue.";
    return "Provider credentials are incomplete.";
  }

  private assertCredentials(definition: ProviderDefinition, credentials: ProviderCredentials): void {
    if (!this.hasRequiredCredentials(definition, credentials)) {
      throw new ProviderRequestError(this.missingCredentialMessage(definition, credentials), "invalid-configuration");
    }
  }

  private modelKey(definition: ProviderDefinition, fingerprint: string): string {
    return `${MODEL_PREFIX}${definition.id}_${fingerprint}`;
  }

  private healthKey(definition: ProviderDefinition, credentials: ProviderCredentials): string {
    const fingerprint = credentialFingerprint(`${credentials.apiKey ?? "anonymous"}|${credentials.accountId ?? ""}`, this.salt, `${definition.id}:anonymous`);
    return `${HEALTH_PREFIX}${definition.id}_${fingerprint}`;
  }

  private usageKey(definition: ProviderDefinition, fingerprint: string): string {
    return `${USAGE_PREFIX}${definition.id}_${fingerprint}`;
  }

  private cleanModels(definition: ProviderDefinition, models: ProviderModel[]): ProviderModel[] {
    const unique = new Map<string, ProviderModel>();
    for (const model of models) {
      if (model.providerId !== definition.id || !model.id || model.id.length > 300) continue;
      unique.set(model.id, model);
    }
    return [...unique.values()]
      .sort((a, b) => Number(b.isFree) - Number(a.isFree) || a.displayName.localeCompare(b.displayName))
      .slice(0, MODEL_CACHE_MAX);
  }

  private readModels(definition: ProviderDefinition, fingerprint: string): StoredModels | null {
    const value = parseJson<StoredModels>(this.store.kvGet(this.modelKey(definition, fingerprint)));
    return value && Array.isArray(value.models) && typeof value.checkedAt === "string" ? value : null;
  }

  private writeModels(definition: ProviderDefinition, fingerprint: string, models: ProviderModel[]): void {
    this.store.kvSet(this.modelKey(definition, fingerprint), JSON.stringify({ checkedAt: new Date().toISOString(), models } satisfies StoredModels));
  }

  private readHealth(definition: ProviderDefinition, credentials: ProviderCredentials): ProviderHealth | null {
    return parseJson<ProviderHealth>(this.store.kvGet(this.healthKey(definition, credentials)));
  }

  private writeHealth(definition: ProviderDefinition, credentials: ProviderCredentials, health: ProviderHealth): void {
    this.store.kvSet(this.healthKey(definition, credentials), JSON.stringify(health));
  }

  private readRemoteUsage(definition: ProviderDefinition, fingerprint: string): StoredRemoteUsage | null {
    return parseJson<StoredRemoteUsage>(this.store.kvGet(this.usageKey(definition, fingerprint)));
  }

  private writeRemoteUsage(definition: ProviderDefinition, fingerprint: string, usage: StoredRemoteUsage): void {
    this.store.kvSet(this.usageKey(definition, fingerprint), JSON.stringify(usage));
  }

  private saveSelectedModel(id: FreeProviderId, selectedModel: string): void {
    const config = this.storedConfig(id);
    this.store.kvSet(`${CONFIG_PREFIX}${id}`, JSON.stringify({ ...config, selectedModel }));
  }

  private usage(definition: ProviderDefinition, fingerprint: string): ProviderUsageSnapshot {
    const policy = definition.usage;
    const aggregate = this.ledger.aggregate({
      providerId: definition.id,
      accountFingerprint: fingerprint,
      window: policy.window,
      timeZone: policy.timeZone,
    });
    const remote = this.readRemoteUsage(definition, fingerprint);
    const updated = new Date(remote?.checkedAt ?? aggregate.lastAt ?? Date.now()).toISOString();
    const tokenSecondary = aggregate.inputTokens || aggregate.outputTokens
      ? [
          { label: "Input recorded", used: aggregate.inputTokens, unit: "tokens" },
          { label: "Output recorded", used: aggregate.outputTokens, unit: "tokens" },
        ]
      : [];

    if (definition.id === "groq" && remote?.rateLimit) {
      const requests = remote.rateLimit.requests;
      const tokens = remote.rateLimit.tokens;
      return {
        providerId: definition.id,
        quotaKind: "mixed",
        source: "response-header",
        used: requests?.limit != null && requests.remaining != null ? requests.limit - requests.remaining : undefined,
        remaining: requests?.remaining,
        limit: requests?.limit,
        unit: "requests/day",
        window: "day",
        resetAt: requests?.resetAt,
        lastUpdatedAt: updated,
        estimated: false,
        stale: Date.now() - Date.parse(remote.checkedAt) > REFRESH_MS,
        secondaryLimits: [
          ...(tokens ? [{ label: "Token rate", limit: tokens.limit, remaining: tokens.remaining, unit: "tokens/minute", resetAt: tokens.resetAt }] : []),
          ...tokenSecondary,
        ],
        message: "Exact values from the latest Groq response headers; account activity elsewhere may change them.",
      };
    }

    let limit = policy.limit;
    const used = definition.id === "cloudflare"
      ? aggregate.estimatedUnits
      : definition.id === "mistral" || definition.id === "huggingface"
        ? (aggregate.costUsd || undefined)
        : definition.id === "nvidia"
          ? undefined
          : aggregate.requests;
    // Cloudflare is the only integrated provider that publishes a fixed reset boundary (00:00 UTC).
    // For monthly plans and other daily caps, showing a guessed date is worse than showing the window.
    const resetAt = definition.id === "cloudflare" ? nextUtcReset("day") : undefined;
    const secondaryLimits = [
      ...(remote?.secondaryLimits ?? []),
      ...(["mistral", "gemini", "cloudflare", "nvidia", "huggingface"].includes(definition.id)
        ? [{ label: "GGO requests", used: aggregate.requests, unit: "requests" }]
        : []),
      ...tokenSecondary,
    ];
    return {
      providerId: definition.id,
      quotaKind: policy.quotaKind,
      source: remote?.source ?? (limit != null ? "published-limit" : aggregate.requests ? "local-estimate" : "unknown"),
      used,
      remaining: clampRemaining(limit, used),
      limit,
      unit: policy.unit,
      window: policy.window,
      resetAt,
      lastUpdatedAt: updated,
      estimated: true,
      secondaryLimits,
      message: remote?.message ?? policy.summary,
    };
  }

  private dto(definition: ProviderDefinition): FreeProviderDTO {
    const { config, credentials, fingerprint, keySource } = this.context(definition);
    const models = this.readModels(definition, fingerprint)?.models ?? [];
    const selected = chooseFreeModel(definition, models, config.selectedModel);
    const configured = this.hasRequiredCredentials(definition, credentials);
    const savedHealth = this.readHealth(definition, credentials);
    const health: ProviderHealth = !config.enabled
      ? { state: "disabled", message: "Disabled. No background checks or inference requests will run.", checkedAt: savedHealth?.checkedAt ?? null }
      : !configured
        ? { state: "awaiting-auth", message: this.missingCredentialMessage(definition, credentials), checkedAt: null }
        : savedHealth ?? { state: "awaiting-validation", message: "Ready to validate credentials and discover models without an inference request.", checkedAt: null };
    const usage = this.usage(definition, fingerprint);
    usage.displayLabel = formatUsageChip({ usage, state: health.state, configured, optionalCredential: definition.optionalCredential });
    return {
      id: definition.id,
      displayName: definition.displayName,
      transport: definition.transport,
      tierKind: definition.tierKind,
      tierLabel: definition.tierLabel,
      quotaSummary: definition.quotaSummary,
      docsUrl: definition.docsUrl,
      signupUrl: definition.signupUrl,
      credentialLabel: definition.credentialLabel,
      credentialHelp: definition.credentialHelp,
      optionalCredential: definition.optionalCredential,
      needsAccountId: definition.needsAccountId,
      enabled: config.enabled,
      configured,
      keyPresent: !!credentials.apiKey,
      keyLast4: lastFour(credentials.apiKey),
      keySource,
      accountIdPresent: !!credentials.accountId,
      accountIdLast4: lastFour(credentials.accountId),
      selectedModel: selected?.id ?? config.selectedModel ?? null,
      models,
      health,
      usage,
      capabilities: {
        modelDiscovery: true,
        streaming: true,
        tools: "model-dependent",
        exactUsage: definition.id === "groq",
        localEstimate: true,
        taskRouting: false,
      },
      billingWarning: definition.billingWarning,
      routing: {
        eligible: false,
        reason: "Connection lab only: plain inference APIs are not a proven GGO coding-agent harness, so they cannot enter task routing or failover yet.",
      },
    };
  }

  private asProviderError(error: unknown, credentials: ProviderCredentials): ProviderRequestError {
    if (error instanceof ProviderRequestError) return error;
    return new ProviderRequestError(
      redactProviderText(error instanceof Error ? error.message : "Unexpected provider failure.", [credentials.apiKey ?? "", credentials.accountId ?? ""]),
      "unknown",
    );
  }

  private logProbe(event: Record<string, unknown>): void {
    // Deliberately excludes credentials, request headers, and prompt/response content.
    console.info(`[free-provider] ${JSON.stringify({ event: "probe", ...event })}`);
  }
}
