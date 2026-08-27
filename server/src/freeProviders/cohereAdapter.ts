import { decodeSse, providerFetch, requestJson, throwProviderResponse } from "./http.js";
import {
  ProviderRequestError,
  type CompletionUsage,
  type NormalizedCompletion,
  type NormalizedCompletionRequest,
  type NormalizedStreamEvent,
  type ProviderAdapter,
  type ProviderCredentials,
  type ProviderModel,
} from "./types.js";

type UnknownRecord = Record<string, unknown>;

function record(value: unknown): UnknownRecord | null {
  return value != null && typeof value === "object" && !Array.isArray(value) ? (value as UnknownRecord) : null;
}

function finite(value: unknown): number | undefined {
  const n = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : Number.NaN;
  return Number.isFinite(n) ? n : undefined;
}

function usageOf(value: unknown): CompletionUsage {
  const usage = record(value);
  const billed = record(usage?.billed_units);
  const tokens = record(usage?.tokens);
  const inputTokens = finite(billed?.input_tokens ?? tokens?.input_tokens);
  const outputTokens = finite(billed?.output_tokens ?? tokens?.output_tokens);
  return {
    inputTokens,
    outputTokens,
    totalTokens: inputTokens != null || outputTokens != null ? (inputTokens ?? 0) + (outputTokens ?? 0) : undefined,
  };
}

function contentText(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value.map((part) => record(part)?.text).filter((text): text is string => typeof text === "string").join("");
}

export function normalizeCohereModels(body: unknown): ProviderModel[] {
  const root = record(body);
  const values = Array.isArray(body) ? body : Array.isArray(root?.models) ? root.models : [];
  return values.flatMap((raw) => {
    const model = record(raw);
    const id = typeof model?.name === "string" ? model.name : typeof model?.id === "string" ? model.id : "";
    // Cohere's documented /v1/models payload explicitly marks retired entries. Keeping one in
    // the card makes a stale saved selection look runnable until the paid/free probe gets a
    // needless invalid-model response, so exclude it during live catalog normalization.
    if (!id || model?.is_deprecated === true) return [];
    const endpoints = Array.isArray(model?.endpoints) ? model.endpoints : [];
    if (endpoints.length && !endpoints.includes("chat")) return [];
    const features = Array.isArray(model?.features) ? model.features : [];
    return [{
      providerId: "cohere" as const,
      id,
      displayName: typeof model?.display_name === "string" ? model.display_name : id,
      contextWindow: finite(model?.context_length),
      supportsStreaming: true,
      supportsTools: features.some((feature) => typeof feature === "string" && /tool/i.test(feature)) || null,
      isFree: true,
      freeStatusSource: "configured" as const,
    }];
  });
}

function requestBody(input: NormalizedCompletionRequest, stream: boolean): UnknownRecord {
  const body: UnknownRecord = {
    model: input.model,
    stream,
    messages: input.messages.map((message) => {
      if (message.role === "tool") {
        return {
          role: "tool",
          tool_call_id: message.toolCallId ?? "tool-call",
          content: [{ type: "document", document: { data: message.content } }],
        };
      }
      return {
        role: message.role,
        content: message.content,
        ...(message.role === "assistant" && message.toolCalls?.length
          ? {
              tool_calls: message.toolCalls.map((call) => ({
                id: call.id,
                type: "function",
                function: { name: call.name, arguments: call.arguments },
              })),
            }
          : {}),
      };
    }),
  };
  if (input.maxOutputTokens != null) body.max_tokens = input.maxOutputTokens;
  if (input.tools?.length) {
    body.tools = input.tools.map((tool) => ({
      type: "function",
      function: { name: tool.name, description: tool.description, parameters: tool.parameters },
    }));
  }
  return body;
}

function toolCalls(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value.flatMap((candidate, index) => {
    const call = record(candidate);
    const fn = record(call?.function);
    const name = typeof fn?.name === "string" ? fn.name : "";
    if (!name) return [];
    const args = fn?.arguments ?? "{}";
    return [{
      id: typeof call?.id === "string" ? call.id : `cohere-call-${index}`,
      name,
      arguments: typeof args === "string" ? args : JSON.stringify(args),
    }];
  });
}

export class CohereAdapter implements ProviderAdapter {
  constructor(private readonly fetchImpl?: typeof fetch) {}

  private headers(credentials: ProviderCredentials): Record<string, string> {
    if (!credentials.apiKey) throw new ProviderRequestError("Cohere API key is required.", "invalid-configuration");
    return { authorization: `Bearer ${credentials.apiKey}` };
  }

  async listModels(credentials: ProviderCredentials): Promise<ProviderModel[]> {
    const response = await requestJson<unknown>(
      "https://api.cohere.com/v1/models?endpoint=chat&page_size=1000",
      { headers: this.headers(credentials) },
      { fetchImpl: this.fetchImpl, secrets: credentials.apiKey ? [credentials.apiKey] : [] },
    );
    return normalizeCohereModels(response.body);
  }

  async complete(credentials: ProviderCredentials, input: NormalizedCompletionRequest): Promise<NormalizedCompletion> {
    const response = await requestJson<unknown>(
      "https://api.cohere.com/v2/chat",
      { method: "POST", headers: { ...this.headers(credentials), "content-type": "application/json" }, body: JSON.stringify(requestBody(input, false)) },
      { fetchImpl: this.fetchImpl, secrets: credentials.apiKey ? [credentials.apiKey] : [] },
    );
    const root = record(response.body);
    const message = record(root?.message);
    return {
      text: contentText(message?.content),
      model: typeof root?.model === "string" ? root.model : input.model,
      toolCalls: toolCalls(message?.tool_calls),
      usage: usageOf(root?.usage),
      requestId: response.headers.get("x-request-id") ?? (typeof root?.id === "string" ? root.id : undefined),
    };
  }

  async *stream(credentials: ProviderCredentials, input: NormalizedCompletionRequest): AsyncIterable<NormalizedStreamEvent> {
    const secrets = credentials.apiKey ? [credentials.apiKey] : [];
    const response = await providerFetch(
      "https://api.cohere.com/v2/chat",
      { method: "POST", headers: { ...this.headers(credentials), "content-type": "application/json", accept: "text/event-stream" }, body: JSON.stringify(requestBody(input, true)) },
      { fetchImpl: this.fetchImpl, secrets },
    );
    if (!response.ok) await throwProviderResponse(response, secrets);
    let model: string | undefined;
    for await (const frame of decodeSse(response)) {
      let root: UnknownRecord | null;
      try {
        root = record(JSON.parse(frame) as unknown);
      } catch {
        throw new ProviderRequestError("Cohere returned a malformed streaming event.", "provider-outage");
      }
      if (!root) continue;
      const type = typeof root.type === "string" ? root.type : "";
      const delta = record(root.delta);
      const message = record(delta?.message);
      const content = record(message?.content);
      const text = typeof content?.text === "string" ? content.text : "";
      if (text) yield { type: "text-delta", text };
      const toolCall = record(message?.tool_calls);
      const fn = record(toolCall?.function);
      if (type.startsWith("tool-call") || toolCall) {
        yield {
          type: "tool-call-delta",
          index: finite(root.index) ?? finite(toolCall?.index) ?? 0,
          id: typeof toolCall?.id === "string" ? toolCall.id : undefined,
          name: typeof fn?.name === "string" ? fn.name : undefined,
          arguments: typeof fn?.arguments === "string" ? fn.arguments : undefined,
        };
      }
      const usage = usageOf(root.usage ?? delta?.usage);
      if (Object.values(usage).some((value) => value != null)) yield { type: "usage", usage };
      if (typeof root.model === "string") model = root.model;
    }
    yield { type: "done", model };
  }
}
