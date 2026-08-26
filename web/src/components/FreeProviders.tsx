import { useEffect, useMemo, useState } from "react";
import { apiUrl } from "../lib/base.js";

type ProviderState =
  | "disabled"
  | "awaiting-auth"
  | "awaiting-validation"
  | "ready"
  | "auth-error"
  | "misconfigured"
  | "quota-exhausted"
  | "rate-limited"
  | "outage";

interface UsageLimit {
  label: string;
  used?: number;
  remaining?: number;
  limit?: number;
  unit: string;
  resetAt?: string;
}

interface UsageSnapshot {
  source: string;
  used?: number;
  remaining?: number;
  limit?: number;
  unit?: string;
  window?: string;
  resetAt?: string;
  lastUpdatedAt: string;
  estimated: boolean;
  stale?: boolean;
  secondaryLimits?: UsageLimit[];
  message?: string;
  displayLabel?: string;
}

interface ProviderModel {
  id: string;
  displayName: string;
  contextWindow?: number;
  supportsTools: boolean | null;
  isFree: boolean;
  ineligibleReason?: string;
}

interface FreeProvider {
  id: string;
  displayName: string;
  transport: string;
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
  health: { state: ProviderState; message: string; checkedAt: string | null; retryAt?: string };
  usage: UsageSnapshot;
  billingWarning: string;
  routing: { eligible: false; reason: string };
}

interface ProviderResponse {
  provider: FreeProvider;
  response?: { text: string; model: string; upstreamProvider?: string; inputTokens?: number; outputTokens?: number; latencyMs: number };
}

const STATE_LABEL: Record<ProviderState, string> = {
  disabled: "Disabled",
  "awaiting-auth": "Awaiting auth",
  "awaiting-validation": "Needs validation",
  ready: "Ready to probe",
  "auth-error": "Auth rejected",
  misconfigured: "Needs attention",
  "quota-exhausted": "Quota exhausted",
  "rate-limited": "Rate limited",
  outage: "Provider unavailable",
};

function compact(value: number): string {
  return new Intl.NumberFormat("en", { maximumFractionDigits: value < 100 ? 1 : 0, notation: value >= 10_000 ? "compact" : "standard" }).format(value);
}

function money(value: number): string {
  return `$${value.toFixed(value < 1 ? 2 : 1)}`;
}

function usageValue(value: number, unit?: string): string {
  return unit?.toLowerCase().includes("usd") ? money(value) : compact(value);
}

function usageChip(provider: FreeProvider): string {
  const usage = provider.usage;
  if (usage.displayLabel) return usage.displayLabel;
  if (!provider.configured && !provider.optionalCredential) return "Quota · awaiting auth";
  const estimate = usage.estimated ? "~" : "";
  if (usage.remaining != null && usage.limit != null) {
    const unit = usage.unit ? ` ${usage.unit}` : "";
    return `${estimate}${usageValue(usage.remaining, usage.unit)} / ${usageValue(usage.limit, usage.unit)}${unit} left`;
  }
  if (usage.used != null) return `${estimate}${usageValue(usage.used, usage.unit)} ${usage.unit ?? "used"} used`;
  if (usage.limit != null) return `${estimate}${usageValue(usage.limit, usage.unit)} ${usage.unit ?? "allowance"} · balance external`;
  return provider.optionalCredential && !provider.keyPresent ? "Anonymous quota · local estimate" : "Quota · not exposed";
}

function dateLabel(value: string | null | undefined): string {
  if (!value) return "Never";
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return value;
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(time);
}

function detailTitle(provider: FreeProvider): string {
  const usage = provider.usage;
  return [
    usage.message,
    `Source: ${usage.source}${usage.estimated ? " (estimated)" : " (provider value)"}`,
    usage.window ? `Window: ${usage.window}` : null,
    usage.resetAt ? `Reset: ${dateLabel(usage.resetAt)}` : null,
    `Updated: ${dateLabel(usage.lastUpdatedAt)}`,
  ].filter(Boolean).join("\n");
}

async function jsonRequest<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(apiUrl(path), { cache: "no-store", ...init });
  const body = (await response.json().catch(() => ({}))) as T & { error?: string };
  if (!response.ok) throw new Error(body.error || `Request failed (${response.status}).`);
  return body;
}

function replaceProvider(providers: FreeProvider[], provider: FreeProvider): FreeProvider[] {
  return providers.map((candidate) => candidate.id === provider.id ? provider : candidate);
}

export function FreeProviders() {
  const [providers, setProviders] = useState<FreeProvider[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState<Record<string, string>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [messages, setMessages] = useState<Record<string, string>>({});
  const [keyDrafts, setKeyDrafts] = useState<Record<string, string>>({});
  const [accountDrafts, setAccountDrafts] = useState<Record<string, string>>({});
  const [probeConfirm, setProbeConfirm] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    void jsonRequest<{ providers: FreeProvider[] }>("/api/free-providers")
      .then((body) => {
        if (live) setProviders(body.providers);
      })
      .catch((error: unknown) => {
        if (live) setLoadError(error instanceof Error ? error.message : "Could not load providers.");
      })
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => { live = false; };
  }, []);

  const readyCount = useMemo(() => providers.filter((provider) => provider.health.state === "ready").length, [providers]);

  const run = async (provider: FreeProvider, label: string, work: () => Promise<ProviderResponse>, success: (result: ProviderResponse) => string) => {
    setBusy((current) => ({ ...current, [provider.id]: label }));
    setErrors((current) => ({ ...current, [provider.id]: "" }));
    setMessages((current) => ({ ...current, [provider.id]: "" }));
    try {
      const result = await work();
      setProviders((current) => replaceProvider(current, result.provider));
      setMessages((current) => ({ ...current, [provider.id]: success(result) }));
      return result;
    } catch (error) {
      setErrors((current) => ({ ...current, [provider.id]: error instanceof Error ? error.message : "Provider request failed." }));
      // Validation/probe failures persist a richer provider state server-side (auth rejected,
      // exhausted, rate-limited, outage). Re-read it so the status dot and quota chip update now,
      // rather than only after closing and reopening Settings.
      try {
        const latest = await jsonRequest<{ providers: FreeProvider[] }>("/api/free-providers");
        setProviders(latest.providers);
      } catch {
        // Preserve the actionable error from the operation; a second fetch failure adds no value.
      }
      return null;
    } finally {
      setBusy((current) => ({ ...current, [provider.id]: "" }));
    }
  };

  const update = (provider: FreeProvider, patch: Record<string, unknown>) => jsonRequest<ProviderResponse>(`/api/free-providers/${provider.id}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(patch),
  });

  const toggle = async (provider: FreeProvider, enabled: boolean) => {
    const result = await run(provider, "Saving…", () => update(provider, { enabled }), () => enabled ? "Enabled. Validate models when credentials are ready." : "Disabled; background checks and probes are off.");
    if (enabled && result?.provider.configured) {
      await run(result.provider, "Validating…", () => jsonRequest<ProviderResponse>(`/api/free-providers/${provider.id}/refresh`, { method: "POST" }), (next) => next.provider.health.message);
    }
  };

  const saveCredentials = async (provider: FreeProvider) => {
    const apiKey = keyDrafts[provider.id]?.trim();
    const accountId = accountDrafts[provider.id]?.trim();
    const patch: Record<string, unknown> = { enabled: true };
    if (apiKey) patch.apiKey = apiKey;
    if (accountId) patch.accountId = accountId;
    const saved = await run(provider, "Saving…", () => update(provider, patch), () => "Credential saved on the server; validating catalog…");
    if (!saved) return;
    setKeyDrafts((current) => ({ ...current, [provider.id]: "" }));
    setAccountDrafts((current) => ({ ...current, [provider.id]: "" }));
    if (!saved.provider.configured) return;
    await run(saved.provider, "Validating…", () => jsonRequest<ProviderResponse>(`/api/free-providers/${provider.id}/refresh`, { method: "POST" }), (result) => result.provider.health.message);
  };

  const clearCredential = async (provider: FreeProvider) => {
    await run(provider, "Clearing…", () => update(provider, { clearApiKey: true }), (result) => result.provider.keySource === "environment"
      ? "Stored key removed; the environment key is still active."
      : "Stored key removed.");
  };

  const refresh = (provider: FreeProvider) => run(
    provider,
    "Refreshing…",
    () => jsonRequest<ProviderResponse>(`/api/free-providers/${provider.id}/refresh`, { method: "POST" }),
    (result) => result.provider.health.message,
  );

  const selectModel = (provider: FreeProvider, selectedModel: string) => run(
    provider,
    "Saving model…",
    () => update(provider, { selectedModel }),
    () => "Free model selected. The live catalog will be checked again before a probe.",
  );

  const probe = async (provider: FreeProvider) => {
    setProbeConfirm(null);
    await run(
      provider,
      "Sending 1 request…",
      () => jsonRequest<ProviderResponse>(`/api/free-providers/${provider.id}/probe`, { method: "POST" }),
      (result) => `Connected: ${result.response?.text || "response received"} · ${result.response?.model ?? provider.selectedModel} · ${result.response?.latencyMs ?? 0} ms`,
    );
  };

  if (loading) return <p className="free-provider-empty">Loading provider connections…</p>;
  if (loadError) return <p className="free-provider-empty bad">Provider connections unavailable: {loadError}</p>;

  return (
    <div className="free-providers">
      <div className="free-provider-intro">
        <div>
          <strong>Connection lab</strong>
          <span>{readyCount} of {providers.length} validated</span>
        </div>
        <p>Credentials, live free-model discovery, quota visibility, and explicit one-request probes. These API connectors cannot enter task routing or paid failover.</p>
      </div>

      {providers.map((provider) => {
        const eligible = provider.models.filter((model) => model.isFree && !model.ineligibleReason);
        const pending = busy[provider.id];
        const keyDraft = keyDrafts[provider.id] ?? "";
        const accountDraft = accountDrafts[provider.id] ?? "";
        return (
          <details className={`free-provider-card state-${provider.health.state}`} key={provider.id}>
            <summary>
              <span className="free-provider-state-dot" aria-hidden="true" />
              <span className="free-provider-summary-main">
                <span className="free-provider-name">{provider.displayName}</span>
                <span className="free-provider-tier">{provider.tierLabel}</span>
              </span>
              <span className={`free-usage-chip${provider.usage.estimated ? " estimated" : ""}${provider.usage.stale ? " stale" : ""}`} title={detailTitle(provider)}>
                {usageChip(provider)}
              </span>
              <span className="free-provider-caret" aria-hidden="true">›</span>
            </summary>

            <div className="free-provider-body">
              <div className="free-provider-health">
                <span className={`free-status state-${provider.health.state}`}>{STATE_LABEL[provider.health.state]}</span>
                <span>{provider.health.message}</span>
              </div>

              <div className="free-provider-facts">
                <span>{provider.transport}</span>
                <span>{provider.models.length ? `${eligible.length} free / ${provider.models.length} discovered` : "models not checked"}</span>
                <span>{provider.usage.estimated ? "usage estimated" : "provider usage"}</span>
              </div>

              <p className="free-provider-copy">{provider.quotaSummary}</p>

              <div className="free-provider-usage-detail">
                <div>
                  <span>Usage source</span>
                  <strong>{provider.usage.source.replaceAll("-", " ")}{provider.usage.estimated ? " · estimated" : ""}</strong>
                </div>
                <div>
                  <span>Window / reset</span>
                  <strong>{provider.usage.resetAt ? dateLabel(provider.usage.resetAt) : provider.usage.window ?? "dynamic"}</strong>
                </div>
                <div>
                  <span>Last usage signal</span>
                  <strong>{dateLabel(provider.usage.lastUpdatedAt)}</strong>
                </div>
                {provider.usage.secondaryLimits?.map((limit, index) => (
                  <div key={`${limit.label}-${index}`}>
                    <span>{limit.label}</span>
                    <strong>
                      {limit.remaining != null ? `${compact(limit.remaining)} left` : limit.used != null ? `${compact(limit.used)} used` : "unknown"}
                      {limit.limit != null ? ` / ${compact(limit.limit)}` : ""} {limit.unit}
                    </strong>
                  </div>
                ))}
              </div>
              {provider.usage.message ? <p className="free-provider-footnote">{provider.usage.message}</p> : null}

              <div className="free-provider-fields">
                <label>
                  <span>{provider.credentialLabel}</span>
                  <input
                    type="password"
                    value={keyDraft}
                    autoComplete="new-password"
                    spellCheck={false}
                    placeholder={provider.keyPresent ? `Saved ${provider.keySource} key · ••••${provider.keyLast4 ?? ""}` : provider.optionalCredential ? "Optional — anonymous mode works" : "Paste key once"}
                    onChange={(event) => setKeyDrafts((current) => ({ ...current, [provider.id]: event.target.value }))}
                  />
                  <small>{provider.credentialHelp}</small>
                </label>
                {provider.needsAccountId ? (
                  <label>
                    <span>Cloudflare account ID</span>
                    <input
                      type="password"
                      value={accountDraft}
                      autoComplete="off"
                      spellCheck={false}
                      placeholder={provider.accountIdPresent ? `Saved · ••••${provider.accountIdLast4 ?? ""}` : "Account ID"}
                      onChange={(event) => setAccountDrafts((current) => ({ ...current, [provider.id]: event.target.value }))}
                    />
                  </label>
                ) : null}
              </div>

              <div className="free-provider-actions credentials">
                <button className="sub-btn primary" disabled={!!pending} onClick={() => void saveCredentials(provider)}>
                  {pending || (provider.keyPresent || provider.optionalCredential ? "Save & validate" : "Connect & validate")}
                </button>
                {provider.keySource === "stored" ? (
                  <button className="sub-btn ghost" disabled={!!pending} onClick={() => void clearCredential(provider)}>Forget stored key</button>
                ) : null}
                <label className="free-provider-toggle">
                  <input type="checkbox" checked={provider.enabled} disabled={!!pending} onChange={(event) => void toggle(provider, event.target.checked)} />
                  <span aria-hidden="true" />
                  Enabled
                </label>
              </div>

              {eligible.length ? (
                <label className="free-provider-model">
                  <span>Probe model</span>
                  <select value={provider.selectedModel ?? ""} disabled={!!pending} onChange={(event) => void selectModel(provider, event.target.value)}>
                    {eligible.map((model) => (
                      <option value={model.id} key={model.id}>{model.displayName}{model.contextWindow ? ` · ${compact(model.contextWindow)} ctx` : ""}{model.supportsTools ? " · tools" : ""}</option>
                    ))}
                  </select>
                </label>
              ) : null}

              <div className="free-provider-warning">
                <strong>No paid fallback</strong>
                <span>{provider.billingWarning}</span>
              </div>

              <div className="free-provider-actions">
                <button className="sub-btn" disabled={!!pending || !provider.enabled || !provider.configured} onClick={() => void refresh(provider)}>Refresh models & usage</button>
                <button className="sub-btn primary" disabled={!!pending || provider.health.state !== "ready" || !eligible.length} onClick={() => setProbeConfirm(provider.id)}>Test with 1 request</button>
                <a href={provider.signupUrl} target="_blank" rel="noreferrer">Get credentials ↗</a>
                <a href={provider.docsUrl} target="_blank" rel="noreferrer">Official limits ↗</a>
              </div>

              {probeConfirm === provider.id ? (
                <div className="free-provider-confirm" role="alertdialog" aria-label={`Confirm ${provider.displayName} probe`}>
                  <p>This sends one tiny inference request to <code>{provider.selectedModel}</code>. The catalog was checked on validation and will be checked again immediately before sending.</p>
                  <div>
                    <button className="sub-btn" onClick={() => setProbeConfirm(null)}>Cancel</button>
                    <button className="sub-btn primary" onClick={() => void probe(provider)}>Send exactly 1 request</button>
                  </div>
                </div>
              ) : null}

              {errors[provider.id] ? <p className="free-provider-message bad" role="alert">{errors[provider.id]}</p> : null}
              {messages[provider.id] ? <p className="free-provider-message ok" aria-live="polite">{messages[provider.id]}</p> : null}
              <p className="free-provider-routing">Task routing locked · {provider.routing.reason}</p>
            </div>
          </details>
        );
      })}
    </div>
  );
}
