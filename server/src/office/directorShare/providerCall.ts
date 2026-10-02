import type { RelayShareErrorCode, RelayShareMessage, RelayShareUsage } from "../onlineProtocol.js";
import type { ShareableEndpoint } from "./policy.js";

export type ShareFetch = (url: string, init: RequestInit) => Promise<Response>;

export type ProviderCallResult =
  | { ok: true; text: string; usage: RelayShareUsage }
  | { ok: false; code: RelayShareErrorCode; message: string; aborted?: boolean };

/** Output cap per shared call. A Director command is one short JSON object; this bounds what one
 *  recipient request can cost the donor. */
export const SHARE_MAX_OUTPUT_TOKENS = 4096;
/** A Director model call that has not answered in this long is abandoned. */
export const SHARE_PROVIDER_TIMEOUT_MS = 5 * 60_000;

/**
 * One chat-completions request on the donor's own key. The donor adds nothing to the recipient's
 * messages (no system prompt, memory or tools) and fixes two parameters the recipient cannot change:
 * JSON-object output, which is the Director command bridge's format and nothing else, and the output cap.
 *
 * Error text is composed here from the HTTP status and the provider's error CODE only. Provider bodies are
 * never forwarded: an authentication error, for one, echoes a masked fragment of the key.
 */
export async function callChatCompletion(input: {
  fetch: ShareFetch;
  endpoint: ShareableEndpoint;
  model: string;
  messages: RelayShareMessage[];
  signal: AbortSignal;
}): Promise<ProviderCallResult> {
  const timeout = AbortSignal.timeout(SHARE_PROVIDER_TIMEOUT_MS);
  const signal = AbortSignal.any([input.signal, timeout]);
  let res: Response;
  try {
    res = await input.fetch(`${input.endpoint.baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${input.endpoint.apiKey}` },
      body: JSON.stringify({
        model: input.model,
        messages: input.messages,
        response_format: { type: "json_object" },
        max_completion_tokens: SHARE_MAX_OUTPUT_TOKENS,
      }),
      signal,
    });
  } catch {
    if (input.signal.aborted) return { ok: false, code: "cancelled", message: "The call was stopped.", aborted: true };
    if (timeout.aborted) return { ok: false, code: "timeout", message: "The provider did not answer in time." };
    return { ok: false, code: "provider-error", message: "The donor's machine could not reach the provider." };
  }
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    if (input.signal.aborted) return { ok: false, code: "cancelled", message: "The call was stopped.", aborted: true };
    body = null;
  }
  if (!res.ok) return providerFailure(res.status, body);
  const text = completionText(body);
  if (text == null) return { ok: false, code: "provider-error", message: "The provider returned no reply text." };
  return { ok: true, text, usage: completionUsage(body) };
}

/** The models the donor's key can call, for the share form's picker. Chat models only: embeddings, audio,
 *  image and moderation models cannot serve a Director. */
export async function listChatModels(fetchImpl: ShareFetch, endpoint: ShareableEndpoint): Promise<{ ok: true; models: string[] } | { ok: false; error: string }> {
  let res: Response;
  try {
    res = await fetchImpl(`${endpoint.baseUrl}/models`, {
      headers: { authorization: `Bearer ${endpoint.apiKey}` },
      signal: AbortSignal.timeout(20_000),
    });
  } catch {
    return { ok: false, error: "Could not reach the provider to list models." };
  }
  if (!res.ok) return { ok: false, error: providerFailure(res.status, await res.json().catch(() => null)).message };
  const body = (await res.json().catch(() => null)) as { data?: Array<{ id?: unknown }> } | null;
  const ids = (body?.data ?? []).map((m) => (typeof m.id === "string" ? m.id : "")).filter(isChatModelId);
  return { ok: true, models: [...new Set(ids)].sort((a, b) => b.localeCompare(a)) };
}

// `codex` models answer only on the Responses API, not chat completions.
const NON_CHAT = /(embed|audio|realtime|transcribe|tts|whisper|dall-e|image|moderation|search|instruct|davinci|babbage|codex)/i;

export function isChatModelId(id: string): boolean {
  return /^(gpt-|o\d|chatgpt-|grok-)/i.test(id) && !NON_CHAT.test(id);
}

function providerFailure(status: number, body: unknown): Extract<ProviderCallResult, { ok: false }> {
  const code = errorCode(body);
  if (status === 401 || status === 403) return { ok: false, code: "provider-error", message: "The provider refused the donor's API key." };
  if (status === 429) {
    return code === "insufficient_quota"
      ? { ok: false, code: "exhausted", message: "The donor's provider quota or credit is used up." }
      : { ok: false, code: "rate-limited", message: "The provider is rate-limiting the donor's key. Try again shortly." };
  }
  if (status === 402) return { ok: false, code: "exhausted", message: "The donor's provider account has no credit left." };
  if (code === "context_length_exceeded") return { ok: false, code: "too-large", message: "The conversation is longer than the model accepts." };
  if (status === 404 || code === "model_not_found") return { ok: false, code: "provider-error", message: "The shared model is not available on the donor's key." };
  if (status >= 500) return { ok: false, code: "provider-error", message: `The provider failed (HTTP ${status}).` };
  return { ok: false, code: "provider-error", message: `The provider rejected the request (HTTP ${status}${code ? `, ${code}` : ""}).` };
}

/** The provider's machine-readable error code, held to a safe shape: it is the only part of an error body
 *  that is ever repeated to a recipient. */
function errorCode(body: unknown): string | undefined {
  const err = (body as { error?: { code?: unknown; type?: unknown } } | null)?.error;
  const raw = typeof err?.code === "string" ? err.code : typeof err?.type === "string" ? err.type : undefined;
  return raw && /^[a-z0-9_.-]{1,60}$/i.test(raw) ? raw : undefined;
}

function completionText(body: unknown): string | null {
  const choice = (body as { choices?: Array<{ message?: { content?: unknown } }> } | null)?.choices?.[0];
  const content = choice?.message?.content;
  return typeof content === "string" ? content : null;
}

function completionUsage(body: unknown): RelayShareUsage {
  const usage = (body as { usage?: { prompt_tokens?: unknown; completion_tokens?: unknown } } | null)?.usage;
  const n = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.round(v) : 0);
  return { inputTokens: n(usage?.prompt_tokens), outputTokens: n(usage?.completion_tokens) };
}
