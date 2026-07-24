import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { AccountManager } from "../accounts/accountManager.js";
import type { Db } from "../db/db.js";
import { config } from "../config.js";

// The pickable-model lists power the Settings model dropdowns. We fetch them LIVE from each provider's
// models endpoint so a newly-granted model (e.g. Fable 5) shows up on its own, and cache the result in
// kv so it survives a restart and is available even when no token is momentarily reachable. The lists
// the UI ultimately sees are the live set unioned with a curated fallback and whatever is currently
// selected — so a picked model never vanishes from its own dropdown, and a fresh install still has
// sensible options before the first fetch lands.

const CLAUDE_MODELS_KEY = "cache_claude_models";
const CODEX_MODELS_KEY = "cache_codex_models";
const GROK_MODELS_KEY = "cache_grok_models";
const REFRESH_MS = 6 * 60 * 60 * 1000; // 6h — model access changes rarely; a boot fetch covers new grants.
const FETCH_TIMEOUT_MS = 12_000;

/** Curated Claude fallback (most-capable first) for a fresh install or an unreachable models endpoint. */
export const CURATED_CLAUDE_MODELS = [
  "claude-fable-5",
  "claude-opus-4-8",
  "claude-opus-4-7",
  "claude-opus-4-6",
  "claude-sonnet-4-6",
  "claude-haiku-4-5-20251001",
];

/** Curated Codex fallback — the flagship coding models, mirroring config.codex.models. */
export const CURATED_CODEX_MODELS = [...config.codex.models];

/** Curated Grok fallback, mirroring config.grok.models. */
export const CURATED_GROK_MODELS = [...config.grok.models];

/** Curated z.ai (GLM) fallback, mirroring config.zai.models. z.ai has no live models endpoint we fetch —
 *  the plan's GLM ids are a fixed known set, so this curated list (∪ the selected model) is the picker. */
export const CURATED_ZAI_MODELS = [...config.zai.models];

/** Dedup preserving first-seen order, dropping blanks. */
export function uniq(ids: (string | undefined | null)[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of ids) {
    const id = raw?.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

/** List the Claude models the given subscription token can access, via the OAuth-authed models endpoint
 *  (setup-tokens are accepted there with the oauth beta header, same as the usage ping). */
export async function fetchClaudeModels(token: string): Promise<string[]> {
  const res = await fetch("https://api.anthropic.com/v1/models?limit=100", {
    headers: {
      Authorization: `Bearer ${token}`,
      "anthropic-beta": "oauth-2025-04-20",
      "anthropic-version": "2023-06-01",
      "user-agent": "claude-cli/2.0.0",
    },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`anthropic /v1/models HTTP ${res.status}`);
  const body = (await res.json()) as { data?: { id?: string }[] };
  // Keep the endpoint's ordering (roughly newest/most-capable first) but drop any non-`claude-` id so a
  // stray family can't land in every role dropdown. The union with CURATED_CLAUDE_MODELS keeps flagships up top.
  return uniq((body.data ?? []).map((m) => m.id).filter((id) => id?.startsWith("claude-")));
}

// OpenAI's /v1/models is polluted with embeddings/tts/whisper/image/moderation entries — keep only the
// families a Codex implementor could actually run, so the dropdown stays about coding models.
const CODEX_MODEL_INCLUDE = /^(gpt-5|gpt-4\.|codex|o[0-9])/i;
const CODEX_MODEL_EXCLUDE = /(audio|realtime|transcribe|tts|image|embedding|moderation|search|vision|instruct)/i;

/** List the OpenAI models the key can access, filtered to plausible Codex coding models. */
export async function fetchOpenAiModels(key: string): Promise<string[]> {
  const res = await fetch("https://api.openai.com/v1/models", {
    headers: { authorization: `Bearer ${key}` },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`openai /v1/models HTTP ${res.status}`);
  const body = (await res.json()) as { data?: { id?: string }[] };
  const ids = (body.data ?? [])
    .map((m) => m.id?.trim())
    .filter((id): id is string => !!id && CODEX_MODEL_INCLUDE.test(id) && !CODEX_MODEL_EXCLUDE.test(id))
    .sort();
  return uniq(ids);
}

/** List the Grok models the CLI has cached for this login. The `grok` CLI writes ~/.grok/models_cache.json
 *  (a free, local file refreshed after each session) with a `models` map keyed by model id — read it
 *  directly rather than spawning the CLI. Returns the non-hidden ids, or an empty list when absent/corrupt. */
export function readGrokModelsFile(): string[] {
  const file = join(config.grok.home, "models_cache.json");
  if (!existsSync(file)) return [];
  try {
    const body = JSON.parse(readFileSync(file, "utf8")) as { models?: Record<string, { info?: { hidden?: boolean } }> };
    const models = body.models ?? {};
    return uniq(Object.entries(models).filter(([, v]) => !v?.info?.hidden).map(([id]) => id));
  } catch {
    return [];
  }
}

/**
 * Owns the live model lists shown in the Settings dropdowns. Reads/writes the cached lists in kv,
 * refreshes them from the providers on boot and on a slow timer, and fires `onChange` (a settings
 * rebroadcast) only when a list actually changes so the WS isn't spammed.
 */
export class ModelCatalog {
  private timer: NodeJS.Timeout | undefined;

  constructor(
    private readonly db: Db,
    private readonly accounts: AccountManager,
    private readonly getOpenAiKey: () => string | undefined,
    private readonly onChange: () => void,
  ) {}

  start(): void {
    void this.refresh();
    this.timer = setInterval(() => void this.refresh(), REFRESH_MS);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /** Cached live Claude model ids (empty until the first successful fetch). */
  claudeModels(): string[] {
    return this.readCache(CLAUDE_MODELS_KEY);
  }

  /** Cached live Codex model ids (empty until the first successful fetch). */
  codexModels(): string[] {
    return this.readCache(CODEX_MODELS_KEY);
  }

  /** Cached live Grok model ids (empty until the first refresh reads the CLI's models cache). */
  grokModels(): string[] {
    return this.readCache(GROK_MODELS_KEY);
  }

  private readCache(key: string): string[] {
    const raw = this.db.kvGet(key);
    if (!raw) return [];
    try {
      const v = JSON.parse(raw) as unknown;
      return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
    } catch {
      return [];
    }
  }

  private storeIfChanged(key: string, ids: string[]): boolean {
    const next = JSON.stringify(ids);
    if (this.db.kvGet(key) === next) return false;
    this.db.kvSet(key, next);
    return true;
  }

  async refresh(): Promise<void> {
    let changed = false;

    const token = this.accounts.firstUsableToken();
    if (token) {
      try {
        const models = await fetchClaudeModels(token);
        if (models.length && this.storeIfChanged(CLAUDE_MODELS_KEY, models)) changed = true;
      } catch {
        // Transient — keep the last-known cached list rather than blanking the dropdown.
      }
    }

    const key = this.getOpenAiKey();
    if (key) {
      try {
        const models = await fetchOpenAiModels(key);
        if (models.length && this.storeIfChanged(CODEX_MODELS_KEY, models)) changed = true;
      } catch {
        // Transient — keep the last-known cached Codex list.
      }
    }

    // Grok models come from the CLI's own local cache file (no network / no auth needed); keep whatever
    // was last cached if the file is momentarily unreadable.
    const grokModels = readGrokModelsFile();
    if (grokModels.length && this.storeIfChanged(GROK_MODELS_KEY, grokModels)) changed = true;

    if (changed) this.onChange();
  }
}
