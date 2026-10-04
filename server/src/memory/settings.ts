import { DEFAULT_MEMORY_SETTINGS, type MemorySettings } from "./memory.js";

export interface KvStore {
  get(key: string): string | null | undefined;
  set(key: string, value: string): void;
}

const KEY = "memory_settings";
const FIELDS = Object.keys(DEFAULT_MEMORY_SETTINGS) as Array<keyof MemorySettings>;

/** The memory toggles, persisted as one JSON row in GGO's kv table. Unknown or malformed values fall
 *  back to the defaults field by field, so a newer field never reads as off on an older row. */
export class MemorySettingsStore {
  private cache: MemorySettings | null = null;

  constructor(private readonly kv: KvStore) {}

  get(): MemorySettings {
    if (this.cache) return this.cache;
    let stored: Record<string, unknown> = {};
    try {
      stored = JSON.parse(this.kv.get(KEY) ?? "{}") as Record<string, unknown>;
    } catch {
      stored = {};
    }
    const settings = { ...DEFAULT_MEMORY_SETTINGS };
    for (const field of FIELDS) if (typeof stored[field] === "boolean") settings[field] = stored[field] as boolean;
    this.cache = settings;
    return settings;
  }

  update(patch: Partial<MemorySettings>): MemorySettings {
    const next = { ...this.get() };
    for (const field of FIELDS) if (typeof patch[field] === "boolean") next[field] = patch[field] as boolean;
    this.kv.set(KEY, JSON.stringify(next));
    this.cache = next;
    return next;
  }
}
