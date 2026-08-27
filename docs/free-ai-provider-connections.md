# Free AI task pool

GG Orchestrator has nine recurring-free provider connections. Eight are authenticated on this instance; OpenRouter is implemented and ready for its first API key. Open **Settings → Free AI connections** to see every live quota chip and the separate routing state. No code or environment-file edit is required.

The **Free task pool** now offloads two bounded roles before GGO spends a subscription turn:

- **Planner** — read-only `Read`/`Grep`/`Glob`, plus the normal structured plan contract.
- **Reader** (`dispatch_read`) — the same confined repo reads, allowlisted read-only git history, and the finding tool needed to return its answer.

These are real task runs: they appear in run history as `free:<provider>`, stream tool activity into the task feed, and add every request/token response to the provider's usage chip. A free failure never strands a task. Invalid output, unsupported tools, quota exhaustion, malformed configuration, or an outage records the failed free run and immediately starts the unchanged Claude/Codex/Grok/z.ai path.

Implementation, research, QA, and auto-review remain on the existing coding-agent backends. Those roles need shell/network/write/MCP/commit semantics the bounded free harness intentionally does not expose.

## Live-verified connections and a ready-to-authenticate route

On the current GGO instance, the eight already configured connections below completed an authenticated two-turn canary run on 2026-08-26: the model called the confined `Read` tool, received the result, returned the exact canary in the structured plan contract, and updated its usage ledger. This is stronger than catalog validation; it verifies the real adapter and tool-history format without granting shell or write access. OpenRouter is intentionally marked **Awaiting auth** until an owner saves a key; no OpenRouter inference was sent while preparing this route.

| Provider | Supported authentication | Recurring allowance shown by GGO | Model safety | Usage chip | Task-pool readiness |
|---|---|---|---|---|---|
| Google Gemini API | Google AI Studio API key | Project/model-specific free RPM, TPM, and RPD | Dynamic catalog; only currently verified free-tier Flash model families are eligible | Local request/token evidence; exact project caps remain in AI Studio | Live-verified with Gemini 3 thought-signature replay across the tool turn |
| Groq | GroqCloud API key | Model-specific free RPD/TPD | Dynamic catalog intersected with the current official free-plan allowlist | Exact request/day and token/minute response headers after a request; local count before that | Live-verified on the official tool-capable free-model allowlist; output reservations are bounded for the 8K TPM tier |
| OpenRouter | OpenRouter API key | 50 free-model requests/day; 1,000/day only after purchasing at least $10 of credits | Dynamic catalog; only exact-zero `:free` routes and the catalog-listed `openrouter/free` router are eligible; provider fallbacks are disabled | Local daily request estimate; the key endpoint identifies free versus funded tier and shows any key spending limit separately | Ready to authenticate; no production credential was available for a canary on this instance |
| Kilo Gateway | Anonymous, or optional Kilo key | 200 free-model requests per rolling hour/IP | Live catalog must report exactly-zero input/output pricing; free routes only plus `kilo-auto/free` | Persisted rolling-hour estimate; shared-IP activity outside GGO is unknowable | Routes only while the exact selected zero-price route reports tools |
| Mistral | Mistral API key from a workspace in Free mode | $10/month included credits | Dynamic chat-capable catalog, pinned model per task | Published $10 allowance and locally reported cost/tokens when present; remaining balance stays in Mistral Console | Routes when the selected free-workspace model reports function calling |
| Cohere | Cohere evaluation API key | 1,000 calls/month; chat keys commonly have a 20 RPM trial limit | Dynamic chat-model catalog | Persisted monthly estimate for this GGO instance | Routes when the selected evaluation model reports tools |
| Cloudflare Workers AI | Account API token + account ID | 10,000 Neurons/day, resetting 00:00 UTC | Dynamic catalog intersected with published neuron-rate metadata; documented paid-only and unknown models are blocked | Estimated Neurons from response tokens and published per-model rates | Routes only when a verified-neuron model explicitly reports tools |
| NVIDIA NIM | NVIDIA Developer Program API key | Free hosted endpoint prototyping; NVIDIA publishes no numeric cap | Dynamic catalog filtered to conversational/coding model families | Honest cap-not-exposed state plus persisted request/token evidence | Live-verified on hosted GPT-OSS; the task timeout accommodates prototype cold starts |
| Hugging Face Inference Providers | Fine-grained Hugging Face token | $0.10/month routed credit for free accounts | Live providers with explicit per-million-token prices; tasks pin the exact provider suffix | Published credit minus conservative live-price estimates for this GGO | Routes when the selected live provider reports tools |

Connection and routing are deliberately separate. **Connected** means credentials and the catalog validated. **In free task pool** additionally requires an enabled connection, a selected model still verified free, explicit tool support (from live metadata or a narrow current official-model allowlist), sufficient context, visible quota remaining, and no short harness-failure cooldown. An authenticated provider without verified tool capability remains connected and keeps its usage chip, but fails closed for tasks.

## Setup tonight

1. Open the gear menu, then **Free AI connections**.
2. Expand a provider card.
3. Follow **Get credentials** to the provider's official account page.
4. Paste the credential. Cloudflare also needs the account ID; Kilo can be left anonymous.
5. Choose **Connect & validate** (or **Save & validate**). This saves the secret server-side and performs model discovery/account metadata reads only. It does not run inference.
6. Check the state, discovered/free counts, and quota chip. Select a free probe model if more than one is eligible.
7. Choose **Test with 1 request**, read the billing warning, then confirm **Send exactly 1 request**. The server refreshes the live catalog again before sending the fixed, tiny connectivity prompt.
8. Turn on **Use free pool for planning & read-only lookups**. This explicit opt-in is required even when credentials were saved earlier. The count beside it says how many connections can route right now; the reason at the bottom of every card explains exclusions.

Provider prerequisites:

- **Gemini:** create a key in [Google AI Studio](https://aistudio.google.com/app/apikey). This integration intentionally does not copy Gemini CLI OAuth/browser credentials. Keep the project on the free tier if no spend is wanted.
- **Groq:** create a key in [GroqCloud](https://console.groq.com/keys). The card reads exact quota headers after its first completed request.
- **OpenRouter:** create a key in [OpenRouter settings](https://openrouter.ai/settings/keys). GGO exposes only live catalog entries that are exact-zero `:free` routes or `openrouter/free`, and disables provider fallbacks. If strict no-spend isolation matters, do not configure a matching paid BYOK key in the OpenRouter workspace: OpenRouter prioritizes BYOK endpoints before shared capacity.
- **Kilo:** no account is required for documented anonymous free-model access. A key from [Kilo](https://app.kilo.ai/) is optional. For a strict no-spend boundary, use anonymous mode or remove any matching Kilo account-level BYOK key: Kilo sends BYOK requests to that provider and bills them directly.
- **Mistral:** put the workspace in **Free** mode and create a key in [Mistral Console](https://console.mistral.ai/api-keys). Free-mode/account balance is authoritative there.
- **Cohere:** create a free **evaluation** key in the [Cohere dashboard](https://dashboard.cohere.com/api-keys). GGO cannot distinguish an evaluation key from a production key, so verify the key type before probing.
- **Cloudflare:** create a custom account API token with **Workers AI Read** and **Workers AI Edit**, and copy the account ID. Use a Workers Free account for a hard no-spend boundary: paid Workers plans can bill beyond the daily allocation, and GGO cannot see Neurons consumed elsewhere on the account.
- **NVIDIA:** join the free [NVIDIA Developer Program](https://developer.nvidia.com/developer-program), then create a hosted API Catalog key at [build.nvidia.com](https://build.nvidia.com/). The provider does not expose a numeric remaining-prototype allowance, so GGO never invents one.
- **Hugging Face:** create a [fine-grained token](https://huggingface.co/settings/tokens) with **Inference Providers** permission. Free accounts currently receive $0.10/month in routed credit. Remove/avoid BYOK provider keys if the intent is to consume only Hugging Face's credit; GGO pins one live provider route but cannot inspect keys configured in your Hugging Face account.

Environment fallbacks are also supported: `GEMINI_API_KEY`, `GROQ_API_KEY`, `OPENROUTER_API_KEY`, `KILO_API_KEY`, `MISTRAL_API_KEY`, `COHERE_API_KEY`, `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, `NVIDIA_API_KEY`, and `HF_TOKEN`. A stored UI credential wins over the environment. **Forget stored key** removes only the database value; an environment key remains active and is labelled as such.

## Verify the deployed connections

From the repository root, run the read-only live probe after changing the provider registry or rebuilding the console:

```powershell
npm run probe:providers -- --expect-provider-ids gemini,groq,openrouter,kilo,mistral,cohere,cloudflare,nvidia,huggingface --expect-provider-count 9
```

The probe logs in with `AUTH_PASSWORD` without printing it, reads provider readiness from the authenticated API, opens the console without clicking or mutating production state, and verifies that the entry bundle served on `:4317` is the current local `web/dist` bundle. It fails separately for a stale server registry, a forbidden/extra provider, a missing provider, or a stale static bundle, so a working web card cannot be mistaken for server code that has not reloaded.

## Security and failure behavior

- Provider routes are behind the existing GGO session authentication.
- Raw keys enter only the provider `PUT` route and the local SQLite key-value store, matching GGO's existing z.ai/OpenAI secret convention. Responses and WebSocket snapshots contain only presence, source, and last four characters.
- Password fields are cleared after save; saved values cannot be revealed through the UI.
- Provider errors and credential-bearing URLs are redacted before persistence or return. Probe logs contain provider, served model/provider, request ID, latency, token counts, and normalized error class—never the key, prompt, response text, or authorization header.
- 401/403/498, billing/402, 429/`Retry-After`, 5xx, timeout, network, context-window, and invalid-model failures become distinct card states. Task runs fall back to the existing paid-backend ladder; GGO never silently swaps the requested free model for a paid one.
- The live catalog/free classification is refreshed immediately before every probe or routed task. A previously free catalog entry that becomes non-zero or loses tool eligibility is rejected before a completion call.
- OpenRouter permits only live catalog entries with exactly zero pricing in every reported billable dimension. Its documented Free Models Router is accepted only when the catalog lists it at zero price, and each request disables generic provider fallbacks. OpenRouter BYOK is an account-side override, so its setup card explicitly warns when a strict no-spend boundary is needed.
- The free harness has no shell or write tool. File reads resolve symlinks and reject paths outside the task workspace; search runs fixed-argument `rg` without a shell; git accepts only `log`, `show`, `status`, and `diff` through the existing hardened read path.
- Tool calls, tool-result bytes, model calls, output tokens, and structured-output retries all have hard per-turn limits. A model that cannot finish inside them rests for ten minutes while other free providers (or the paid fallback) continue.
- The local quota ledger is keyed by a salted HMAC credential/account fingerprint. It survives restart, separates rotated keys, applies provider window timezone rules, and records rejected calls with a zero request count.
- Every provider card always carries a usage chip. `EST`/`~` means locally calculated; “not exposed” never becomes a false zero.

## What remains outside this slice

| Candidate | Status | Reason |
|---|---|---|
| Cerebras / Fireworks | Not integrated | One-time trial credit, not recurring free quota. Deferred behind the recurring providers and must be labelled as trial if added. |
| GitHub Models | Rejected | GitHub retired the Models playground, catalog, inference API, and BYOK service on 2026-07-30. Copilot is a separate product. |
| Together AI | Rejected | Current official support says there is no free trial and a credit purchase is required. |
| OpenCode Zen | Deferred | Its current docs identify some time-limited free models, correcting the proposal's assumption. The public model catalog does not expose price or free expiry, while the account can auto-reload credit, so GGO cannot revalidate a no-spend boundary before each probe. |

The next engineering step is extending the harness beyond read-only roles. A free **implementor** would need isolated write/shell tools, resumable sessions, steering, office/bus parity, secret-safe command execution, test/build timeouts, and the commit/push contract. Research also needs approved web/memory tools; QA/auto-review need a robust read-only shell. Until those role-specific contracts are built and tested, they stay on the mature coding-agent backends.

## Official references checked 2026-08-27

- [Gemini API rate limits](https://ai.google.dev/gemini-api/docs/rate-limits), [models API](https://ai.google.dev/api/models), [function calling](https://ai.google.dev/gemini-api/docs/function-calling), and [Gemini 3 thought-signature replay](https://ai.google.dev/gemini-api/docs/generate-content/thought-signatures)
- [Groq rate limits and headers](https://console.groq.com/docs/rate-limits), [tool-use model matrix](https://console.groq.com/docs/tool-use/overview), and [API reference](https://console.groq.com/docs/api-reference)
- [OpenRouter pricing](https://openrouter.ai/pricing), [free-model FAQ](https://openrouter.ai/docs/faq), [models API](https://openrouter.ai/docs/quickstart), [Free Models Router](https://openrouter.ai/docs/guides/routing/routers/free-router), [current-key API](https://openrouter.ai/docs/api/api-reference/api-keys/get-current-key), and [BYOK routing](https://openrouter.ai/docs/guides/overview/auth/byok)
- [Kilo authentication](https://kilo.ai/docs/gateway/authentication), [models/API](https://kilo.ai/docs/gateway/api-reference), and [usage](https://kilo.ai/docs/gateway/usage-and-billing)
- [Mistral pricing](https://mistral.ai/pricing/), [usage limits](https://docs.mistral.ai/admin/billing-usage/usage-limits), [models](https://docs.mistral.ai/api/endpoint/models), and [chat](https://docs.mistral.ai/api/endpoint/chat)
- [Cohere evaluation limits](https://docs.cohere.com/docs/rate-limits), [models](https://docs.cohere.com/reference/list-models), [v2 chat](https://docs.cohere.com/v2/reference/chat), and [tool use](https://docs.cohere.com/v2/docs/tool-use-overview/)
- [Cloudflare Workers AI pricing](https://developers.cloudflare.com/workers-ai/platform/pricing/), [OpenAI compatibility](https://developers.cloudflare.com/workers-ai/configuration/open-ai-compatibility/), [GPT-OSS tool capability](https://developers.cloudflare.com/workers-ai/models/gpt-oss-120b/), and [model search](https://developers.cloudflare.com/api/resources/ai/subresources/models/methods/list/)
- [NVIDIA hosted GPT-OSS endpoint/model card](https://build.nvidia.com/openai/gpt-oss-120b/build), [NIM chat API](https://docs.nvidia.com/nim/large-language-models/latest/function-calling.html), and [NIM tool loop](https://docs.nvidia.com/nim/large-language-models/latest/advanced-use-cases/tool-calling-and-mcp.html)
- [Hugging Face pricing/credits](https://huggingface.co/docs/inference-providers/pricing), [provider-aware models API](https://huggingface.co/docs/inference-providers/en/hub-api), and [chat completion routing](https://huggingface.co/docs/inference-providers/main/en/tasks/chat-completion)
- [OpenCode Zen models and free-route notices](https://opencode.ai/docs/zen/), [GitHub Models retirement](https://docs.github.com/en/enterprise-cloud@latest/github-models), and [Together AI free-tier change](https://support.together.ai/articles/1862638756-changes-to-free-tier-and-billing-july-2025)
