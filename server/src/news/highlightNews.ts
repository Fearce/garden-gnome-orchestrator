import type { Db } from "../db/db.js";
import type { HighlightNewsItem } from "../types.js";

// The top bar's "highlighted news" chip. It is deliberately narrow — a newly released model is the only
// thing that lands here — because a chip that lights up for routine events stops being looked at.
//
// New models are found by diffing each provider's live roster against every id this instance has ever
// seen for it. The seen set only grows, so a model that drops out of one fetch (a flaky endpoint, a
// briefly hidden entry) is not announced again when it comes back. The FIRST roster for a provider seeds
// the set silently: a fresh install, or a provider switched on for the first time, has not "released"
// the thirty models it can suddenly see.

const ITEMS_KEY = "highlight_news";
const seenKey = (provider: HighlightNewsItem["provider"]): string => `highlight_news_seen_${provider}`;
// Undismissed items are bounded so a provider that renames its whole roster can't flood the chip.
const MAX_ITEMS = 12;

/** Which of `current` have never been seen, plus the grown seen set. `seen === null` means the provider
 *  has no history yet: seed it and announce nothing. */
export function newlySeenModels(seen: string[] | null, current: string[]): { fresh: string[]; seen: string[] } {
  const ids = [...new Set(current.map((id) => id.trim()).filter(Boolean))];
  if (seen === null) return { fresh: [], seen: ids };
  const known = new Set(seen);
  const fresh = ids.filter((id) => !known.has(id));
  return { fresh, seen: [...seen, ...fresh] };
}

export class HighlightNews {
  constructor(
    private readonly db: Db,
    private readonly publish: (items: HighlightNewsItem[]) => void,
    private readonly log: (message: string) => void = () => {},
  ) {}

  /** Undismissed items, newest first. */
  list(): HighlightNewsItem[] {
    const raw = this.db.kvGet(ITEMS_KEY);
    if (!raw) return [];
    try {
      const value = JSON.parse(raw) as unknown;
      return Array.isArray(value) ? value.filter(isItem) : [];
    } catch {
      return [];
    }
  }

  /** Record a provider's current roster; any id it has never shown before becomes a news item. */
  observeModels(provider: HighlightNewsItem["provider"], models: string[]): HighlightNewsItem[] {
    if (!models.length) return [];
    const { fresh, seen } = newlySeenModels(this.readSeen(provider), models);
    this.db.kvSet(seenKey(provider), JSON.stringify(seen));
    if (!fresh.length) return [];
    const at = Date.now();
    const added = fresh.map((model): HighlightNewsItem => ({ id: `model:${provider}:${model}`, kind: "model", provider, model, at }));
    const kept = this.list().filter((item) => !added.some((a) => a.id === item.id));
    this.write([...added, ...kept].slice(0, MAX_ITEMS));
    for (const item of added) this.log(`New ${provider === "claude" ? "Claude" : "Codex"} model available: ${item.model}`);
    return added;
  }

  dismiss(id: string): void {
    const items = this.list();
    const next = items.filter((item) => item.id !== id);
    if (next.length !== items.length) this.write(next);
  }

  dismissAll(): void {
    if (this.list().length) this.write([]);
  }

  private readSeen(provider: HighlightNewsItem["provider"]): string[] | null {
    const raw = this.db.kvGet(seenKey(provider));
    if (!raw) return null;
    try {
      const value = JSON.parse(raw) as unknown;
      return Array.isArray(value) ? value.filter((id): id is string => typeof id === "string") : null;
    } catch {
      return null;
    }
  }

  private write(items: HighlightNewsItem[]): void {
    this.db.kvSet(ITEMS_KEY, JSON.stringify(items));
    this.publish(items);
  }
}

function isItem(value: unknown): value is HighlightNewsItem {
  if (!value || typeof value !== "object") return false;
  const row = value as Record<string, unknown>;
  return (
    typeof row.id === "string" &&
    row.kind === "model" &&
    (row.provider === "claude" || row.provider === "codex") &&
    typeof row.model === "string" &&
    typeof row.at === "number"
  );
}
