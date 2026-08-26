# GG Orchestrator — Free / Recurring AI Provider Integration Task

## Mission

Expand **GG Orchestrator** with as many legitimate, documented, programmatically usable free AI providers as practical for local coding / agentic work.

The orchestrator already has working integrations for:

- Claude
- SuperGrok
- Z.Ai
- ChatGPT

**Do not replace or regress those integrations.** Reuse their architecture, abstractions, secret storage, model selection, streaming, tool-calling, error handling, and UI patterns wherever appropriate.

The key product requirement is:

> **Usage chips are mandatory for every provider.**

A provider integration is **not complete** until its quota/usage state is visible in the UI.

---

# 1. Start by inspecting the existing architecture

Before changing code:

1. Find the existing provider abstraction(s).
2. Inspect the implementations for Claude, SuperGrok, Z.Ai, and ChatGPT.
3. Find:
   - provider registration
   - authentication / secret storage
   - model discovery
   - chat/completions or responses abstraction
   - streaming
   - tool/function calling
   - usage/token accounting
   - rate-limit/error handling
   - settings UI
   - provider/model picker UI
   - any existing usage chips/badges
   - persistence/database/config mechanisms
4. Extend existing patterns rather than creating a parallel provider system.
5. Prefer a shared OpenAI-compatible adapter where providers expose compatible APIs.

Do not perform a giant rewrite unless the existing design genuinely blocks clean provider additions.

---

# 2. Safety / integration rules

Use **supported APIs, SDKs, or official CLIs only**.

Do NOT:

- scrape web chat UIs
- steal/reuse browser cookies
- reverse-engineer private endpoints
- extract OAuth credentials from another application's credential store
- impersonate an official client
- bypass provider rate limits
- silently switch from a free model to a paid model
- claim quota is exact when it is only locally estimated

If a provider exposes a free plan only through its official CLI, it may be integrated by invoking that CLI as a subprocess **only if GG Orchestrator already supports or can cleanly support CLI-backed providers**. Do not extract the CLI's credentials and replay them yourself.

---

# 3. Mandatory provider integrations

Verify all limits against current official documentation immediately before implementing. Limits below are a **baseline captured 2026-08-26**, not a license to hardcode stale assumptions forever.

## A. Google Gemini / Google AI Studio

### Required integration

Add the supported **Gemini API / Google AI Studio API-key path** for third-party applications.

Baseline:

- Gemini API has a free tier.
- Current Gemini CLI quota documentation says an unpaid Gemini API key gets approximately **250 model requests/day**, Flash-only for that CLI authentication path.
- Personal Google login to the official Gemini CLI has a larger quota, currently documented as **1,000 requests/day**, but Google's Gemini CLI FAQ explicitly says third-party coding agents should use a **Vertex AI or Google AI Studio API key** rather than bypassing the intended authentication structure.

Therefore:

- Implement the normal supported API-key integration.
- Do **not** hijack Gemini CLI OAuth credentials.
- If useful, optionally support launching the official Gemini CLI as a distinct `CLI` backend, but keep it architecturally separate from the Gemini API provider.

Environment/config candidate:

`GEMINI_API_KEY`

Required features:

- streaming
- tool/function calls if supported by the selected model
- model discovery where practical
- free-tier-aware model filtering
- quota chip

---

## B. Mistral

Baseline:

- Mistral Free currently includes **$10/month in API credits**.
- The included allowance is shared across applicable Mistral services according to the account plan.

Environment/config candidate:

`MISTRAL_API_KEY`

Prefer native Mistral API support or the existing generic compatible adapter if it fully supports the features GG Orchestrator needs.

Usage chip example:

`$7.84 / $10 free left · monthly`

If remaining credit cannot be queried programmatically, derive an **estimated** remaining amount from provider-reported per-request usage/cost or a local persisted ledger and label it accordingly.

---

## C. Groq

Baseline free-plan limits are model-specific.

Examples currently documented:

- `openai/gpt-oss-120b`: 1,000 requests/day, 200K tokens/day
- `openai/gpt-oss-20b`: 1,000 requests/day, 200K tokens/day
- `qwen/qwen3.6-27b`: 1,000 requests/day, 200K tokens/day

Groq exposes useful rate-limit headers, including request/token limits, remaining values, and reset information.

Environment/config candidate:

`GROQ_API_KEY`

This should be one of the highest-priority integrations because it is OpenAI-compatible and provides good machine-readable quota information.

Usage chip should prefer **live response headers**, not only a hardcoded local counter.

Example:

`812 req left · 146K tok/day left`

---

## D. OpenRouter

Baseline:

- 25+ free models are currently advertised.
- Free account: approximately **50 free-model requests/day**.
- Accounts that have purchased at least $10 of credits have a free-model allowance of approximately **1,000 requests/day**.
- Free models use `:free` variants.
- `openrouter/free` can dynamically route to currently available free models.

Environment/config candidate:

`OPENROUTER_API_KEY`

Requirements:

- dynamically fetch the model catalog
- identify zero-cost / `:free` models dynamically
- support `openrouter/free`
- do not accidentally fall back to paid models
- preserve the actual served model/provider in request telemetry
- expose remaining free requests where provider APIs make that available, otherwise estimate locally

Usage chip example:

`43 / 50 free req left · daily`

If the account is in the 1,000/day tier, detect that instead of assuming 50.

---

## E. Cloudflare Workers AI

Baseline:

- Workers AI currently includes **10,000 Neurons/day free**.
- Reset is documented as **00:00 UTC**.
- Some frontier models require a paid Workers plan even when the account still has free Neurons.

Environment/config candidates:

- `CLOUDFLARE_API_TOKEN`
- `CLOUDFLARE_ACCOUNT_ID`

Requirements:

- use Workers AI REST/API support
- discover or maintain provider-supported model metadata
- never present paid-only models as free
- track Neuron consumption
- parse provider errors for free-allocation exhaustion
- reset accounting at the correct UTC boundary

Usage chip example:

`8.3K / 10K neurons left · resets 00:00 UTC`

If exact remaining Neurons cannot be fetched, calculate an estimated value from documented model rates + observed input/output usage and mark it `~`.

---

## F. Cohere

This provider was not in the original shortlist but currently has a useful recurring evaluation allowance.

Baseline:

- Cohere evaluation/trial API keys are free but limited.
- Current documentation states **1,000 API calls/month** for trial/evaluation keys.
- Chat models commonly have a trial rate of about **20 requests/minute**.
- `North Mini Code` is specifically relevant to coding.

Environment/config candidate:

`COHERE_API_KEY`

Requirements:

- chat/streaming
- tool use if supported
- model list
- monthly local quota ledger if Cohere does not expose remaining monthly calls directly
- 429 handling

Usage chip example:

`736 / 1,000 calls left · monthly ~`

The `~` or an `Estimated` tooltip must be shown if calculated locally.

---

## G. Kilo AI Gateway

Kilo Gateway is useful because it exposes a real OpenAI-compatible API rather than merely being a coding UI.

Baseline:

- unified OpenAI-compatible gateway
- live free models
- `kilo-auto/free`
- free model requests are currently rate-limited at **200 requests/hour/IP**
- anonymous free-model access is documented
- authenticated free usage is also possible
- the model endpoint exposes model/pricing metadata
- free model availability changes dynamically

Base endpoint currently documented:

`https://api.kilo.ai/api/gateway`

Environment/config candidate:

`KILO_API_KEY` (optional where anonymous mode is supported)

Requirements:

- support authenticated and permitted anonymous free access
- dynamically load `GET /models`
- only label models free if current catalog pricing says input AND output are zero
- add `kilo-auto/free`
- handle 429 cleanly
- maintain hourly free-request counter when exact remaining quota is not returned
- track actual upstream provider/model when returned

Usage chip example:

`137 / 200 free req left · hourly ~`

Do not hardcode the current free-model names; they change frequently.

---

## H. NVIDIA NIM / NVIDIA API Catalog

NVIDIA currently advertises free access to hosted NIM API endpoints for prototyping for Developer Program members.

This is valuable enough to integrate, but quota behavior can be model/account/traffic dependent.

Environment/config candidate:

`NVIDIA_API_KEY`

Requirements:

- verify the current official OpenAI-compatible endpoint and authentication flow
- dynamically discover usable text/code models if supported
- prioritize coding-capable models
- inspect responses/headers/APIs for actual quota or credits
- if NVIDIA does not expose exact remaining quota programmatically, **do not invent a number**

Allowed usage-chip states include:

`Free prototype · rate-limited`

or, if credits are actually queryable:

`842 prototype credits left`

If only local requests can be counted while the true cap is unknown:

`126 requests used · cap not exposed`

That still satisfies the mandatory usage-chip requirement honestly.

---

## I. Hugging Face Inference Providers

Baseline:

- Free Hugging Face users currently receive approximately **$0.10/month** in routed Inference Provider credits.
- It is tiny, but it is recurring and should be supported if the integration is low-cost.
- Hugging Face can route to many underlying inference providers.

Environment/config candidate:

`HF_TOKEN`

Requirements:

- use the current routed Inference Providers API
- prefer its OpenAI-compatible API where suitable
- expose model/provider identity
- track monthly free credit
- do not confuse BYOK calls with Hugging Face-billed free credits

Usage chip example:

`$0.07 / $0.10 free left · monthly ~`

Low priority compared with Mistral/Groq/Kilo, but still integrate if clean.

---

# 4. Optional one-time trial integrations

These are useful but **must NOT be presented as recurring free quota**.

Implement after recurring-free providers unless implementation is almost free because of the shared adapter.

## Cerebras

Baseline:

- currently advertises **$5 one-time free trial credit** for inference
- OpenAI-compatible API
- very fast coding-capable models may be available

Environment/config candidate:

`CEREBRAS_API_KEY`

Chip must say something like:

`Trial: $3.42 / $5 left · one-time`

Never say `monthly`, `daily`, or `free forever`.

## Fireworks AI

Baseline:

- currently advertises **$1 in signup credits**
- not known to be recurring

Environment/config candidate:

`FIREWORKS_API_KEY`

Chip example:

`Trial: $0.61 / $1 left · one-time`

---

# 5. Providers/services to explicitly NOT waste time on

Re-check these at implementation time in case circumstances changed, but the 2026-08-26 baseline is:

## GitHub Models

**Do not integrate GitHub Models.**

GitHub's official docs say the GitHub Models playground, catalog, inference API and BYOK service were **fully retired on 2026-07-30**.

GitHub Copilot is a separate product and should not be mistaken for the retired GitHub Models inference API.

## Together AI

Current official support documentation says:

- no free trial
- minimum credit purchase required

Do not include it in the free-provider pool unless this changes.

## OpenCode Zen

Current docs describe Zen as billed per request / credit based.

Do not classify Zen itself as a recurring-free provider merely because OpenCode is free/open-source.

The OpenCode client may still be useful as an agent frontend, but that is a different concern.

---

# 6. Discovery pass — find additional providers

After implementing or validating the confirmed providers above, perform a fresh web research pass using **official provider documentation**.

Search for additional services that have at least one of:

- recurring daily free inference
- recurring weekly free inference
- recurring monthly free inference/credits
- free evaluation API keys that renew
- genuinely zero-cost hosted models
- free developer/prototyping endpoints
- a documented API gateway with zero-cost models
- an official CLI that can legally be invoked by GG Orchestrator

Candidate categories worth checking include:

- inference startups
- coding-model vendors
- model gateways
- chip/inference hardware vendors
- cloud developer AI programs

Only add a provider when all of these are true:

1. It can actually be called programmatically.
2. Authentication can be performed through a supported mechanism.
3. The free access still exists **now**.
4. Terms do not require abusing a consumer-only web subscription.
5. The provider is useful enough for coding/agent work to justify maintenance.

For every newly discovered provider, document the official source and classify its free allowance as:

- `RECURRING_HOURLY`
- `RECURRING_DAILY`
- `RECURRING_WEEKLY`
- `RECURRING_MONTHLY`
- `FREE_PROTOTYPING`
- `ONE_TIME_TRIAL`
- `UNKNOWN_DYNAMIC`

Do not trust old blog posts when newer official pricing/docs contradict them.

---

# 7. Shared provider architecture

Create/reuse a normalized provider interface rather than scattering provider-specific logic throughout the app.

Adapt names/types to the existing codebase, but conceptually support:

```ts
interface AiProvider {
  id: string;
  displayName: string;
  transport: "openai-compatible" | "native" | "cli";

  isConfigured(): Promise<boolean>;
  testConnection(): Promise<ProviderHealth>;
  listModels(): Promise<ModelInfo[]>;

  complete(request: NormalizedCompletionRequest): Promise<NormalizedCompletion>;
  stream(request: NormalizedCompletionRequest): AsyncIterable<NormalizedStreamEvent>;

  getUsage(): Promise<ProviderUsageSnapshot>;
}
```

A model should expose enough metadata for routing:

```ts
interface ModelInfo {
  providerId: string;
  id: string;
  displayName: string;
  contextWindow?: number;

  supportsStreaming: boolean;
  supportsTools: boolean;
  supportsVision?: boolean;
  supportsReasoning?: boolean;

  isFree: boolean;
  freeStatusSource: "provider" | "catalog-price" | "configured" | "unknown";

  inputPricePerMillion?: number;
  outputPricePerMillion?: number;
}
```

Use the project's actual language and conventions rather than forcing TypeScript if the app is not TypeScript.

---

# 8. MANDATORY usage-chip subsystem

This is a first-class requirement, not polish.

Every configured provider shown anywhere meaningful in the provider/model UI must have a usage chip.

Create/reuse a normalized usage model similar to:

```ts
type UsageSource =
  | "provider-api"
  | "response-header"
  | "response-usage"
  | "local-estimate"
  | "published-limit"
  | "unknown";

type QuotaKind =
  | "requests"
  | "tokens"
  | "credits-usd"
  | "neurons"
  | "mixed"
  | "prototype"
  | "trial"
  | "unknown";

interface ProviderUsageSnapshot {
  providerId: string;

  quotaKind: QuotaKind;
  source: UsageSource;

  used?: number;
  remaining?: number;
  limit?: number;
  unit?: string;

  window?:
    | "hour"
    | "day"
    | "week"
    | "month"
    | "rolling"
    | "lifetime"
    | "dynamic";

  resetAt?: string;
  lastUpdatedAt: string;

  estimated: boolean;
  stale?: boolean;

  secondaryLimits?: Array<{
    label: string;
    used?: number;
    remaining?: number;
    limit?: number;
    unit: string;
    resetAt?: string;
  }>;

  message?: string;
}
```

## Accuracy priority

Determine usage in this order:

1. **Official usage/quota API**
2. **Provider response rate-limit headers**
3. **Provider response usage/cost metadata**
4. **Persisted local ledger**
5. **Published quota + locally counted requests**
6. **Unknown/dynamic state**

Never promote a lower-quality source over a higher-quality source.

Example: Groq response headers should beat a locally guessed counter.

---

# 9. Usage-chip UI behavior

Examples:

`Groq · 812 req left · 146K tok left`

`Mistral · ~$7.84 / $10 left · monthly`

`OpenRouter · 43 / 50 free req left · daily`

`Cloudflare · ~8.3K / 10K neurons left · daily`

`Cohere · ~736 / 1,000 calls left · monthly`

`Kilo · ~137 / 200 req left · hourly`

`NVIDIA · Free prototype · cap not exposed`

`Cerebras · Trial $3.42 / $5 left · one-time`

Rules:

- Show `~`, `Estimated`, or a tooltip when locally calculated.
- Show the reset time/window when known.
- Do not show `0 left` solely because usage could not be fetched.
- Distinguish:
  - unavailable
  - unauthenticated
  - quota exhausted
  - rate limited
  - provider outage
  - unknown quota
- A tooltip/details panel should reveal:
  - source of the number
  - last refresh
  - quota window
  - reset time
  - secondary token/request limits
- Refresh after every completed model request.
- Refresh after a 429.
- Periodically refresh while the app is open without hammering quota endpoints.
- Allow manual refresh.

If a provider offers multiple quota dimensions, show the limiting dimensions rather than pretending one number tells the whole story.

---

# 10. Persisted local quota ledger

For providers that do not expose exact account-wide usage, create a small persistent ledger.

Track at minimum:

- provider ID
- account/key fingerprint **without storing the secret**
- model ID
- request timestamp
- request count
- input tokens
- output tokens
- provider cost when returned
- locally estimated cost/units when necessary
- response status
- whether the call was free/paid/trial
- quota window identity

Requirements:

- survive app restart
- handle daily/monthly/hourly resets correctly
- timezone/reset semantics must match each provider
- do not double-count retries that never reached inference when this can be determined
- final streaming usage events must be recorded
- key rotation should not merge two unrelated accounts accidentally

Hash/fingerprint secrets safely; never store raw API keys in analytics tables/logs.

---

# 11. Rate-limit handling

Normalize at least:

- HTTP 401/403 authentication/config failures
- HTTP 402 / insufficient balance
- HTTP 429 quota/rate limit
- HTTP 5xx provider outage
- timeout
- network failure
- context-length failure
- invalid/retired model

On 429:

1. parse `Retry-After`
2. parse provider reset headers when available
3. update usage chip immediately
4. temporarily mark that provider/model unavailable for automatic routing
5. do not aggressively retry
6. do not burn through another provider's paid quota unless explicitly permitted

Use bounded exponential backoff only for retryable transient failures.

---

# 12. Free-provider routing

Add a virtual routing option such as:

`Free Pool`

or reuse an existing orchestrator routing concept.

The free pool should consider:

1. provider is configured/usable
2. model is currently free
3. quota not exhausted
4. provider health
5. required tool/function-call support
6. context-window requirement
7. coding suitability
8. latency
9. remaining quota pressure

Prefer preserving scarce quotas when an equivalent free provider has much more capacity.

Example:

- Kilo/Groq can absorb routine coding work
- Mistral's dollar credit may be saved for tasks where its models are more valuable
- Hugging Face's tiny $0.10 allowance should not be consumed first unless explicitly selected

## Critical billing rule

`allowPaidFallback = false` by default.

When a free model/provider is exhausted:

- move to another **free** provider
- or fail with a clear message

Do NOT silently call a paid model.

If the user explicitly enables paid fallback, show that state clearly.

---

# 13. Dynamic model discovery

Do not build this around a frozen list of model IDs.

Where providers expose model catalogs:

- fetch models dynamically
- cache sensibly
- refresh on demand
- record context size/capabilities/pricing/free status when available
- hide retired models
- detect newly added free models without requiring a new release

For gateways such as OpenRouter and Kilo:

- derive `isFree` from current catalog data
- prefer exact zero input/output pricing
- support provider-specific free suffixes/routers
- prevent a stale cached model from becoming an unexpected paid call

If a model was free when cached but current pricing cannot be verified at request time, fail safe rather than spending money unexpectedly.

---

# 14. Provider setup UI

Each provider needs a consistent settings card/section containing:

- provider name
- enabled toggle
- authentication input or official login/CLI instructions
- secure secret storage using the existing project mechanism
- `Test connection`
- current health/status
- model count
- free-tier classification
- **usage chip**
- reset information
- last usage refresh
- official docs link
- optional advanced base URL where useful

Never print full API keys after saving them.

Mask secrets in logs/errors.

---

# 15. Suggested configuration keys

Use the codebase's existing settings convention, but these names are reasonable defaults:

```text
GEMINI_API_KEY
MISTRAL_API_KEY
GROQ_API_KEY
OPENROUTER_API_KEY
CLOUDFLARE_API_TOKEN
CLOUDFLARE_ACCOUNT_ID
COHERE_API_KEY
KILO_API_KEY
NVIDIA_API_KEY
HF_TOKEN

# one-time trial providers
CEREBRAS_API_KEY
FIREWORKS_API_KEY
```

Do not require environment variables if GG Orchestrator already has a secure credential UI/store; support the project's established mechanism.

---

# 16. Provider feature matrix

Maintain a runtime or documented matrix with columns like:

| Provider | Auth | Free type | Streaming | Tools | Dynamic models | Exact usage | Local estimate | Auto-route |
|---|---|---|---|---|---|---|---|---|

The app should be able to distinguish provider capability instead of assuming every OpenAI-compatible service implements every OpenAI feature.

---

# 17. Testing requirements

Do not stop at "it compiles."

## Unit tests

Cover:

- provider registration
- model normalization
- stream chunk normalization
- tool-call normalization
- response usage parsing
- rate-limit header parsing
- 401
- 402
- 429
- Retry-After
- reset-time parsing
- local quota ledger
- hourly/day/month resets
- key fingerprint separation
- free/paid model classification
- stale model pricing protection

## Usage-chip tests

At minimum:

- exact quota
- estimated quota
- mixed request + token quota
- unknown dynamic quota
- one-time trial
- exhausted
- stale
- rate limited
- unauthenticated

## Integration/smoke tests

Provider smoke tests should run only when their credential is available.

A missing secret should skip the live test, not fail the entire test suite.

## Regression

Run existing tests for:

- Claude
- SuperGrok
- Z.Ai
- ChatGPT

Do not break existing provider selection or routing.

---

# 18. Observability

Add enough structured logging/telemetry to diagnose provider problems without leaking prompts or secrets.

Useful fields:

- provider
- model
- request ID
- latency
- TTFT when available
- input tokens
- output tokens
- locally calculated/free units
- quota remaining when known
- HTTP status
- normalized error type
- retry count
- actual routed provider/model for gateways

Never log:

- API keys
- OAuth tokens
- secret headers
- full sensitive source code by default

---

# 19. Official baseline sources to re-check

Use these as starting points, but always verify the latest state before hardcoding limits:

- Gemini CLI quota/pricing:
  https://github.com/google-gemini/gemini-cli/blob/main/docs/resources/quota-and-pricing.md

- Gemini CLI FAQ / third-party auth guidance:
  https://github.com/google-gemini/gemini-cli/blob/main/docs/resources/faq.md

- Gemini API rate limits:
  https://ai.google.dev/gemini-api/docs/rate-limits

- Mistral pricing:
  https://mistral.ai/pricing/

- Mistral usage/limits:
  https://docs.mistral.ai/admin/billing-usage/usage-limits

- Groq rate limits:
  https://console.groq.com/docs/rate-limits

- OpenRouter pricing:
  https://openrouter.ai/pricing

- OpenRouter FAQ:
  https://openrouter.ai/docs/faq

- OpenRouter free router:
  https://openrouter.ai/docs/guides/routing/routers/free-router

- Cloudflare Workers AI pricing:
  https://developers.cloudflare.com/workers-ai/platform/pricing/

- Cohere rate limits:
  https://docs.cohere.com/docs/rate-limits

- Kilo Gateway:
  https://kilo.ai/docs/gateway

- Kilo Gateway authentication/free limits:
  https://kilo.ai/docs/gateway/authentication

- Kilo usage/rate limits:
  https://kilo.ai/docs/gateway/usage-and-billing

- NVIDIA NIM for Developers:
  https://developer.nvidia.com/nim

- Hugging Face Inference Providers pricing:
  https://huggingface.co/docs/inference-providers/pricing

- Cerebras pricing:
  https://www.cerebras.ai/pricing

- Fireworks pricing:
  https://fireworks.ai/pricing

- GitHub Models retirement notice:
  https://docs.github.com/en/github-models

- Together AI free-trial status:
  https://support.together.ai/articles/1862638756-changes-to-free-tier-and-billing-july-2025

- OpenCode Zen:
  https://opencode.ai/docs/zen/

---

# 20. Implementation order

Unless the current architecture suggests a better dependency order:

1. inspect existing provider architecture
2. implement shared normalized quota/usage subsystem
3. implement mandatory usage-chip component
4. add/refactor shared OpenAI-compatible provider adapter
5. Groq
6. OpenRouter
7. Kilo Gateway
8. Mistral
9. Gemini API
10. Cohere
11. Cloudflare Workers AI
12. NVIDIA NIM
13. Hugging Face
14. Cerebras trial
15. Fireworks trial
16. fresh discovery pass for additional legitimate free providers
17. Free Pool routing
18. comprehensive tests
19. docs/setup instructions
20. final regression pass

Parallelize only where doing so will not create conflicting provider abstractions.

---

# 21. Definition of done

This task is complete only when:

- existing Claude integration still works
- existing SuperGrok integration still works
- existing Z.Ai integration still works
- existing ChatGPT integration still works
- all feasible mandatory providers above are integrated
- each provider can be enabled/disabled
- secrets are handled securely
- model discovery works where offered
- streaming works
- tool calling works where supported
- rate-limit errors are normalized
- free vs paid state is explicit
- **every provider has a usage chip**
- estimated usage is visibly marked as estimated
- one-time trial credit is visibly marked as one-time
- no automatic paid spillover occurs by default
- dynamic free models can be discovered
- Free Pool routing can fail over between free providers
- tests cover quota logic and provider adapters
- setup documentation exists
- a fresh discovery pass has been completed for additional free providers

---

# 22. Final report format

When finished, report:

## Implemented

A provider table containing:

- provider
- integration type
- models tested
- free allowance
- usage source (`exact`, `header`, `local estimate`, etc.)
- usage chip status
- streaming
- tools
- test result

## Not implemented

For every skipped provider, give the concrete reason:

- no current free tier
- API retired
- unsupported authentication
- webpage-only
- no coding-capable model
- blocked by architecture
- documentation ambiguity

## Newly discovered providers

List any additional free providers found during the research pass and whether they were integrated.

## Files changed

Give a concise list of changed files/modules.

## Setup

List exactly which credentials the user needs to create and where in GG Orchestrator to enter them.

## Tests

List test commands and results.

## Remaining uncertainties

Explicitly identify any quota numbers that cannot be queried exactly and are therefore estimated locally.

---

# Final instruction

Do not merely write a design document or create empty provider classes.

**Inspect the actual codebase and implement the feature end-to-end.**

Prioritize correctness, supported authentication, quota transparency, and not spending money unexpectedly.
