import { decodeSse, providerFetch, requestJson, throwProviderResponse } from "./http.js";
import {
  ProviderRequestError,
  type CompletionUsage,
  type NormalizedCompletion,
  type NormalizedCompletionRequest,
  type NormalizedStreamEvent,
  type NormalizedToolCall,
  type ProviderAdapter,
  type ProviderCredentials,
  type ProviderModel,
} from "./types.js";

type UnknownRecord = Record<string, unknown>;

const API_ROOT = "https://generativelanguage.googleapis.com/v1beta";
const FREE_BASE_MODELS = new Set(["gemini-3.5-flash", "gemini-3.5-flash-lite", "gemini-3.1-flash-lite"]);

function record(value: unknown): UnknownRecord | null {
  return value != null && typeof value === "object" && !Array.isArray(value) ? (value as UnknownRecord) : null;
}

function finite(value: unknown): number | undefined {
  const n = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : Number.NaN;
  return Number.isFinite(n) ? n : undefined;
}

function usageOf(root: UnknownRecord | null): CompletionUsage {
  const usage = record(root?.usageMetadata);
  const inputTokens = finite(usage?.promptTokenCount);
  const outputTokens = finite(usage?.candidatesTokenCount);
  const totalTokens = finite(usage?.totalTokenCount) ??
    (inputTokens != null || outputTokens != null ? (inputTokens ?? 0) + (outputTokens ?? 0) : undefined);
  return { inputTokens, outputTokens, totalTokens };
}

function partsOf(root: UnknownRecord | null): unknown[] {
  const candidates = Array.isArray(root?.candidates) ? root.candidates : [];
  const candidate = record(candidates[0]);
  const content = record(candidate?.content);
  return Array.isArray(content?.parts) ? content.parts : [];
}

function textOf(parts: unknown[]): string {
  return parts.map((part) => record(part)?.text).filter((text): text is string => typeof text === "string").join("");
}

function toolCallsOf(parts: unknown[]): NormalizedToolCall[] {
  return parts.flatMap((part, index) => {
    const item = record(part);
    const fn = record(item?.functionCall);
    const name = typeof fn?.name === "string" ? fn.name : "";
    if (!name) return [];
    const thoughtSignature = typeof item?.thoughtSignature === "string"
      ? item.thoughtSignature
      : typeof item?.thought_signature === "string"
        ? item.thought_signature
        : undefined;
    return [{
      id: typeof fn?.id === "string" ? fn.id : `gemini-call-${index}`,
      name,
      arguments: JSON.stringify(record(fn?.args) ?? {}),
      providerMetadata: thoughtSignature ? { geminiThoughtSignature: thoughtSignature } : undefined,
    }];
  });
}

/** Gemini function declarations use an OpenAPI subset, not full JSON Schema. The generateContent
 * endpoint currently rejects `additionalProperties` even though structured-output schemas accept it. */
function functionParameters(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(functionParameters);
  const item = record(value);
  if (!item) return value;
  return Object.fromEntries(
    Object.entries(item)
      .filter(([key]) => key !== "additionalProperties")
      .map(([key, nested]) => [key, functionParameters(nested)]),
  );
}

function apiBody(input: NormalizedCompletionRequest): UnknownRecord {
  const systems = input.messages.filter((message) => message.role === "system").map((message) => message.content).join("\n\n");
  const conversation = input.messages.filter((message) => message.role !== "system");
  const contents: UnknownRecord[] = [];
  conversation.forEach((message, index) => {
    if (message.role === "tool") {
      const part = { functionResponse: { id: message.toolCallId, name: message.toolName ?? message.toolCallId ?? "tool", response: { result: message.content } } };
      // Gemini expects results for parallel calls in one user content block, in the same order as the
      // preceding model parts. Consecutive normalized tool messages represent exactly that group.
      const previous = conversation[index - 1];
      const priorContent = contents[contents.length - 1];
      if (previous?.role === "tool" && Array.isArray(priorContent?.parts)) priorContent.parts.push(part);
      else contents.push({ role: "user", parts: [part] });
      return;
    }
    if (message.role === "assistant") {
      contents.push({
        role: "model",
        parts: [
          ...(message.content ? [{ text: message.content }] : []),
          ...(message.toolCalls ?? []).map((call) => ({
            functionCall: {
              id: call.id,
              name: call.name,
              args: (() => {
                try {
                  return JSON.parse(call.arguments) as unknown;
                } catch {
                  return {};
                }
              })(),
            },
            ...(typeof call.providerMetadata?.geminiThoughtSignature === "string"
              ? { thoughtSignature: call.providerMetadata.geminiThoughtSignature }
              : {}),
          })),
        ],
      });
      return;
    }
    contents.push({ role: "user", parts: [{ text: message.content }] });
  });
  const body: UnknownRecord = { contents };
  if (systems) body.systemInstruction = { parts: [{ text: systems }] };
  if (input.maxOutputTokens != null) body.generationConfig = { maxOutputTokens: input.maxOutputTokens };
  if (input.tools?.length) {
    body.tools = [{
      functionDeclarations: input.tools.map((tool) => ({ name: tool.name, description: tool.description, parameters: functionParameters(tool.parameters) })),
    }];
  }
  return body;
}

export function normalizeGeminiModels(body: unknown): ProviderModel[] {
  const root = record(body);
  const models = Array.isArray(root?.models) ? root.models : [];
  return models.flatMap((raw) => {
    const model = record(raw);
    const rawName = typeof model?.name === "string" ? model.name : "";
    const id = rawName.replace(/^models\//, "");
    const methods = Array.isArray(model?.supportedGenerationMethods) ? model.supportedGenerationMethods : [];
    if (!id || !methods.includes("generateContent")) return [];
    const baseModel = typeof model?.baseModelId === "string" ? model.baseModelId : id.replace(/-(?:latest|\d{3})$/, "");
    const free = FREE_BASE_MODELS.has(baseModel) || [...FREE_BASE_MODELS].some((known) => id === known || id.startsWith(`${known}-`));
    return [{
      providerId: "gemini" as const,
      id,
      displayName: typeof model?.displayName === "string" ? model.displayName : id,
      contextWindow: finite(model?.inputTokenLimit),
      supportsStreaming: methods.includes("streamGenerateContent") || methods.includes("generateContent"),
      supportsTools: true,
      isFree: free,
      freeStatusSource: free ? "published" as const : "unknown" as const,
      ineligibleReason: free ? undefined : "Not in GGO's currently verified Gemini API free-tier allowlist.",
    }];
  });
}

export class GeminiAdapter implements ProviderAdapter {
  constructor(private readonly fetchImpl?: typeof fetch) {}

  async listModels(credentials: ProviderCredentials): Promise<ProviderModel[]> {
    if (!credentials.apiKey) throw new ProviderRequestError("Gemini API key is required.", "invalid-configuration");
    const models: ProviderModel[] = [];
    let pageToken: string | undefined;
    for (let page = 0; page < 10; page += 1) {
      // Keep the key out of request URLs. URLs are far more likely than headers to be retained by
      // reverse proxies, tracing, and diagnostics; Google's current REST guidance supports this
      // header for both model discovery and generation requests.
      const query = new URLSearchParams({ pageSize: "1000" });
      if (pageToken) query.set("pageToken", pageToken);
      const response = await requestJson<unknown>(
        `${API_ROOT}/models?${query}`,
        { method: "GET", headers: { "x-goog-api-key": credentials.apiKey } },
        { fetchImpl: this.fetchImpl, secrets: [credentials.apiKey] },
      );
      models.push(...normalizeGeminiModels(response.body));
      const root = record(response.body);
      pageToken = typeof root?.nextPageToken === "string" ? root.nextPageToken : undefined;
      if (!pageToken) break;
    }
    return models;
  }

  async complete(credentials: ProviderCredentials, input: NormalizedCompletionRequest): Promise<NormalizedCompletion> {
    if (!credentials.apiKey) throw new ProviderRequestError("Gemini API key is required.", "invalid-configuration");
    const url = `${API_ROOT}/models/${encodeURIComponent(input.model)}:generateContent`;
    const response = await requestJson<unknown>(
      url,
      { method: "POST", headers: { "content-type": "application/json", "x-goog-api-key": credentials.apiKey }, body: JSON.stringify(apiBody(input)) },
      { fetchImpl: this.fetchImpl, secrets: [credentials.apiKey] },
    );
    const root = record(response.body);
    const parts = partsOf(root);
    return {
      text: textOf(parts),
      model: typeof root?.modelVersion === "string" ? root.modelVersion : input.model,
      toolCalls: toolCallsOf(parts),
      usage: usageOf(root),
      requestId: response.headers.get("x-request-id") ?? undefined,
    };
  }

  async *stream(credentials: ProviderCredentials, input: NormalizedCompletionRequest): AsyncIterable<NormalizedStreamEvent> {
    if (!credentials.apiKey) throw new ProviderRequestError("Gemini API key is required.", "invalid-configuration");
    const url = `${API_ROOT}/models/${encodeURIComponent(input.model)}:streamGenerateContent?alt=sse`;
    const response = await providerFetch(
      url,
      { method: "POST", headers: { "content-type": "application/json", accept: "text/event-stream", "x-goog-api-key": credentials.apiKey }, body: JSON.stringify(apiBody(input)) },
      { fetchImpl: this.fetchImpl, secrets: [credentials.apiKey] },
    );
    if (!response.ok) await throwProviderResponse(response, [credentials.apiKey]);
    let finalModel: string | undefined;
    for await (const frame of decodeSse(response)) {
      let root: UnknownRecord | null;
      try {
        root = record(JSON.parse(frame) as unknown);
      } catch {
        throw new ProviderRequestError("Gemini returned a malformed streaming event.", "provider-outage");
      }
      if (!root) continue;
      if (typeof root.modelVersion === "string") finalModel = root.modelVersion;
      const parts = partsOf(root);
      const text = textOf(parts);
      if (text) yield { type: "text-delta", text };
      for (const call of toolCallsOf(parts)) {
        yield { type: "tool-call-delta", index: 0, id: call.id, name: call.name, arguments: call.arguments };
      }
      const usage = usageOf(root);
      if (Object.values(usage).some((value) => value != null)) yield { type: "usage", usage };
    }
    yield { type: "done", model: finalModel };
  }
}
