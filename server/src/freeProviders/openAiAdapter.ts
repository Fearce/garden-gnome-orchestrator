import { decodeSse, parseRateLimitHeaders, providerFetch, requestJson, throwProviderResponse } from "./http.js";
import {
  ProviderRequestError,
  type CompletionUsage,
  type FreeProviderId,
  type NormalizedCompletion,
  type NormalizedCompletionRequest,
  type NormalizedStreamEvent,
  type NormalizedToolCall,
  type ProviderAdapter,
  type ProviderCredentials,
  type ProviderModel,
  type ProviderUsageSnapshot,
} from "./types.js";

type UnknownRecord = Record<string, unknown>;

export interface OpenAiCompatibleOptions {
  providerId: FreeProviderId;
  modelsUrl(credentials: ProviderCredentials): string;
  completionUrl(credentials: ProviderCredentials): string;
  headers(credentials: ProviderCredentials): Record<string, string>;
  normalizeModels(body: unknown): ProviderModel[];
  decorateRequest?(body: UnknownRecord): UnknownRecord;
  accountUsage?(credentials: ProviderCredentials): Promise<Partial<ProviderUsageSnapshot> | null>;
  /** Hosted prototype endpoints may queue cold models longer than the generic 20-second request cap. */
  completionTimeoutMs?: number;
  fetchImpl?: typeof fetch;
}

function record(value: unknown): UnknownRecord | null {
  return value != null && typeof value === "object" && !Array.isArray(value) ? (value as UnknownRecord) : null;
}

function finite(value: unknown): number | undefined {
  const n = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : Number.NaN;
  return Number.isFinite(n) ? n : undefined;
}

function textContent(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value
    .map((part) => {
      if (typeof part === "string") return part;
      const item = record(part);
      return typeof item?.text === "string" ? item.text : "";
    })
    .join("");
}

export function parseOpenAiUsage(value: unknown): CompletionUsage {
  const usage = record(value);
  if (!usage) return {};
  const inputTokens = finite(usage.prompt_tokens ?? usage.input_tokens);
  const outputTokens = finite(usage.completion_tokens ?? usage.output_tokens);
  const totalTokens = finite(usage.total_tokens) ??
    (inputTokens != null || outputTokens != null ? (inputTokens ?? 0) + (outputTokens ?? 0) : undefined);
  const costUsd = finite(usage.cost ?? usage.cost_usd ?? usage.total_cost);
  return { inputTokens, outputTokens, totalTokens, costUsd };
}

export function parseOpenAiToolCalls(value: unknown): NormalizedToolCall[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((candidate, index) => {
    const call = record(candidate);
    const fn = record(call?.function);
    const name = typeof fn?.name === "string" ? fn.name : typeof call?.name === "string" ? call.name : "";
    if (!name) return [];
    const args = fn?.arguments ?? call?.arguments ?? "{}";
    return [{
      id: typeof call?.id === "string" ? call.id : `call-${index}`,
      name,
      arguments: typeof args === "string" ? args : JSON.stringify(args),
    }];
  });
}

function requestBody(input: NormalizedCompletionRequest, stream: boolean): UnknownRecord {
  const body: UnknownRecord = {
    model: input.model,
    messages: input.messages.map((message) => {
      const output: UnknownRecord = {
        role: message.role,
        content: message.content,
        ...(message.toolCallId ? { tool_call_id: message.toolCallId } : {}),
      };
      if (message.role === "assistant" && message.toolCalls?.length) {
        output.tool_calls = message.toolCalls.map((call) => ({
          id: call.id,
          type: "function",
          function: { name: call.name, arguments: call.arguments },
        }));
      }
      return output;
    }),
    stream,
  };
  if (input.maxOutputTokens != null) body.max_tokens = input.maxOutputTokens;
  if (input.tools?.length) {
    body.tools = input.tools.map((tool) => ({
      type: "function",
      function: { name: tool.name, description: tool.description, parameters: tool.parameters },
    }));
  }
  if (stream) body.stream_options = { include_usage: true };
  return body;
}

function normalizedCompletion(body: unknown, headers: Headers, requestedModel: string): NormalizedCompletion {
  const root = record(body);
  const choices = Array.isArray(root?.choices) ? root.choices : [];
  const first = record(choices[0]);
  const message = record(first?.message);
  const model = typeof root?.model === "string" ? root.model : requestedModel;
  const upstreamProvider =
    typeof root?.provider === "string"
      ? root.provider
      : typeof root?.upstream_provider === "string"
        ? root.upstream_provider
        : typeof first?.provider === "string"
          ? first.provider
          : undefined;
  return {
    text: textContent(message?.content),
    model,
    upstreamProvider,
    toolCalls: parseOpenAiToolCalls(message?.tool_calls),
    usage: parseOpenAiUsage(root?.usage),
    rateLimit: parseRateLimitHeaders(headers),
    requestId: headers.get("x-request-id") ?? (typeof root?.id === "string" ? root.id : undefined),
  };
}

/** Shared adapter for documented OpenAI-compatible gateways; it never retries or changes models. */
export class OpenAiCompatibleAdapter implements ProviderAdapter {
  constructor(private readonly options: OpenAiCompatibleOptions) {}

  async listModels(credentials: ProviderCredentials): Promise<ProviderModel[]> {
    const headers = this.options.headers(credentials);
    const secret = credentials.apiKey ? [credentials.apiKey] : [];
    const response = await requestJson<unknown>(
      this.options.modelsUrl(credentials),
      { method: "GET", headers },
      { fetchImpl: this.options.fetchImpl, secrets: secret },
    );
    return this.options.normalizeModels(response.body);
  }

  async complete(credentials: ProviderCredentials, input: NormalizedCompletionRequest): Promise<NormalizedCompletion> {
    const headers = { "content-type": "application/json", ...this.options.headers(credentials) };
    const body = this.options.decorateRequest?.(requestBody(input, false)) ?? requestBody(input, false);
    const response = await requestJson<unknown>(
      this.options.completionUrl(credentials),
      { method: "POST", headers, body: JSON.stringify(body) },
      { fetchImpl: this.options.fetchImpl, secrets: credentials.apiKey ? [credentials.apiKey] : [], timeoutMs: this.options.completionTimeoutMs },
    );
    return normalizedCompletion(response.body, response.headers, input.model);
  }

  async *stream(credentials: ProviderCredentials, input: NormalizedCompletionRequest): AsyncIterable<NormalizedStreamEvent> {
    const headers = { "content-type": "application/json", accept: "text/event-stream", ...this.options.headers(credentials) };
    const rawBody = requestBody(input, true);
    const body = this.options.decorateRequest?.(rawBody) ?? rawBody;
    const secrets = credentials.apiKey ? [credentials.apiKey] : [];
    const response = await providerFetch(
      this.options.completionUrl(credentials),
      { method: "POST", headers, body: JSON.stringify(body) },
      { fetchImpl: this.options.fetchImpl, secrets, timeoutMs: this.options.completionTimeoutMs },
    );
    if (!response.ok) await throwProviderResponse(response, secrets);

    let finalModel: string | undefined;
    let finalProvider: string | undefined;
    for await (const frame of decodeSse(response)) {
      if (frame.trim() === "[DONE]") break;
      let payload: unknown;
      try {
        payload = JSON.parse(frame) as unknown;
      } catch {
        throw new ProviderRequestError("Provider returned a malformed streaming event.", "provider-outage");
      }
      const root = record(payload);
      if (!root) continue;
      if (typeof root.model === "string") finalModel = root.model;
      if (typeof root.provider === "string") finalProvider = root.provider;
      if (typeof root.upstream_provider === "string") finalProvider = root.upstream_provider;
      const choices = Array.isArray(root.choices) ? root.choices : [];
      for (const choiceValue of choices) {
        const choice = record(choiceValue);
        const delta = record(choice?.delta);
        const content = textContent(delta?.content);
        if (content) yield { type: "text-delta", text: content };
        if (Array.isArray(delta?.tool_calls)) {
          for (const candidate of delta.tool_calls) {
            const call = record(candidate);
            const fn = record(call?.function);
            const index = finite(call?.index) ?? 0;
            yield {
              type: "tool-call-delta",
              index,
              id: typeof call?.id === "string" ? call.id : undefined,
              name: typeof fn?.name === "string" ? fn.name : undefined,
              arguments: typeof fn?.arguments === "string" ? fn.arguments : undefined,
            };
          }
        }
      }
      const usage = parseOpenAiUsage(root.usage);
      if (Object.values(usage).some((value) => value != null)) yield { type: "usage", usage };
    }
    yield { type: "done", model: finalModel, upstreamProvider: finalProvider };
  }

  accountUsage(credentials: ProviderCredentials): Promise<Partial<ProviderUsageSnapshot> | null> {
    return this.options.accountUsage?.(credentials) ?? Promise.resolve(null);
  }
}
