import { randomBytes } from "node:crypto";
import { config } from "../config.js";
import type { FreeProviderTaskSession } from "./agentRun.js";
import { redactProviderText } from "./http.js";
import { credentialFingerprint, UsageLedger, type KvStore } from "./ledger.js";
import { createProviderRegistry, type ProviderDefinition } from "./registry.js";
import { classifyFreeTask, type FreeTaskPolicyDecision, type FreeTaskPolicyInput } from "./taskPolicy.js";
import { formatUsageChip } from "./usageChip.js";
import {
  FREE_PROVIDER_IDS,
  ProviderRequestError,
  type FreeProviderDTO,
  type FreeProviderId,
  type FreeProviderTaskRole,
  type NormalizedCompletion,
  type NormalizedCompletionRequest,
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

export interface FreeProviderRoutingDTO {
  enabled: boolean;
  active: boolean;
  roles: FreeProviderTaskRole[];
  eligibleProviders: number;
  eligibleProviderIds: FreeProviderId[];
  reason: string;
  policy: {
    mode: "small-only";
    summary: string;
    maxBriefChars: number;
    maxBriefWords: number;
    maxModelCalls: number;
    maxToolCalls: number;
    maxTotalTokens: number;
    requireVisibleQuota: boolean;
  };
}

type RoutingDecision = { eligible: boolean; reason: string; model?: ProviderModel };

export interface FreeTaskRouteResult {
  policy: FreeTaskPolicyDecision;
  session: FreeProviderTaskSession | null;
  poolEnabled: boolean;
  /** Why a policy-eligible task did not receive a lease (pool off, quota/headroom, auth, etc.). */
  availabilityReason?: string;
}

/**
 * One Settings snapshot asks for both provider cards and the pool status. Reusing these pure
 * read calculations prevents every card/routing check from reparsing the bounded usage ledger.
 * It deliberately lives only for one synchronous response; writes and task routing never see a
 * cached health, catalog, or quota value.
 */
interface ProviderSnapshotMemo {
  usage: Map<string, ProviderUsageSnapshot>;
  routing: Map<FreeProviderId, RoutingDecision>;
}

const CONFIG_PREFIX = "free_ai_provider_config_v1_";
const MODEL_PREFIX = "free_ai_provider_models_v1_";
const HEALTH_PREFIX = "free_ai_provider_health_v1_";
const USAGE_PREFIX = "free_ai_provider_remote_usage_v1_";
const FINGERPRINT_SALT_KEY = "free_ai_provider_fingerprint_salt_v1";
const ROUTING_CONFIG_KEY = "free_ai_provider_routing_v1";
const MODEL_CACHE_MAX = 500;
const REFRESH_MS = 6 * 60 * 60_000;
const ROUTING_FAILURE_COOLDOWN_MS = 10 * 60_000;
const ROUTING_ROLES: FreeProviderTaskRole[] = ["planner", "reader"];

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

/** Task routing is stricter than probing: an explicit tool-capability signal is mandatory. */
export function chooseFreeTaskModel(definition: ProviderDefinition, models: ProviderModel[], selected?: string): ProviderModel | null {
  const capable = models.filter((model) => model.isFree && !model.ineligibleReason && model.supportsTools === true);
  if (selected) {
    const exact = capable.find((model) => model.id === selected);
    if (exact) return exact;
  }
  for (const preferred of definition.preferredModels) {
    const exact = capable.find((model) => model.id === preferred);
    if (exact) return exact;
  }
  return capable.sort((a, b) => (b.contextWindow ?? 0) - (a.contextWindow ?? 0) || a.displayName.localeCompare(b.displayName))[0] ?? null;
}

export class FreeProviderService {
  private readonly definitions: ProviderDefinition[];
  private readonly byId: Map<FreeProviderId, ProviderDefinition>;
  private readonly ledger: UsageLedger;
  private readonly salt: string;
  private readonly refreshes = new Map<FreeProviderId, Promise<FreeProviderDTO>>();
  private readonly routingLeases = new Map<FreeProviderId, number>();
  private readonly routingCooldowns = new Map<FreeProviderId, { until: number; reason: string }>();
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
    // Revalidate saved connections once after boot so a fixed adapter/self-healed credential does not
    // remain stuck in yesterday's error state until the six-hour timer or a manual Settings click.
    const bootRefresh = setTimeout(() => this.refreshConfigured(), 750);
    bootRefresh.unref?.();
    this.refreshTimer = setInterval(() => this.refreshConfigured(), REFRESH_MS);
    this.refreshTimer.unref?.();
  }

  stop(): void {
    if (this.refreshTimer) clearInterval(this.refreshTimer);
    this.refreshTimer = null;
  }

  private refreshConfigured(): void {
    for (const definition of this.definitions) {
      const { config, credentials } = this.context(definition);
      if (!config.enabled || !this.hasRequiredCredentials(definition, credentials)) continue;
      void this.refresh(definition.id).catch(() => undefined);
    }
  }

  has(id: string): id is FreeProviderId {
    return (FREE_PROVIDER_IDS as readonly string[]).includes(id) && this.byId.has(id as FreeProviderId);
  }

  list(): FreeProviderDTO[] {
    return this.listWithMemo(this.snapshotMemo());
  }

  get(id: FreeProviderId): FreeProviderDTO {
    return this.dto(this.requireDefinition(id));
  }

  routingStatus(): FreeProviderRoutingDTO {
    return this.routingStatusWithMemo(this.snapshotMemo());
  }

  /** Read the cards and summary from one consistent, per-request ledger/cache view. */
  snapshot(): { providers: FreeProviderDTO[]; routing: FreeProviderRoutingDTO } {
    const memo = this.snapshotMemo();
    return { providers: this.listWithMemo(memo), routing: this.routingStatusWithMemo(memo) };
  }

  private snapshotMemo(): ProviderSnapshotMemo {
    return { usage: new Map(), routing: new Map() };
  }

  private listWithMemo(memo: ProviderSnapshotMemo): FreeProviderDTO[] {
    return this.definitions.map((definition) => this.dto(definition, memo));
  }

  private routingStatusWithMemo(memo: ProviderSnapshotMemo): FreeProviderRoutingDTO {
    const enabled = this.routingEnabled();
    const decisions = enabled
      ? this.definitions.map((definition) => ({ definition, decision: this.taskRoutingDecision(definition, memo) }))
      : [];
    const eligibleProviderIds = decisions.filter(({ decision }) => decision.eligible).map(({ definition }) => definition.id);
    const unavailableReasons = [...new Set(decisions.map(({ decision }) => decision.reason).filter(Boolean))].slice(0, 3);
    return {
      enabled,
      active: enabled && eligibleProviderIds.length > 0,
      roles: [...ROUTING_ROLES],
      eligibleProviders: eligibleProviderIds.length,
      eligibleProviderIds,
      reason: !enabled
        ? "Free task routing is off. Connections and quota checks remain available; enabling it still admits only confidently small work."
        : eligibleProviderIds.length
          ? `${eligibleProviderIds.length} connected provider${eligibleProviderIds.length === 1 ? " has" : "s have"} enough verified allowance for one bounded small task; every failure falls back to the reliable provider ladder.`
          : `No free provider can safely admit a bounded task right now${unavailableReasons.length ? `: ${unavailableReasons.join("; ")}` : "."}`,
      policy: {
        mode: "small-only",
        summary: "First attempt only: explicit read-lane lookups or narrow low-effort plans. Broad, risky, uncertain, retried, continued, and attachment-based work stays on reliable providers.",
        maxBriefChars: config.freeTaskPolicy.maxBriefChars,
        maxBriefWords: config.freeTaskPolicy.maxBriefWords,
        maxModelCalls: config.freeTaskPolicy.maxModelCalls,
        maxToolCalls: config.freeTaskPolicy.maxToolCalls,
        maxTotalTokens: config.freeTaskPolicy.maxTotalTokens,
        requireVisibleQuota: config.freeTaskPolicy.requireVisibleQuota,
      },
    };
  }

  setRoutingEnabled(enabled: boolean): FreeProviderRoutingDTO {
    this.store.kvSet(ROUTING_CONFIG_KEY, JSON.stringify({ enabled }));
    return this.routingStatus();
  }

  /**
   * Apply the small-task policy, then reserve the least-used capacity-safe provider and revalidate its
   * live free catalog before inference. A null lease is an ordinary fallback signal: ThreadManager
   * continues through its reliable provider ladder. Keeping classification inside this only public
   * lease seam prevents a future caller from accidentally treating the free pool as a default backend.
   */
  async routeTask(input: FreeTaskPolicyInput): Promise<FreeTaskRouteResult> {
    const policy = classifyFreeTask(input);
    const poolEnabled = this.routingEnabled();
    if (!policy.eligible) return { policy, session: null, poolEnabled, availabilityReason: policy.reason };
    if (!ROUTING_ROLES.includes(input.role) || !poolEnabled) {
      return { policy, session: null, poolEnabled, availabilityReason: "The free task pool is turned off." };
    }
    const attempted = new Set<FreeProviderId>();
    while (attempted.size < this.definitions.length) {
      const candidate = this.routingCandidates(attempted)[0];
      if (!candidate) return { policy, session: null, poolEnabled, availabilityReason: this.routingStatus().reason };
      attempted.add(candidate.definition.id);
      try {
        // Catalog validation is non-inference and is the hard no-paid-spill circuit breaker.
        await this.refresh(candidate.definition.id);
      } catch {
        continue;
      }
      const fresh = this.taskRoutingDecision(candidate.definition);
      if (!fresh.eligible || !fresh.model) continue;
      const { credentials, fingerprint } = this.context(candidate.definition);
      const providerId = candidate.definition.id;
      this.routingLeases.set(providerId, (this.routingLeases.get(providerId) ?? 0) + 1);
      let closed = false;
      const session: FreeProviderTaskSession = {
        target: { providerId, providerName: candidate.definition.displayName, model: fresh.model.id },
        complete: (request) => this.completeTask(candidate.definition, credentials, fingerprint, fresh.model!, request),
        markHarnessFailure: (reason) => {
          this.routingCooldowns.set(providerId, { until: Date.now() + ROUTING_FAILURE_COOLDOWN_MS, reason: redactProviderText(reason, [credentials.apiKey ?? "", credentials.accountId ?? ""]) });
        },
        close: () => {
          if (closed) return;
          closed = true;
          const remaining = Math.max(0, (this.routingLeases.get(providerId) ?? 1) - 1);
          if (remaining) this.routingLeases.set(providerId, remaining);
          else this.routingLeases.delete(providerId);
        },
      };
      return { policy, session, poolEnabled };
    }
    return { policy, session: null, poolEnabled, availabilityReason: this.routingStatus().reason };
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
      // An owner's explicit free-model choice is useful even when it cannot serve the read-only
      // harness (for example, a model they only want to probe). Routing must fail closed for that
      // choice; it must not silently replace it during a routine six-hour refresh. If the explicit
      // model disappeared or became non-free, fall back to a routing-capable default when routing is
      // enabled, otherwise use the normal probe-safe preference.
      const explicitlySelected = config.selectedModel
        ? normalized.find((model) => model.id === config.selectedModel && model.isFree && !model.ineligibleReason) ?? null
        : null;
      const selectedBecameIneligible = !!config.selectedModel && !explicitlySelected;
      const selected = explicitlySelected ??
        (this.routingEnabled()
          ? chooseFreeTaskModel(definition, normalized) ?? chooseFreeModel(definition, normalized)
          : chooseFreeModel(definition, normalized));
      if (!selected) {
        throw new ProviderRequestError(
          `Connected, but none of the ${normalized.length} discovered models is currently verified as free. No request was sent.`,
          "invalid-configuration",
        );
      }
      // Persist only an initial default. A saved selection may be temporarily ineligible because
      // pricing or tool metadata changed; replacing it during refresh turns a transient catalog
      // change into a permanent, invisible owner-choice mutation. The DTO can safely present a
      // currently eligible fallback for validation, while the original choice is retained for a
      // later catalog recovery or an explicit Settings change.
      if (!config.selectedModel) this.saveSelectedModel(id, selected.id);
      if (selectedBecameIneligible) {
        this.writeHealth(definition, credentials, {
          state: "misconfigured",
          message: `The selected model ${config.selectedModel} is no longer verified free. Choose another verified free model; no inference request was sent.`,
          checkedAt: new Date().toISOString(),
        });
        return this.dto(definition);
      }
      if (definition.adapter.accountUsage) {
        const account = await definition.adapter.accountUsage(credentials);
        if (account) this.writeRemoteUsage(definition, fingerprint, { ...account, checkedAt: new Date().toISOString() } as StoredRemoteUsage);
      }
      this.writeHealth(definition, credentials, {
        state: "ready",
        message: selected.supportsTools === true
          ? `${normalized.filter((model) => model.isFree && !model.ineligibleReason).length} verified free model${normalized.filter((model) => model.isFree && !model.ineligibleReason).length === 1 ? "" : "s"}; ${selected.displayName} is ready for conservative small-task admission.`
          : `${normalized.filter((model) => model.isFree && !model.ineligibleReason).length} verified free model${normalized.filter((model) => model.isFree && !model.ineligibleReason).length === 1 ? "" : "s"}. The selected model does not explicitly report tool support, so task routing stays fail-closed.`,
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
      this.recordCompletion(definition, fingerprint, selected, completion);
      this.writeHealth(definition, credentials, {
        state: "ready",
        message: `Probe succeeded on ${completion.model}${completion.upstreamProvider ? ` via ${completion.upstreamProvider}` : ""}.${selected.supportsTools === true ? " This model can enter the small-task pool when quota admission also passes." : " Task routing still requires explicit catalog tool support."}`,
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
      this.recordFailure(definition, fingerprint, selected, normalized);
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

  private routingEnabled(): boolean {
    const stored = parseJson<{ enabled?: unknown }>(this.store.kvGet(ROUTING_CONFIG_KEY));
    // Credentials may belong to a paid-capable project even when its selected model is free. Never
    // turn an old connection-lab credential into autonomous traffic without a persisted owner opt-in.
    return stored?.enabled === true;
  }

  /** Model/auth/free-price safety shared by lease admission and every later tool-loop completion. */
  private baseRoutingDecision(definition: ProviderDefinition, memo?: ProviderSnapshotMemo): RoutingDecision {
    const finish = (decision: RoutingDecision): RoutingDecision => decision;
    const { config, credentials, fingerprint } = this.context(definition);
    if (!this.routingEnabled()) return finish({ eligible: false, reason: "The free task pool is turned off." });
    if (!config.enabled) return finish({ eligible: false, reason: "Provider connection is disabled." });
    if (!this.hasRequiredCredentials(definition, credentials)) return finish({ eligible: false, reason: this.missingCredentialMessage(definition, credentials) });
    const health = this.readHealth(definition, credentials);
    if (health?.state !== "ready") return finish({ eligible: false, reason: health?.message ?? "Validate the provider before routing tasks." });
    const cooldown = this.routingCooldowns.get(definition.id);
    if (cooldown && cooldown.until > Date.now()) {
      return finish({ eligible: false, reason: `Temporarily resting this model after a harness failure: ${cooldown.reason}` });
    }
    if (cooldown) this.routingCooldowns.delete(definition.id);
    const models = this.readModels(definition, fingerprint)?.models ?? [];
    if (config.selectedModel && !models.some((candidate) => candidate.id === config.selectedModel && candidate.isFree && !candidate.ineligibleReason)) {
      return finish({ eligible: false, reason: `The selected model ${config.selectedModel} is no longer verified free. Choose another model before routing tasks.` });
    }
    const model = chooseFreeModel(definition, models, config.selectedModel);
    if (!model) return finish({ eligible: false, reason: "No currently verified free model is selected." });
    if (model.supportsTools !== true) return finish({ eligible: false, reason: `${model.displayName} does not explicitly report tool support; routing fails closed.` });
    if (model.contextWindow != null && model.contextWindow < 16_000) return finish({ eligible: false, reason: `${model.displayName}'s context window is too small for repository planning.` });
    const usage = this.usage(definition, fingerprint, memo);
    if (usage.remaining != null && usage.remaining <= 0) return finish({ eligible: false, reason: "The visible free allowance is exhausted." });
    return finish({ eligible: true, reason: `${model.displayName} is verified free and tool-capable. Small-task admission still requires enough visible allowance.`, model });
  }

  /** Admission is stricter than an in-flight completion: reserve enough visible quota for the whole
   * bounded run up front, while later turns only need the provider to remain basically eligible. */
  private taskRoutingDecision(definition: ProviderDefinition, memo?: ProviderSnapshotMemo): RoutingDecision {
    const cached = memo?.routing.get(definition.id);
    if (cached) return cached;
    const finish = (decision: RoutingDecision): RoutingDecision => {
      memo?.routing.set(definition.id, decision);
      return decision;
    };
    const base = this.baseRoutingDecision(definition, memo);
    if (!base.eligible || !base.model) return finish(base);
    const { fingerprint } = this.context(definition);
    const usage = this.usage(definition, fingerprint, memo);
    if (usage.stale) return finish({ eligible: false, reason: "The last free-quota signal is stale; refresh it before autonomous routing." });

    const now = Date.now();
    const activeSecondary = (usage.secondaryLimits ?? []).filter((limit) => !limit.resetAt || Date.parse(limit.resetAt) > now);
    const visibleRemaining = usage.remaining != null || activeSecondary.some((limit) => limit.remaining != null);
    if (config.freeTaskPolicy.requireVisibleQuota && !visibleRemaining) {
      return finish({ eligible: false, reason: "Remaining free allowance is not visible, so autonomous routing fails closed." });
    }

    const requestHeadroom = Math.max(config.freeTaskPolicy.maxModelCalls, config.freeTaskPolicy.minRequestHeadroom);
    // Every active session already reserved one complete worst-case run. Count those reservations
    // before granting another lease so concurrent small tasks cannot all spend the same last calls.
    const activeLeases = this.routingLeases.get(definition.id) ?? 0;
    const requestRemaining = usage.remaining == null ? undefined : usage.remaining - activeLeases * requestHeadroom;
    if ((usage.quotaKind === "requests" || usage.quotaKind === "mixed") && requestRemaining != null && requestRemaining < requestHeadroom) {
      return finish({
        eligible: false,
        reason: `Only ${Math.max(0, requestRemaining)} unreserved request${requestRemaining === 1 ? " remains" : "s remain"}; a bounded task reserves ${requestHeadroom} to avoid timing out mid-run.`,
      });
    }

    const tokenLimit = activeSecondary.find((limit) => /tokens?/i.test(limit.unit) && limit.remaining != null);
    const tokenRemaining = tokenLimit?.remaining == null
      ? undefined
      : tokenLimit.remaining - activeLeases * config.freeTaskPolicy.maxTotalTokens;
    if (tokenRemaining != null && tokenRemaining < config.freeTaskPolicy.maxTotalTokens) {
      return finish({
        eligible: false,
        reason: `Only ${Math.max(0, tokenRemaining)} unreserved ${tokenLimit!.unit} remain in the active rate window; the bounded task budget is ${config.freeTaskPolicy.maxTotalTokens}.`,
      });
    }

    if (usage.quotaKind === "credits-usd" && usage.remaining != null) {
      const price = Math.max(base.model.inputPricePerMillion ?? 0, base.model.outputPricePerMillion ?? 0);
      const required = price * config.freeTaskPolicy.maxTotalTokens / 1_000_000;
      if (required > 0 && usage.remaining - activeLeases * required < required) {
        return finish({ eligible: false, reason: `The visible free credit cannot cover the bounded ${config.freeTaskPolicy.maxTotalTokens}-token budget.` });
      }
    }

    if (usage.quotaKind === "neurons" && usage.remaining != null) {
      const units = Math.max(base.model.unitsPerMillionInput ?? 0, base.model.unitsPerMillionOutput ?? 0);
      const required = units * config.freeTaskPolicy.maxTotalTokens / 1_000_000;
      if (required > 0 && usage.remaining - activeLeases * required < required) {
        return finish({ eligible: false, reason: `The visible Neuron allowance cannot cover the bounded ${config.freeTaskPolicy.maxTotalTokens}-token budget.` });
      }
    }

    return finish({
      eligible: true,
      reason: `${base.model.displayName} has verified free/tool capability and enough visible headroom for one bounded small task.`,
      model: base.model,
    });
  }

  private routingCandidates(exclude: ReadonlySet<FreeProviderId>): Array<{ definition: ProviderDefinition; score: number }> {
    return this.definitions
      .filter((definition) => !exclude.has(definition.id) && this.taskRoutingDecision(definition).eligible)
      .map((definition) => {
        const { fingerprint } = this.context(definition);
        const requests = this.ledger.aggregate({
          providerId: definition.id,
          accountFingerprint: fingerprint,
          window: definition.usage.window,
          timeZone: definition.usage.timeZone,
        }).requests;
        // An in-flight lease is deliberately expensive so simultaneous tasks spread across accounts.
        return { definition, score: requests + (this.routingLeases.get(definition.id) ?? 0) * 1_000 };
      })
      .sort((a, b) => a.score - b.score || a.definition.id.localeCompare(b.definition.id));
  }

  private async completeTask(
    definition: ProviderDefinition,
    credentials: ProviderCredentials,
    fingerprint: string,
    model: ProviderModel,
    request: Omit<NormalizedCompletionRequest, "model">,
  ): Promise<NormalizedCompletion> {
    // A task session is deliberately bound to the credential set it leased. If the owner rotates or
    // removes that credential while a model is between tool calls, never send the next turn with the
    // stale secret captured by the closure.
    if (this.context(definition).fingerprint !== fingerprint) {
      throw new ProviderRequestError("The provider credential changed during this task; retrying through the normal fallback path.", "invalid-configuration");
    }
    // A task can contain many tool turns. Rechecking only when the lease opens leaves a window for
    // a formerly zero-priced catalog entry to become billable before a later turn. Model discovery
    // is non-inference, so refresh before every completion and fail closed rather than silently
    // switching this pinned task to another model or risking a paid call.
    await this.refresh(definition.id);
    const current = this.baseRoutingDecision(definition);
    if (!current.eligible || current.model?.id !== model.id) {
      throw new ProviderRequestError(current.reason || "The free model is no longer routing-eligible.", "invalid-model");
    }
    try {
      const completion = await definition.adapter.complete(credentials, { ...request, model: model.id });
      this.recordCompletion(definition, fingerprint, model, completion);
      this.writeHealth(definition, credentials, {
        state: "ready",
        message: `Free task request succeeded on ${completion.model}${completion.upstreamProvider ? ` via ${completion.upstreamProvider}` : ""}. Conservative small-task routing remains active.`,
        checkedAt: new Date().toISOString(),
      });
      this.logProbe({ event: "task", provider: definition.id, model: completion.model, upstreamProvider: completion.upstreamProvider, requestId: completion.requestId, usage: completion.usage });
      return completion;
    } catch (error) {
      const normalized = this.asProviderError(error, credentials);
      this.recordFailure(definition, fingerprint, model, normalized);
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

  private recordCompletion(definition: ProviderDefinition, fingerprint: string, model: ProviderModel, completion: NormalizedCompletion): void {
    const estimatedUnits = definition.id === "cloudflare"
      ? ((completion.usage.inputTokens ?? 0) * (model.unitsPerMillionInput ?? 0) +
          (completion.usage.outputTokens ?? 0) * (model.unitsPerMillionOutput ?? 0)) / 1_000_000
      : undefined;
    const providerCostUsd = completion.usage.costUsd ?? (definition.id === "huggingface"
      ? ((completion.usage.inputTokens ?? 0) * (model.inputPricePerMillion ?? 0) +
          (completion.usage.outputTokens ?? 0) * (model.outputPricePerMillion ?? 0)) / 1_000_000
      : undefined);
    this.ledger.record({
      providerId: definition.id,
      accountFingerprint: fingerprint,
      modelId: model.id,
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
  }

  private recordFailure(definition: ProviderDefinition, fingerprint: string, model: ProviderModel, error: ProviderRequestError): void {
    this.ledger.record({
      providerId: definition.id,
      accountFingerprint: fingerprint,
      modelId: model.id,
      requestCount: 0,
      responseStatus: error.kind === "rate-limit" || error.kind === "billing" ? "rejected" : "failed",
      freeClass: definition.tierKind,
      window: definition.usage.window,
      timeZone: definition.usage.timeZone,
    });
  }

  private usage(definition: ProviderDefinition, fingerprint: string, memo?: ProviderSnapshotMemo): ProviderUsageSnapshot {
    const cacheKey = `${definition.id}:${fingerprint}`;
    const cached = memo?.usage.get(cacheKey);
    if (cached) return cached;
    const finish = (usage: ProviderUsageSnapshot): ProviderUsageSnapshot => {
      memo?.usage.set(cacheKey, usage);
      return usage;
    };
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
      return finish({
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
      });
    }

    let limit = policy.limit;
    // OpenRouter's key endpoint distinguishes its published 50/day free tier from the 1,000/day
    // tier unlocked by a sufficiently funded account. The request count is still only GGO-local,
    // so it remains visibly estimated even when the tier marker was provider-reported.
    if (definition.id === "openrouter" && remote?.freeTier === false) limit = 1_000;
    const used = definition.id === "cloudflare"
      ? aggregate.estimatedUnits
      : definition.id === "mistral" || definition.id === "huggingface"
        ? aggregate.costUsd
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
    return finish({
      providerId: definition.id,
      quotaKind: policy.quotaKind,
      source: definition.id === "openrouter"
        ? "local-estimate"
        : remote?.source ?? (limit != null ? "published-limit" : aggregate.requests ? "local-estimate" : "unknown"),
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
    });
  }

  private dto(definition: ProviderDefinition, memo?: ProviderSnapshotMemo): FreeProviderDTO {
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
    const usage = this.usage(definition, fingerprint, memo);
    const routing = this.taskRoutingDecision(definition, memo);
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
      // Keep the owner's explicit selection visible even when a fresh catalog has made it ineligible.
      // The card renders that state as an actionable disabled option rather than pretending a fallback
      // was selected; routing and probes separately block until the owner picks a verified free model.
      selectedModel: config.selectedModel ?? selected?.id ?? null,
      models,
      health,
      usage,
      capabilities: {
        modelDiscovery: true,
        streaming: true,
        tools: "model-dependent",
        exactUsage: definition.id === "groq",
        localEstimate: true,
        taskRouting: true,
      },
      billingWarning: definition.billingWarning,
      routing: {
        eligible: routing.eligible,
        reason: routing.reason,
        roles: [...ROUTING_ROLES],
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
