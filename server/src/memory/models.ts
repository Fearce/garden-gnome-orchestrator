import type { RateLimitInfo } from "../types.js";
import type { UsageRecord } from "./indexStore.js";
import type { LunaRequest, LunaResult } from "./workerProtocol.js";

// The two inexpensive models that do memory's language work, both reached through subscriptions GGO
// already holds: Claude Haiku over the Claude subscription's OAuth token, and Codex Luna through the
// installed Codex CLI on the ChatGPT plan. Neither offers an embeddings endpoint on those plans (checked
// 2026-10-04: Anthropic has none, OpenAI's requires a paid API key), so memory uses them as readers that
// judge relevance and write retrieval cards, never as an embedding source.

export const HAIKU_MODEL = "claude-haiku-4-5-20251001";

export type MemoryLane = "interactive" | "background";

export interface ModelCall {
  system: string;
  user: string;
  maxTokens: number;
  /** What the tokens were spent on, for the usage ledger (`recall`, `search`, `cards`, `extract`). */
  purpose: string;
  lane: MemoryLane;
  /** Overall budget; a Luna fallback is attempted only when this much time is still left. */
  timeoutMs: number;
  /** Rejects an answer that is unusable (e.g. not JSON) so the next provider is tried. */
  accept?: (text: string) => boolean;
}

export interface ModelAnswer {
  text: string;
  provider: "claude" | "codex";
  model: string;
  inputTokens: number;
  outputTokens: number;
}

/** Why no answer came back: the lane was full, no subscription had room, or a model answered but not in
 *  the requested shape (retrying the same input is unlikely to help). */
export interface ModelFailure {
  failure: "busy" | "no-capacity" | "unusable";
}

export interface ProviderState {
  available: boolean;
  /** Why not, when unavailable; the model id when it is. */
  detail: string;
  lastOkAt: number | null;
  lastError: string | null;
}

export interface MemoryModelDeps {
  /** The next Claude subscription with room for a Haiku call, skipping `excluded`. */
  claudeAccount: (excluded: readonly string[]) => { id: string; token: string } | undefined;
  /** Whether any Claude subscription has room, with no side effect on account state. */
  claudeHasRoom: () => boolean;
  onClaudeRateLimit: (accountId: string, info: RateLimitInfo) => void;
  /** A ready-to-spawn Luna invocation, or the reason Luna cannot run right now. */
  lunaLaunch: () => Promise<{ launch: Omit<LunaRequest, "prompt" | "timeoutMs">; model: string } | { unavailable: string }>;
  runLuna: (request: LunaRequest) => Promise<LunaResult | null>;
  recordUsage: (record: UsageRecord) => void;
  fetchImpl?: typeof fetch;
}

const LANE_LIMIT: Record<MemoryLane, number> = { interactive: 4, background: 1 };
/** Luna costs a CLI process and ~12k prompt tokens a call, so it never runs more than one at a time. */
const LUNA_LIMIT = 1;
const LUNA_MIN_BUDGET_MS = 8_000;

export class MemoryModels {
  private readonly inFlight: Record<MemoryLane, number> = { interactive: 0, background: 0 };
  private lunaInFlight = 0;
  private readonly haikuState: ProviderState = { available: true, detail: HAIKU_MODEL, lastOkAt: null, lastError: null };
  private readonly lunaState: ProviderState = { available: false, detail: "not checked yet", lastOkAt: null, lastError: null };

  constructor(private readonly deps: MemoryModelDeps) {}

  /** Haiku first, on every Claude subscription that has room; then Luna. A failure tells the caller
   *  whether to fall back (recall), wait for capacity (queued jobs) or give up on the input. */
  async complete(call: ModelCall): Promise<ModelAnswer | ModelFailure> {
    if (this.inFlight[call.lane] >= LANE_LIMIT[call.lane]) return { failure: "busy" };
    this.inFlight[call.lane]++;
    const deadline = Date.now() + call.timeoutMs;
    const seen = { unusable: false };
    try {
      const answer = (await this.viaHaiku(call, deadline, seen)) ?? (await this.viaLuna(call, deadline, seen));
      return answer ?? { failure: seen.unusable ? "unusable" : "no-capacity" };
    } finally {
      this.inFlight[call.lane]--;
    }
  }

  async providers(): Promise<{ haiku: ProviderState; luna: ProviderState }> {
    const room = this.deps.claudeHasRoom();
    this.haikuState.available = room;
    this.haikuState.detail = room ? HAIKU_MODEL : "no Claude subscription has room (disabled, capped or at the safety limit)";
    const luna = await this.deps.lunaLaunch().catch((err: unknown) => ({ unavailable: String(err) }));
    this.lunaState.available = !("unavailable" in luna);
    this.lunaState.detail = "unavailable" in luna ? luna.unavailable : luna.model;
    return { haiku: { ...this.haikuState }, luna: { ...this.lunaState } };
  }

  private async viaHaiku(call: ModelCall, deadline: number, seen: { unusable: boolean }): Promise<ModelAnswer | null> {
    const tried: string[] = [];
    for (let attempt = 0; attempt < 3; attempt++) {
      const remaining = deadline - Date.now();
      if (remaining < 1_000) return null;
      const account = this.deps.claudeAccount(tried);
      if (!account) {
        if (!tried.length) this.haikuState.lastError = "no Claude subscription has room";
        return null;
      }
      tried.push(account.id);
      const result = await this.haikuRequest(account, call, Math.min(remaining, 20_000));
      if (!result) continue;
      this.deps.recordUsage({ provider: "claude", model: HAIKU_MODEL, purpose: call.purpose, inputTokens: result.inputTokens, outputTokens: result.outputTokens, ok: true });
      if (call.accept && !call.accept(result.text)) {
        this.haikuState.lastError = "answer was not in the requested format";
        seen.unusable = true;
        continue;
      }
      this.haikuState.lastOkAt = Date.now();
      this.haikuState.lastError = null;
      return { text: result.text, provider: "claude", model: HAIKU_MODEL, inputTokens: result.inputTokens, outputTokens: result.outputTokens };
    }
    return null;
  }

  private async haikuRequest(account: { id: string; token: string }, call: ModelCall, timeoutMs: number): Promise<LunaResult | null> {
    const doFetch = this.deps.fetchImpl ?? fetch;
    let response: Response;
    try {
      response = await doFetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${account.token}`,
          "anthropic-beta": "oauth-2025-04-20",
          "anthropic-version": "2023-06-01",
          "content-type": "application/json",
          "user-agent": "claude-cli/2.0.0",
        },
        body: JSON.stringify({ model: HAIKU_MODEL, max_tokens: call.maxTokens, temperature: 0, system: call.system, messages: [{ role: "user", content: call.user }] }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      this.haikuState.lastError = err instanceof Error && err.name === "TimeoutError" ? "timed out" : "network error";
      this.deps.recordUsage({ provider: "claude", model: HAIKU_MODEL, purpose: call.purpose, inputTokens: 0, outputTokens: 0, ok: false });
      return null;
    }
    const limit = rateLimitInfo(response);
    if (limit) this.deps.onClaudeRateLimit(account.id, limit);
    if (!response.ok) {
      await response.text().catch(() => "");
      this.haikuState.lastError = `HTTP ${response.status}`;
      this.deps.recordUsage({ provider: "claude", model: HAIKU_MODEL, purpose: call.purpose, inputTokens: 0, outputTokens: 0, ok: false });
      return null;
    }
    try {
      const body = (await response.json()) as { content?: Array<{ type?: string; text?: string }>; usage?: { input_tokens?: number; output_tokens?: number } };
      const text = (body.content ?? []).filter((part) => part.type === "text").map((part) => part.text ?? "").join("\n");
      return { text, inputTokens: Number(body.usage?.input_tokens) || 0, outputTokens: Number(body.usage?.output_tokens) || 0 };
    } catch {
      this.haikuState.lastError = "unreadable response";
      return null;
    }
  }

  private async viaLuna(call: ModelCall, deadline: number, seen: { unusable: boolean }): Promise<ModelAnswer | null> {
    const remaining = deadline - Date.now();
    if (remaining < LUNA_MIN_BUDGET_MS || this.lunaInFlight >= LUNA_LIMIT) return null;
    const ready = await this.deps.lunaLaunch().catch((err: unknown) => ({ unavailable: String(err) }));
    if ("unavailable" in ready) {
      this.lunaState.available = false;
      this.lunaState.detail = ready.unavailable;
      return null;
    }
    this.lunaInFlight++;
    try {
      const prompt = `${call.system}\n\nAnswer with the requested output only. Do not run commands or read files.\n\n${call.user}`;
      const result = await this.deps.runLuna({ ...ready.launch, prompt, timeoutMs: deadline - Date.now() }).catch(() => null);
      this.deps.recordUsage({ provider: "codex", model: ready.model, purpose: call.purpose, inputTokens: result?.inputTokens ?? 0, outputTokens: result?.outputTokens ?? 0, ok: !!result });
      if (!result || (call.accept && !call.accept(result.text))) {
        this.lunaState.lastError = result ? "answer was not in the requested format" : "no answer (timeout, auth or CLI failure)";
        if (result) seen.unusable = true;
        return null;
      }
      this.lunaState.available = true;
      this.lunaState.detail = ready.model;
      this.lunaState.lastOkAt = Date.now();
      this.lunaState.lastError = null;
      return { text: result.text, provider: "codex", model: ready.model, inputTokens: result.inputTokens, outputTokens: result.outputTokens };
    } finally {
      this.lunaInFlight--;
    }
  }
}

/** A subscription-window rejection from the unified rate-limit headers, as the account manager's event
 *  fast path expects it. A bare 429 without a rejected window (a burst or overload limit) is not reported:
 *  flagging the whole account for it would stop task dispatch over one memory call. */
export function rateLimitInfo(response: Response): RateLimitInfo | null {
  const h = response.headers;
  const five = h.get("anthropic-ratelimit-unified-5h-status") === "rejected";
  const seven = h.get("anthropic-ratelimit-unified-7d-status") === "rejected";
  if (!five && !seven) return null;
  const rawReset = five ? h.get("anthropic-ratelimit-unified-5h-reset") : seven ? h.get("anthropic-ratelimit-unified-7d-reset") : null;
  const resetSeconds = rawReset == null ? Number.NaN : Number(rawReset);
  return {
    status: "rejected",
    ...(Number.isFinite(resetSeconds) ? { resetsAt: resetSeconds * 1000, resetSource: "provider" as const } : {}),
    rateLimitType: five ? ("five_hour" as const) : ("seven_day" as const),
  };
}

/** The first balanced JSON object in a model's answer (models wrap JSON in prose or code fences). */
export function parseJsonObject(text: string): Record<string, unknown> | null {
  const start = text.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const char = text[i]!;
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') quoted = false;
      continue;
    }
    if (char === '"') quoted = true;
    else if (char === "{") depth++;
    else if (char === "}" && --depth === 0) {
      try {
        const parsed = JSON.parse(text.slice(start, i + 1)) as unknown;
        return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
      } catch {
        return null;
      }
    }
  }
  return null;
}
