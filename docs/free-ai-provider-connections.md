# Free AI provider connections

GG Orchestrator now has an authentication and inference connection lab for nine providers with recurring free access or recurring free account credit. Open **Settings → Free AI connections** to use it. No code or environment-file edit is required.

The lab deliberately stops one layer short of automatic task routing. GGO's existing Claude, Codex, Grok, and z.ai backends are coding-agent harnesses: they own tools, workspace mutation, resumable sessions, steering, the office bridge, and the commit contract. A chat-completions endpoint alone does not provide those guarantees. Marking these APIs as implementor failover targets before that harness exists would turn a green credential check into unsafe task dispatch. The new adapters do provide normalized completion, SSE streaming, tool-call, model, usage, and error primitives for that next layer.

## Ready to authenticate

| Provider | Supported authentication | Recurring allowance shown by GGO | Model safety | Usage chip | Adapter readiness |
|---|---|---|---|---|---|
| Google Gemini API | Google AI Studio API key | Project/model-specific free RPM, TPM, and RPD | Dynamic catalog; only currently verified free-tier Flash model families are probe-eligible | Local request/token evidence; exact project caps remain in AI Studio | Native completion, SSE, functions, models |
| Groq | GroqCloud API key | Model-specific free RPD/TPD | Dynamic catalog intersected with the current official free-plan allowlist | Exact request/day and token/minute response headers after a probe; local count before that | OpenAI-compatible completion, SSE, tools, models |
| OpenRouter | OpenRouter API key | 50 free-model requests/day, or 1,000/day for a funded account | Live catalog must report exactly-zero input, output, and request prices; `:free` only plus `openrouter/free` | Published request cap minus this GGO's calls; `/api/v1/key` identifies free/funded tier and account-credit metadata | OpenAI-compatible completion, SSE, tools, models |
| Kilo Gateway | Anonymous, or optional Kilo key | 200 free-model requests per rolling hour/IP | Live catalog must report exactly-zero input/output pricing; free routes only plus `kilo-auto/free` | Persisted rolling-hour estimate; shared-IP activity outside GGO is unknowable | OpenAI-compatible completion, SSE, tools, models |
| Mistral | Mistral API key from a workspace in Free mode | $10/month included credits | Dynamic chat-capable catalog; explicit probe only | Published $10 allowance and locally reported cost/tokens when present; remaining balance stays in Mistral Console | OpenAI-compatible completion, SSE, tools, models |
| Cohere | Cohere evaluation API key | 1,000 calls/month; chat keys commonly have a 20 RPM trial limit | Dynamic chat-model catalog | Persisted monthly estimate for this GGO instance | Native v2 completion, SSE, tools, models |
| Cloudflare Workers AI | Account API token + account ID | 10,000 Neurons/day, resetting 00:00 UTC | Dynamic catalog intersected with published neuron-rate metadata; documented paid-only and unknown models are blocked | Estimated Neurons from response tokens and published per-model rates | OpenAI-compatible completion, SSE, tools, models |
| NVIDIA NIM | NVIDIA Developer Program API key | Free hosted endpoint prototyping; NVIDIA publishes no numeric cap | Dynamic catalog filtered to conversational/coding model families | Honest cap-not-exposed state plus persisted request/token evidence | OpenAI-compatible completion, SSE, tools, models |
| Hugging Face Inference Providers | Fine-grained Hugging Face token | $0.10/month routed credit for free accounts | Live providers with explicit per-million-token prices; probes pin the exact provider suffix | Published credit minus conservative live-price estimates for this GGO | OpenAI-compatible completion, SSE, tools, models |

“Adapter readiness” is contract-tested without real credentials. It does **not** mean a provider account has connected successfully. Until Kevin validates an account, the card says **Awaiting auth** or **Needs validation**. A successful catalog call says **Ready to probe**; only an explicit one-request test says the inference path connected.

## Setup tonight

1. Open the gear menu, then **Free AI connections**.
2. Expand a provider card.
3. Follow **Get credentials** to the provider's official account page.
4. Paste the credential. Cloudflare also needs the account ID; Kilo can be left anonymous.
5. Choose **Connect & validate** (or **Save & validate**). This saves the secret server-side and performs model discovery/account metadata reads only. It does not run inference.
6. Check the state, discovered/free counts, and quota chip. Select a free probe model if more than one is eligible.
7. Choose **Test with 1 request**, read the billing warning, then confirm **Send exactly 1 request**. The server refreshes the live catalog again before sending the fixed, tiny connectivity prompt.

Provider prerequisites:

- **Gemini:** create a key in [Google AI Studio](https://aistudio.google.com/app/apikey). This integration intentionally does not copy Gemini CLI OAuth/browser credentials. Keep the project on the free tier if no spend is wanted.
- **Groq:** create a key in [GroqCloud](https://console.groq.com/keys). The card reads exact quota headers after its first completed request.
- **OpenRouter:** create a key in [OpenRouter settings](https://openrouter.ai/settings/keys). The key endpoint is used to distinguish free-tier from funded-account free-request caps; no paid model can be selected in the lab.
- **Kilo:** no account is required for documented anonymous free-model access. A key from [Kilo](https://app.kilo.ai/) is optional.
- **Mistral:** put the workspace in **Free** mode and create a key in [Mistral Console](https://console.mistral.ai/api-keys). Free-mode/account balance is authoritative there.
- **Cohere:** create a free **evaluation** key in the [Cohere dashboard](https://dashboard.cohere.com/api-keys). GGO cannot distinguish an evaluation key from a production key, so verify the key type before probing.
- **Cloudflare:** create a custom account API token with **Workers AI Read** and **Workers AI Edit**, and copy the account ID. The Workers Free plan stops at the daily allocation; a paid Workers plan may bill beyond it, which is why GGO only allows explicit probes.
- **NVIDIA:** join the free [NVIDIA Developer Program](https://developer.nvidia.com/developer-program), then create a hosted API Catalog key at [build.nvidia.com](https://build.nvidia.com/). The provider does not expose a numeric remaining-prototype allowance, so GGO never invents one.
- **Hugging Face:** create a [fine-grained token](https://huggingface.co/settings/tokens) with **Inference Providers** permission. Free accounts currently receive $0.10/month in routed credit. Remove/avoid BYOK provider keys if the intent is to consume only Hugging Face's credit; GGO pins one live provider route but cannot inspect keys configured in your Hugging Face account.

Environment fallbacks are also supported: `GEMINI_API_KEY`, `GROQ_API_KEY`, `OPENROUTER_API_KEY`, `KILO_API_KEY`, `MISTRAL_API_KEY`, `COHERE_API_KEY`, `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, `NVIDIA_API_KEY`, and `HF_TOKEN`. A stored UI credential wins over the environment. **Forget stored key** removes only the database value; an environment key remains active and is labelled as such.

## Security and failure behavior

- Provider routes are behind the existing GGO session authentication.
- Raw keys enter only the provider `PUT` route and the local SQLite key-value store, matching GGO's existing z.ai/OpenAI secret convention. Responses and WebSocket snapshots contain only presence, source, and last four characters.
- Password fields are cleared after save; saved values cannot be revealed through the UI.
- Provider errors and credential-bearing URLs are redacted before persistence or return. Probe logs contain provider, served model/provider, request ID, latency, token counts, and normalized error class—never the key, prompt, response text, or authorization header.
- 401/403/498, billing/402, 429/`Retry-After`, 5xx, timeout, network, context-window, and invalid-model failures become distinct card states. There is no automatic retry and no automatic provider/model failover.
- OpenRouter and Kilo pricing is refreshed immediately before inference. A previously free catalog entry that becomes non-zero is rejected before a completion call.
- The local quota ledger is keyed by a salted HMAC credential/account fingerprint. It survives restart, separates rotated keys, applies provider window timezone rules, and records rejected calls with a zero request count.
- Every provider card always carries a usage chip. `EST`/`~` means locally calculated; “not exposed” never becomes a false zero.

## What remains outside this slice

| Candidate | Status | Reason |
|---|---|---|
| Cerebras / Fireworks | Not integrated | One-time trial credit, not recurring free quota. Deferred behind the recurring providers and must be labelled as trial if added. |
| GitHub Models | Rejected | GitHub retired the Models playground, catalog, inference API, and BYOK service on 2026-07-30. Copilot is a separate product. |
| Together AI | Rejected | Current official support says there is no free trial and a credit purchase is required. |
| OpenCode Zen | Deferred | Its current docs identify some time-limited free models, correcting the proposal's assumption. The public model catalog does not expose price or free expiry, while the account can auto-reload credit, so GGO cannot revalidate a no-spend boundary before each probe. |

The next engineering step is not another credential card. It is a provider-neutral coding-agent harness that implements workspace tools, source-safe prompting, steering, resumable sessions, usage accounting for streams, office/bus communication, and the commit contract. Only after a provider passes that harness's integration suite should it become eligible for the Free Pool/task failover ladder.

## Official references checked 2026-08-26

- [Gemini API rate limits](https://ai.google.dev/gemini-api/docs/rate-limits), [models API](https://ai.google.dev/api/models), and [generate/stream/function API](https://ai.google.dev/api/generate-content)
- [Groq rate limits and headers](https://console.groq.com/docs/rate-limits) and [API reference](https://console.groq.com/docs/api-reference)
- [OpenRouter FAQ/free limits](https://openrouter.ai/docs/faq), [models API](https://openrouter.ai/docs/api/api-reference/models/get-models), [key/limits API](https://openrouter.ai/docs/api-reference/limits), and [chat API](https://openrouter.ai/docs/api/api-reference/chat/send-chat-completion-request)
- [Kilo authentication](https://kilo.ai/docs/gateway/authentication), [models/API](https://kilo.ai/docs/gateway/api-reference), and [usage](https://kilo.ai/docs/gateway/usage-and-billing)
- [Mistral pricing](https://mistral.ai/pricing/), [usage limits](https://docs.mistral.ai/admin/billing-usage/usage-limits), [models](https://docs.mistral.ai/api/endpoint/models), and [chat](https://docs.mistral.ai/api/endpoint/chat)
- [Cohere evaluation limits](https://docs.cohere.com/docs/rate-limits), [models](https://docs.cohere.com/reference/list-models), [v2 chat](https://docs.cohere.com/v2/reference/chat), and [tool use](https://docs.cohere.com/v2/docs/tool-use-overview/)
- [Cloudflare Workers AI pricing](https://developers.cloudflare.com/workers-ai/platform/pricing/), [OpenAI compatibility](https://developers.cloudflare.com/workers-ai/configuration/open-ai-compatibility/), [REST setup](https://developers.cloudflare.com/workers-ai/get-started/rest-api/), and [model search](https://developers.cloudflare.com/api/resources/ai/subresources/models/methods/list/)
- [NVIDIA hosted NIM access](https://developer.nvidia.com/nim) and [NIM chat API](https://docs.nvidia.com/nim/large-language-models/latest/api-reference.html)
- [Hugging Face pricing/credits](https://huggingface.co/docs/inference-providers/pricing), [provider-aware models API](https://huggingface.co/docs/inference-providers/en/hub-api), and [chat completion routing](https://huggingface.co/docs/inference-providers/main/en/tasks/chat-completion)
- [OpenCode Zen models and free-route notices](https://opencode.ai/docs/zen/), [GitHub Models retirement](https://docs.github.com/en/enterprise-cloud@latest/github-models), and [Together AI free-tier change](https://support.together.ai/articles/1862638756-changes-to-free-tier-and-billing-july-2025)
