// Free-provider connection lab: pure model/stream/quota tests plus stubbed Fastify + provider flows.
// No credentials, network calls, or model requests are used.
// Run: npm run test:free-providers --prefix server

import assert from "node:assert/strict";
import Fastify from "fastify";
import { CohereAdapter, normalizeCohereModels } from "../freeProviders/cohereAdapter.js";
import { GeminiAdapter, normalizeGeminiModels } from "../freeProviders/geminiAdapter.js";
import { parseRateLimitHeaders, parseResetAt, redactProviderText, requestJson, SseDecoder } from "../freeProviders/http.js";
import { credentialFingerprint, quotaWindowId, UsageLedger, type KvStore } from "../freeProviders/ledger.js";
import { OpenAiCompatibleAdapter } from "../freeProviders/openAiAdapter.js";
import {
  createProviderRegistry,
  normalizeCloudflareModels,
  normalizeHuggingFaceModels,
  normalizeKiloModels,
  normalizeNvidiaModels,
} from "../freeProviders/registry.js";
import { registerFreeProviderRoutes } from "../freeProviders/routes.js";
import { chooseFreeModel, FreeProviderService, stateForProviderError } from "../freeProviders/service.js";
import { ProviderRequestError, type ProviderUsageSnapshot } from "../freeProviders/types.js";
import { formatUsageChip } from "../freeProviders/usageChip.js";

class MemoryStore implements KvStore {
  readonly values = new Map<string, string>();
  kvGet(key: string): string | null { return this.values.get(key) ?? null; }
  kvSet(key: string, value: string): void { this.values.set(key, value); }
}

function mockFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => handler(String(input), init)) as typeof fetch;
}

function json(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json", ...(init.headers ?? {}) }, ...init });
}

function usage(overrides: Partial<ProviderUsageSnapshot> = {}): ProviderUsageSnapshot {
  return {
    providerId: "groq",
    quotaKind: "requests",
    source: "unknown",
    lastUpdatedAt: "2026-08-26T12:00:00.000Z",
    estimated: false,
    ...overrides,
  };
}

// Registry/capability boundary: all requested recurring providers exist, and none is silently task-routable.
const registry = createProviderRegistry(mockFetch(() => { throw new Error("network must not run during registration"); }));
assert.deepEqual(registry.map((provider) => provider.id), ["gemini", "groq", "kilo", "mistral", "cohere", "cloudflare", "nvidia", "huggingface"]);
assert.ok(registry.every((provider) =>
  typeof provider.adapter.listModels === "function" &&
  typeof provider.adapter.complete === "function" &&
  typeof provider.adapter.stream === "function"));

// Dynamic gateway pricing is fail-closed: a free-looking suffix is insufficient unless live input/output are exactly zero.
const kiloModels = normalizeKiloModels({ data: [
  { id: "dynamic/free:free", pricing: { input: 0, output: 0 } },
  { id: "dynamic/paid:free", pricing: { input: 0, output: 0.2 } },
] });
assert.equal(kiloModels[0]?.isFree, true);
assert.equal(kiloModels.find((model) => model.id === "dynamic/paid:free")?.isFree, false);
assert.equal(kiloModels.find((model) => model.id === "kilo-auto/free")?.isFree, true);

const cloudflareModels = normalizeCloudflareModels({ result: [
  { id: "51b71d5b-8bc0-4489-a107-95e542b69914", name: "@cf/qwen/qwen2.5-coder-32b-instruct", task: { name: "Text Generation" } },
  { name: "@cf/moonshotai/kimi-k2.6", task: { name: "Text Generation" } },
  { name: "@cf/unverified/new-model", task: { name: "Text Generation" } },
] });
assert.equal(cloudflareModels[0]?.id, "@cf/qwen/qwen2.5-coder-32b-instruct", "the callable Cloudflare model name wins over its opaque catalog UUID");
assert.equal(cloudflareModels[0]?.isFree, true);
assert.equal(cloudflareModels[0]?.unitsPerMillionInput, 60_000);
assert.equal(cloudflareModels[1]?.isFree, false, "documented paid-only Workers AI model must be blocked");
assert.equal(cloudflareModels[2]?.isFree, false, "unknown neuron pricing must fail closed");

const nvidiaModels = normalizeNvidiaModels({ data: [
  { id: "qwen/qwen3-coder-480b-a35b-instruct", context_length: 262_144, capabilities: { tools: true } },
  { id: "nvidia/nv-embedqa-e5-v5" },
] });
assert.deepEqual(nvidiaModels.map((model) => model.id), ["qwen/qwen3-coder-480b-a35b-instruct"]);
assert.equal(nvidiaModels[0]?.supportsTools, true);

const huggingFaceModels = normalizeHuggingFaceModels({ data: [
  {
    id: "Qwen/Qwen3-Coder-480B-A35B-Instruct",
    architecture: { input_modalities: ["text"] },
    providers: [
      { provider: "novita", status: "live", context_length: 262_144, supports_tools: true, pricing: { input: 0.3, output: 1.2 } },
      { provider: "offline", status: "staging", pricing: { input: 0, output: 0 } },
      { provider: "unpriced", status: "live" },
    ],
  },
] });
assert.deepEqual(huggingFaceModels.map((model) => model.id), ["Qwen/Qwen3-Coder-480B-A35B-Instruct:novita"]);
assert.equal(huggingFaceModels[0]?.inputPricePerMillion, 0.3);
assert.equal(huggingFaceModels[0]?.supportsTools, true);
const geminiModels = normalizeGeminiModels({ models: [
  { name: "models/gemini-3.5-flash", baseModelId: "gemini-3.5-flash", displayName: "Gemini Flash", supportedGenerationMethods: ["generateContent", "streamGenerateContent"], inputTokenLimit: 1_000_000 },
  { name: "models/gemini-pro-paid", supportedGenerationMethods: ["generateContent"] },
  { name: "models/text-embedding", supportedGenerationMethods: ["embedContent"] },
] });
assert.equal(geminiModels.length, 2);
assert.equal(geminiModels[0]?.isFree, true);
assert.equal(geminiModels[1]?.isFree, false);

const cohereModels = normalizeCohereModels({ models: [
  { name: "north-mini-code", endpoints: ["chat"], context_length: 128_000, features: ["tools"] },
  { name: "embed-v4", endpoints: ["embed"] },
] });
assert.deepEqual(cohereModels.map((model) => model.id), ["north-mini-code"]);
assert.equal(cohereModels[0]?.supportsTools, true);

// The selected model is respected only while eligible; otherwise selection falls to a verified preference.
const kiloDefinition = registry.find((provider) => provider.id === "kilo")!;
assert.equal(chooseFreeModel(kiloDefinition, kiloModels, "dynamic/paid:free")?.id, "kilo-auto/free");

// OpenAI-compatible completion + tool + exact header normalization.
const compatibleFetch = mockFetch((url) => {
  if (url.endsWith("/models")) return json({ data: [] });
  return json({
    id: "req_123",
    model: "served/model",
    provider: "upstream-a",
    choices: [{ message: { content: [{ type: "text", text: "READY" }], tool_calls: [{ id: "tool_1", function: { name: "read_file", arguments: "{\"path\":\"a.ts\"}" } }] } }],
    usage: { prompt_tokens: 9, completion_tokens: 2, total_tokens: 11, cost: 0 },
  }, { headers: {
    "x-ratelimit-limit-requests": "1000",
    "x-ratelimit-remaining-requests": "812",
    "x-ratelimit-reset-requests": "2m59.56s",
    "x-ratelimit-limit-tokens": "200000",
    "x-ratelimit-remaining-tokens": "146000",
    "x-ratelimit-reset-tokens": "1.5s",
  } });
});
const compatible = new OpenAiCompatibleAdapter({
  providerId: "groq",
  modelsUrl: () => "https://stub/models",
  completionUrl: () => "https://stub/chat",
  headers: (credentials) => ({ authorization: `Bearer ${credentials.apiKey}` }),
  normalizeModels: () => [],
  fetchImpl: compatibleFetch,
});
const completion = await compatible.complete({ apiKey: "gsk_top_secret" }, { model: "requested/model", messages: [{ role: "user", content: "hi" }] });
assert.equal(completion.text, "READY");
assert.equal(completion.model, "served/model");
assert.equal(completion.upstreamProvider, "upstream-a");
assert.deepEqual(completion.toolCalls[0], { id: "tool_1", name: "read_file", arguments: "{\"path\":\"a.ts\"}" });
assert.deepEqual(completion.usage, { inputTokens: 9, outputTokens: 2, totalTokens: 11, costUsd: 0 });
assert.equal(completion.rateLimit?.requests?.remaining, 812);
assert.equal(completion.rateLimit?.tokens?.remaining, 146_000);
assert.equal(completion.rateLimit?.tokens?.window, "minute", "Groq token headers are TPM, not tokens/day");

// Incremental SSE handles CRLF, chunk boundaries, text, tools, final usage, and malformed frames.
const sseDecoder = new SseDecoder();
assert.deepEqual(sseDecoder.push("event: ping\r\ndata: {\"a\":"), []);
assert.deepEqual(sseDecoder.push("1}\r\n\r\n"), ["{\"a\":1}"]);
const splitCrLf = new SseDecoder();
assert.deepEqual(splitCrLf.push("data: one\r"), []);
assert.deepEqual(splitCrLf.push("\n\r"), []);
assert.deepEqual(splitCrLf.push("\n"), ["one"], "CRLF frame separators can span arbitrary network chunks");
const streamPayload = [
  "data: {\"model\":\"served/stream\",\"choices\":[{\"delta\":{\"content\":\"RE\"}}]}\n\n",
  "data: {\"choices\":[{\"delta\":{\"content\":\"ADY\",\"tool_calls\":[{\"index\":0,\"id\":\"c1\",\"function\":{\"name\":\"lookup\",\"arguments\":\"{}\"}}]}}],\"usage\":{\"prompt_tokens\":3,\"completion_tokens\":2}}\n\n",
  "data: [DONE]\n\n",
];
const streamAdapter = new OpenAiCompatibleAdapter({
  providerId: "groq",
  modelsUrl: () => "https://stub/models",
  completionUrl: () => "https://stub/stream",
  headers: () => ({}),
  normalizeModels: () => [],
  fetchImpl: mockFetch(() => new Response(new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder();
      for (const chunk of streamPayload) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  }), { status: 200, headers: { "content-type": "text/event-stream" } })),
});
const events = [];
for await (const event of streamAdapter.stream({}, { model: "m", messages: [{ role: "user", content: "hi" }] })) events.push(event);
assert.deepEqual(events.map((event) => event.type), ["text-delta", "text-delta", "tool-call-delta", "usage", "done"]);
assert.equal(events.find((event) => event.type === "tool-call-delta")?.name, "lookup");

const cohereStream = new CohereAdapter(mockFetch(() => new Response([
  "data: {\"type\":\"content-delta\",\"index\":0,\"delta\":{\"message\":{\"content\":{\"text\":\"READY\"}}}}\n\n",
  "data: {\"type\":\"tool-call-start\",\"index\":1,\"delta\":{\"message\":{\"tool_calls\":{\"id\":\"c2\",\"function\":{\"name\":\"inspect\",\"arguments\":\"\"}}}}}\n\n",
  "data: {\"type\":\"message-end\",\"delta\":{\"usage\":{\"billed_units\":{\"input_tokens\":4,\"output_tokens\":2}}}}\n\n",
].join(""), { status: 200, headers: { "content-type": "text/event-stream" } })));
const cohereEvents = [];
for await (const event of cohereStream.stream({ apiKey: "cohere-secret-value" }, { model: "command-a", messages: [{ role: "user", content: "hi" }] })) cohereEvents.push(event);
assert.equal(cohereEvents.find((event) => event.type === "text-delta")?.text, "READY");
assert.equal(cohereEvents.find((event) => event.type === "tool-call-delta")?.index, 1);
assert.equal(cohereEvents.find((event) => event.type === "usage")?.usage.totalTokens, 6);

// Native Gemini and Cohere adapters normalize their documented response formats.
const gemini = new GeminiAdapter(mockFetch((url) => {
  assert.ok(url.includes(encodeURIComponent("gemini-3.5-flash")));
  return json({
    modelVersion: "gemini-3.5-flash-001",
    candidates: [{ content: { parts: [{ text: "READY" }, { functionCall: { name: "inspect", args: { path: "a.ts" } } }] } }],
    usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 1, totalTokenCount: 6 },
  });
}));
const geminiCompletion = await gemini.complete({ apiKey: "AIza-secret-value" }, { model: "gemini-3.5-flash", messages: [{ role: "user", content: "hi" }] });
assert.equal(geminiCompletion.text, "READY");
assert.equal(geminiCompletion.toolCalls[0]?.name, "inspect");
assert.equal(geminiCompletion.usage.totalTokens, 6);

const geminiStream = new GeminiAdapter(mockFetch(() => new Response([
  "data: {\"modelVersion\":\"gemini-3.5-flash-001\",\"candidates\":[{\"content\":{\"parts\":[{\"text\":\"RE\"}]}}]}\n\n",
  "data: {\"candidates\":[{\"content\":{\"parts\":[{\"text\":\"ADY\"},{\"functionCall\":{\"name\":\"inspect\",\"args\":{\"path\":\"a.ts\"}}}]}}],\"usageMetadata\":{\"promptTokenCount\":5,\"candidatesTokenCount\":2}}\n\n",
].join(""), { status: 200, headers: { "content-type": "text/event-stream" } })));
const geminiEvents = [];
for await (const event of geminiStream.stream({ apiKey: "AIza-secret-value" }, { model: "gemini-3.5-flash", messages: [{ role: "user", content: "hi" }] })) geminiEvents.push(event);
assert.deepEqual(geminiEvents.filter((event) => event.type === "text-delta").map((event) => event.text).join(""), "READY");
assert.equal(geminiEvents.find((event) => event.type === "tool-call-delta")?.name, "inspect");
assert.equal(geminiEvents.find((event) => event.type === "usage")?.usage.totalTokens, 7);

const cohere = new CohereAdapter(mockFetch(() => json({
  id: "cohere_req",
  model: "north-mini-code",
  message: { content: [{ type: "text", text: "READY" }], tool_calls: [{ id: "c1", function: { name: "inspect", arguments: "{}" } }] },
  usage: { billed_units: { input_tokens: 7, output_tokens: 2 } },
})));
const cohereCompletion = await cohere.complete({ apiKey: "cohere-secret-value" }, { model: "north-mini-code", messages: [{ role: "user", content: "hi" }] });
assert.equal(cohereCompletion.text, "READY");
assert.equal(cohereCompletion.toolCalls[0]?.name, "inspect");
assert.equal(cohereCompletion.usage.totalTokens, 9);

// HTTP failure classes and Retry-After are normalized without echoing credentials.
const now = Date.parse("2026-08-26T12:00:00.000Z");
assert.equal(parseResetAt("2m59.56s", now), "2026-08-26T12:02:59.560Z");
assert.equal(parseResetAt("60", now), "2026-08-26T12:01:00.000Z");
const rate = parseRateLimitHeaders(new Headers({ "retry-after": "30", "x-ratelimit-limit": "200", "x-ratelimit-remaining": "0" }), now);
assert.equal(rate?.retryAt, "2026-08-26T12:00:30.000Z");
assert.equal(rate?.requests?.remaining, 0);
for (const [status, kind] of [[401, "authentication"], [402, "billing"], [429, "rate-limit"], [503, "provider-outage"]] as const) {
  await assert.rejects(
    requestJson("https://stub/error", {}, {
      fetchImpl: mockFetch(() => json({ error: { message: `failure for gsk_super_secret_123456789` } }, { status, headers: status === 429 ? { "retry-after": "12" } : {} })),
      secrets: ["gsk_super_secret_123456789"],
    }),
    (error: unknown) => error instanceof ProviderRequestError && error.kind === kind && !error.message.includes("super_secret"),
  );
}
assert.equal(redactProviderText("Authorization: Bearer abcdefghijklmno?key=AIzaSECRET", ["AIzaSECRET"]).includes("AIzaSECRET"), false);
assert.equal(stateForProviderError(new ProviderRequestError("x", "rate-limit")), "rate-limited");

// Ledger windows survive restarts, reset correctly, and never merge rotated credentials.
const ledgerStore = new MemoryStore();
const ledger = new UsageLedger(ledgerStore);
const fpA = credentialFingerprint("key-a", "salt");
const fpB = credentialFingerprint("key-b", "salt");
assert.notEqual(fpA, fpB);
const beforeMidnight = Date.parse("2026-08-26T23:59:00.000Z");
ledger.record({ providerId: "cloudflare", accountFingerprint: fpA, modelId: "m", timestamp: beforeMidnight, inputTokens: 10, estimatedUnits: 500, responseStatus: "ok", freeClass: "RECURRING_DAILY", window: "day" });
ledger.record({ providerId: "cloudflare", accountFingerprint: fpB, modelId: "m", timestamp: beforeMidnight, estimatedUnits: 900, responseStatus: "ok", freeClass: "RECURRING_DAILY", window: "day" });
assert.equal(ledger.aggregate({ providerId: "cloudflare", accountFingerprint: fpA, window: "day", now: beforeMidnight }).estimatedUnits, 500);
assert.equal(ledger.aggregate({ providerId: "cloudflare", accountFingerprint: fpB, window: "day", now: beforeMidnight }).estimatedUnits, 900);
assert.equal(ledger.aggregate({ providerId: "cloudflare", accountFingerprint: fpA, window: "day", now: beforeMidnight + 120_000 }).requests, 0, "UTC daily reset drops the prior window");
assert.notEqual(quotaWindowId("month", Date.parse("2026-08-31T23:59:00Z")), quotaWindowId("month", Date.parse("2026-09-01T00:01:00Z")));
ledger.record({ providerId: "kilo", accountFingerprint: fpA, modelId: "m", timestamp: now - 59 * 60_000, responseStatus: "ok", freeClass: "RECURRING_HOURLY", window: "rolling" });
assert.equal(ledger.aggregate({ providerId: "kilo", accountFingerprint: fpA, window: "rolling", now }).requests, 1);
assert.equal(ledger.aggregate({ providerId: "kilo", accountFingerprint: fpA, window: "rolling", now: now + 2 * 60_000 }).requests, 0);

// Mandatory usage-chip states: exact, estimated, mixed, unknown, stale, exhausted, rate limited, unauthenticated.
assert.equal(formatUsageChip({ usage: usage({ remaining: 812, limit: 1_000, unit: "requests/day" }), state: "ready", configured: true, optionalCredential: false }), "812 / 1K requests/day left");
assert.equal(formatUsageChip({ usage: usage({ remaining: 137, limit: 200, unit: "free requests", estimated: true }), state: "ready", configured: true, optionalCredential: true }), "~137 / 200 free requests left");
assert.match(formatUsageChip({ usage: usage({ quotaKind: "mixed", remaining: 10, limit: 20, unit: "requests" }), state: "ready", configured: true, optionalCredential: false }), /10 \/ 20/);
assert.equal(formatUsageChip({ usage: usage(), state: "ready", configured: true, optionalCredential: false }), "Quota · not exposed");
assert.equal(formatUsageChip({ usage: usage({ stale: true }), state: "ready", configured: true, optionalCredential: false }), "Quota signal stale");
assert.equal(formatUsageChip({ usage: usage({ remaining: 0, limit: 1_000 }), state: "quota-exhausted", configured: true, optionalCredential: false }), "Quota exhausted · 0 left");
assert.equal(formatUsageChip({ usage: usage(), state: "rate-limited", configured: true, optionalCredential: false }), "Rate limited · retry later");
assert.equal(formatUsageChip({ usage: usage(), state: "awaiting-auth", configured: false, optionalCredential: false }), "Quota · awaiting auth");
assert.equal(formatUsageChip({ usage: usage({ quotaKind: "prototype" }), state: "ready", configured: true, optionalCredential: false }), "Free prototype · cap not exposed");

// End-to-end service flow with a stub Kilo gateway: key stays write-only, catalog validation is non-inference,
// the explicit probe rechecks pricing, records one call, and preserves actual upstream identity.
let chatCalls = 0;
let catalogModelPaid = false;
const sentModels: string[] = [];
const serviceFetch = mockFetch((url, init) => {
  if (url === "https://api.kilo.ai/api/gateway/models") {
    return json({ data: [{ id: "vendor/coder:free", name: "Coder Free", pricing: { prompt: "0", completion: catalogModelPaid ? "0.000001" : "0", request: "0" }, supported_parameters: ["tools"] }] });
  }
  if (url === "https://api.kilo.ai/api/gateway/chat/completions") {
    chatCalls += 1;
    sentModels.push((JSON.parse(String(init?.body)) as { model: string }).model);
    return json({ model: "vendor/coder:free", provider: "ExampleCloud", choices: [{ message: { content: "READY" } }], usage: { prompt_tokens: 8, completion_tokens: 1 } });
  }
  throw new Error(`unexpected URL ${url}`);
});
const serviceStore = new MemoryStore();
const service = new FreeProviderService(serviceStore, {}, serviceFetch);
const saved = service.update("kilo", { enabled: true, apiKey: "kilo-secret-key-value" });
assert.equal(saved.keyPresent, true);
assert.equal(saved.keyLast4, "alue");
assert.equal(JSON.stringify(saved).includes("secret-key"), false);
const validated = await service.refresh("kilo");
assert.equal(chatCalls, 0, "model validation must not consume inference quota");
assert.equal(validated.health.state, "ready");
assert.equal(validated.selectedModel, "kilo-auto/free", "preferred official free router wins safely");
const probed = await service.probe("kilo");
assert.equal(chatCalls, 1);
assert.equal(probed.response.upstreamProvider, "ExampleCloud");
assert.equal(probed.provider.usage.remaining, 199);
assert.match(probed.provider.usage.displayLabel ?? "", /^~199 \/ 200/);
assert.equal(JSON.stringify(probed).includes("kilo-secret"), false);
service.update("kilo", { selectedModel: "vendor/coder:free" });
catalogModelPaid = true;
await service.probe("kilo");
assert.equal(chatCalls, 2);
assert.equal(sentModels[1], "kilo-auto/free", "a selected model whose refreshed price became non-zero must never be sent");

// Auth gate + JSON route contract; a saved secret never comes back over REST.
const app = Fastify({ logger: false });
registerFreeProviderRoutes(app, service, (cookie) => cookie === "session=yes");
assert.equal((await app.inject({ method: "GET", url: "/api/free-providers" })).statusCode, 401);
const listResponse = await app.inject({ method: "GET", url: "/api/free-providers", headers: { cookie: "session=yes" } });
assert.equal(listResponse.statusCode, 200);
assert.equal(listResponse.body.includes("kilo-secret"), false);
const unknown = await app.inject({ method: "POST", url: "/api/free-providers/not-real/refresh", headers: { cookie: "session=yes" } });
assert.equal(unknown.statusCode, 400);
await app.close();

console.log("All free-provider connection lab checks passed.");
