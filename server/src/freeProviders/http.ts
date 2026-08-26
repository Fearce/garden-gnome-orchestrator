import { ProviderRequestError, type ProviderErrorKind, type RateLimitReading } from "./types.js";

const DEFAULT_TIMEOUT_MS = 20_000;

export interface ProviderHttpResponse<T> {
  body: T;
  headers: Headers;
  status: number;
}

export interface ProviderFetchOptions {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  secrets?: string[];
}

/** Provider errors occasionally echo a credential-bearing URL. Nothing upstream is trusted to redact it. */
export function redactProviderText(input: unknown, secrets: string[] = []): string {
  let text = String(input ?? "");
  for (const secret of secrets.filter(Boolean)) text = text.split(secret).join("[redacted]");
  return text
    .replace(/(authorization\s*[:=]\s*bearer\s+)[^\s,;]+/gi, "$1[redacted]")
    .replace(/([?&](?:key|api_key|token)=)[^&\s]+/gi, "$1[redacted]")
    .replace(/\b(?:gsk_|sk-or-v1-|AIza|cf_|nvapi-|hf_)[A-Za-z0-9._-]{12,}\b/g, "[redacted]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 300);
}

function providerMessage(body: unknown, fallback: string, secrets: string[]): string {
  if (!body || typeof body !== "object") return redactProviderText(fallback, secrets);
  const record = body as Record<string, unknown>;
  const nested = record.error && typeof record.error === "object" ? (record.error as Record<string, unknown>) : undefined;
  const candidate = nested?.message ?? nested?.detail ?? record.message ?? record.detail ?? record.error;
  return redactProviderText(typeof candidate === "string" ? candidate : fallback, secrets);
}

function errorKind(status: number, message: string): ProviderErrorKind {
  if (status === 401 || status === 403 || status === 498) return "authentication";
  if (status === 402 || /(?:insufficient|balance|credit).*(?:exhaust|deplet|low)|payment required/i.test(message)) return "billing";
  if (status === 429) return "rate-limit";
  if (status >= 500) return "provider-outage";
  if (/context.{0,20}(?:length|window)|too many (?:input )?tokens/i.test(message)) return "context-length";
  if (/model.{0,30}(?:not found|invalid|retired|deprecated|unavailable)/i.test(message)) return "invalid-model";
  if (status >= 400 && status < 500) return "invalid-configuration";
  return "unknown";
}

function retryAtFromHeaders(headers: Headers, now = Date.now()): string | undefined {
  const value = headers.get("retry-after");
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return new Date(now + seconds * 1000).toISOString();
  const epoch = Date.parse(value);
  return Number.isFinite(epoch) ? new Date(epoch).toISOString() : undefined;
}

async function parseBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

/** Consume an unsuccessful response and throw the normalized, redacted provider error. */
export async function throwProviderResponse(response: Response, secrets: string[] = []): Promise<never> {
  const body = await parseBody(response);
  const message = providerMessage(body, `Provider returned HTTP ${response.status}.`, secrets);
  throw new ProviderRequestError(message, errorKind(response.status, message), response.status, retryAtFromHeaders(response.headers));
}

export async function providerFetch(
  url: string,
  init: RequestInit,
  options: ProviderFetchOptions = {},
): Promise<Response> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeout = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  try {
    return await fetchImpl(url, { ...init, signal: init.signal ?? AbortSignal.timeout(timeout) });
  } catch (error) {
    const name = error instanceof Error ? error.name : "";
    if (name === "TimeoutError" || name === "AbortError") {
      throw new ProviderRequestError(`Provider request timed out after ${Math.round(timeout / 1000)}s.`, "timeout");
    }
    throw new ProviderRequestError(
      redactProviderText(error instanceof Error ? error.message : "Provider network request failed.", options.secrets),
      "network",
    );
  }
}

export async function requestJson<T>(
  url: string,
  init: RequestInit,
  options: ProviderFetchOptions = {},
): Promise<ProviderHttpResponse<T>> {
  const response = await providerFetch(url, init, options);
  if (!response.ok) await throwProviderResponse(response, options.secrets);
  const body = await parseBody(response);
  return { body: body as T, headers: response.headers, status: response.status };
}

function finiteNumber(value: string | null): number | undefined {
  if (value == null || value.trim() === "") return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

/** Groq uses compact durations such as `2m59.56s`; generic gateways may use epoch seconds or dates. */
export function parseResetAt(value: string | null, now = Date.now()): string | undefined {
  if (!value) return undefined;
  const compact = value.trim().match(/^(?:(\d+(?:\.\d+)?)h)?(?:(\d+(?:\.\d+)?)m)?(?:(\d+(?:\.\d+)?)s)?$/i);
  if (compact && compact[0] && (compact[1] || compact[2] || compact[3])) {
    const ms = ((Number(compact[1] ?? 0) * 3600 + Number(compact[2] ?? 0) * 60 + Number(compact[3] ?? 0)) * 1000);
    return new Date(now + ms).toISOString();
  }
  const n = Number(value);
  if (Number.isFinite(n) && n > 0) {
    // Epoch values dominate in real APIs; a small number is a duration in seconds.
    const epochMs = n > 10_000_000_000 ? n : n > 1_000_000_000 ? n * 1000 : now + n * 1000;
    return new Date(epochMs).toISOString();
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : undefined;
}

export function parseRateLimitHeaders(headers: Headers, now = Date.now()): RateLimitReading | undefined {
  const groqRequests = finiteNumber(headers.get("x-ratelimit-limit-requests"));
  const groqRequestsLeft = finiteNumber(headers.get("x-ratelimit-remaining-requests"));
  const groqTokens = finiteNumber(headers.get("x-ratelimit-limit-tokens"));
  const groqTokensLeft = finiteNumber(headers.get("x-ratelimit-remaining-tokens"));
  const genericLimit = finiteNumber(headers.get("x-ratelimit-limit"));
  const genericRemaining = finiteNumber(headers.get("x-ratelimit-remaining"));
  const retryAt = retryAtFromHeaders(headers, now);

  if (groqRequests != null || groqRequestsLeft != null || groqTokens != null || groqTokensLeft != null || retryAt) {
    return {
      source: "response-header",
      requests:
        groqRequests != null || groqRequestsLeft != null
          ? {
              limit: groqRequests,
              remaining: groqRequestsLeft,
              resetAt: parseResetAt(headers.get("x-ratelimit-reset-requests"), now),
              window: "day",
            }
          : genericLimit != null || genericRemaining != null
            ? {
                limit: genericLimit,
                remaining: genericRemaining,
                resetAt: parseResetAt(headers.get("x-ratelimit-reset"), now),
                window: "dynamic",
              }
            : undefined,
      tokens:
        groqTokens != null || groqTokensLeft != null
          ? {
              limit: groqTokens,
              remaining: groqTokensLeft,
              resetAt: parseResetAt(headers.get("x-ratelimit-reset-tokens"), now),
              window: "minute",
            }
          : undefined,
      retryAt,
    };
  }

  if (genericLimit != null || genericRemaining != null) {
    return {
      source: "response-header",
      requests: {
        limit: genericLimit,
        remaining: genericRemaining,
        resetAt: parseResetAt(headers.get("x-ratelimit-reset"), now),
        window: "dynamic",
      },
      retryAt,
    };
  }
  return undefined;
}

/** Incremental, CRLF-safe decoder for data-only Server-Sent Events. */
export class SseDecoder {
  private buffer = "";

  push(chunk: string): string[] {
    const combined = this.buffer + chunk;
    // A network chunk may split the two bytes of CRLF. Keep a trailing CR until the next push so
    // one logical newline cannot accidentally become a blank-line frame boundary.
    const trailingCr = combined.endsWith("\r");
    const complete = trailingCr ? combined.slice(0, -1) : combined;
    const frames = complete.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n\n");
    this.buffer = (frames.pop() ?? "") + (trailingCr ? "\r" : "");
    return frames.flatMap(frameData);
  }

  finish(): string[] {
    const tail = this.buffer;
    this.buffer = "";
    return tail ? frameData(tail) : [];
  }
}

function frameData(frame: string): string[] {
  const data = frame
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trimStart());
  return data.length ? [data.join("\n")] : [];
}

export async function* decodeSse(response: Response): AsyncIterable<string> {
  if (!response.body) throw new ProviderRequestError("Provider returned an empty streaming response.", "provider-outage");
  const decoder = new TextDecoder();
  const sse = new SseDecoder();
  for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
    for (const frame of sse.push(decoder.decode(chunk, { stream: true }))) yield frame;
  }
  const finalText = decoder.decode();
  for (const frame of sse.push(finalText)) yield frame;
  for (const frame of sse.finish()) yield frame;
}
