// Owner invariant: never run an older model of a family when a newer one in that family is available.
// "Family" is one product line — Opus, Sonnet, Haiku, Fable, Sol, Luna, Astra, Spark, GLM, … — so the
// rule orders VERSIONS within a line and never moves a model across lines (Sonnet 5.5 beside Opus 5.5
// is fine; Sonnet 5 beside Sonnet 5.5 is not).
//
// "Newer" is read from the model ids the installed providers actually expose (the live catalogs held by
// ModelCatalog), never from a hand-kept list: when a new family member ships and appears in a catalog,
// every resolution below prefers it with no code change. A model id this module cannot parse passes
// through untouched — an unknown naming scheme must never be "upgraded" by guesswork.

export interface ModelFamilyVersion {
  /** Provider-independent line key, e.g. `claude-opus`, `gpt-sol`, `glm`, `grok-fast`. */
  family: string;
  /** Version parts, most significant first; `[6]` and `[6, 0]` compare equal. */
  version: number[];
}

const BRACKET_SUFFIX = /(\[[^\]]*\])$/;

function splitSuffix(id: string): { base: string; suffix: string } {
  const trimmed = id.trim();
  const match = BRACKET_SUFFIX.exec(trimmed);
  return match ? { base: trimmed.slice(0, -match[1]!.length), suffix: match[1]! } : { base: trimmed, suffix: "" };
}

const PARSERS: Array<(id: string) => ModelFamilyVersion | null> = [
  // claude-opus-5-5, claude-sonnet-5, claude-opus-4-5-20251101, claude-haiku-4-5-20251001. A one- or
  // two-digit group is a minor version; an 8-digit trailing group is a snapshot date, not a version.
  (id) => {
    const m = /^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?$/.exec(id);
    return m ? { family: `claude-${m[1]}`, version: [Number(m[2]), Number(m[3] ?? 0)] } : null;
  },
  // Pre-4 naming put the version before the tier: claude-3-5-haiku-20241022, claude-3-opus-20240229.
  (id) => {
    const m = /^claude-(\d+)(?:-(\d{1,2}))?-([a-z]+)(?:-\d{8})?$/.exec(id);
    return m ? { family: `claude-${m[3]}`, version: [Number(m[1]), Number(m[2] ?? 0)] } : null;
  },
  // The tier-first wording an owner types for a Claude model: "Sonnet 5", "sonnet 5.5", "opus-4-5".
  (id) => {
    const m = /^(opus|sonnet|haiku|fable)-(\d+)(?:[.-](\d{1,2}))?$/.exec(id);
    return m ? { family: `claude-${m[1]}`, version: [Number(m[2]), Number(m[3] ?? 0)] } : null;
  },
  // gpt-6-sol, gpt-6.1-sol, gpt-5.6-luna, gpt-5.3-codex-spark, gpt-4.1-mini-2025-04-14, gpt-5.
  (id) => {
    const m = /^gpt-(\d+)(?:\.(\d+))?(?:-(.+?))?(?:-\d{4}-\d{2}-\d{2})?$/.exec(id);
    return m ? { family: `gpt-${m[3] ?? ""}`, version: [Number(m[1]), Number(m[2] ?? 0)] } : null;
  },
  // glm-5.3, glm-4.5-air, grok-4.7, grok-4.1-fast.
  (id) => {
    const m = /^(glm|grok)-(\d+)(?:\.(\d+))?(?:-(.+))?$/.exec(id);
    return m ? { family: `${m[1]}-${m[4] ?? ""}`, version: [Number(m[2]), Number(m[3] ?? 0)] } : null;
  },
];

/** The family and version an id names, or null for an id outside every known naming scheme. */
export function modelFamilyVersion(id: string): ModelFamilyVersion | null {
  if (typeof id !== "string") return null;
  // Typed wording ("GPT-6 Sol") names the same id as its hyphenated form.
  const base = splitSuffix(id).base.toLowerCase().replace(/\s+/g, "-");
  if (!base) return null;
  for (const parse of PARSERS) {
    const parsed = parse(base);
    if (parsed) return parsed;
  }
  return null;
}

/** Negative when `a` is older, positive when newer, 0 when equal (missing parts count as 0). */
export function compareModelVersions(a: readonly number[], b: readonly number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const diff = (a[i] ?? 0) - (b[i] ?? 0);
    if (diff) return diff;
  }
  return 0;
}

/** Whether two ids belong to the same family (and the same bracket variant, e.g. `[1m]`). */
export function sameModelFamily(a: string, b: string): boolean {
  const fa = modelFamilyVersion(a);
  const fb = modelFamilyVersion(b);
  return !!fa && !!fb && fa.family === fb.family && splitSuffix(a).suffix === splitSuffix(b).suffix;
}

/**
 * The newest member of `id`'s family among `available`, or `id` itself when nothing available is
 * strictly newer. Never a downgrade, never a cross-family move, and never an id absent from
 * `available` — a string the installation's catalog does not carry would fail the run outright.
 * Among equally-new members the first listed wins (catalogs list their canonical alias first).
 */
export function newestInFamily(id: string, available: readonly string[]): string {
  const own = modelFamilyVersion(id);
  if (!own) return id;
  const { suffix } = splitSuffix(id);
  let best: { id: string; version: number[] } | null = null;
  for (const candidate of available) {
    const parts = splitSuffix(candidate);
    if (parts.suffix && parts.suffix !== suffix) continue;
    const parsed = modelFamilyVersion(parts.base);
    if (!parsed || parsed.family !== own.family) continue;
    if (compareModelVersions(parsed.version, own.version) <= 0) continue;
    if (!best || compareModelVersions(parsed.version, best.version) > 0) best = { id: parts.base, version: parsed.version };
  }
  return best ? `${best.id}${suffix}` : id;
}

/** True when `available` carries a strictly newer member of `id`'s family. */
export function isSupersededModel(id: string, available: readonly string[]): boolean {
  return newestInFamily(id, available) !== id;
}

/** `models` without any id a newer same-family member in the same list supersedes. Order is kept. */
export function withoutSupersededModels(models: readonly string[]): string[] {
  return models.filter((model) => !isSupersededModel(model, models));
}

/** The owner-facing line for a substitution, e.g. `gpt-6-sol → gpt-6.1-sol: newer same-family model available`. */
export function familyUpgradeNote(from: string, to: string): string {
  return `${from} → ${to}: newer same-family model available`;
}

// ---- the process-wide roster ------------------------------------------------------------------------
//
// Many call sites resolve a model with no roster in hand (runner constructors, JSON revivers over stored
// settings, the Codex generation map). They resolve against one process-wide roster that the owner of the
// live catalogs registers at boot. With nothing registered every id passes through unchanged, which is
// what pure unit tests of unrelated modules want.

export interface ModelFamilyRosterSource {
  /** Every model id the installed providers expose. May be costly (disk reads); called only on a miss. */
  models(): readonly string[];
  /** Cheap stamp of the stored catalogs: the cached roster is reused only while it is unchanged, so a
   *  catalog that picks up a release moves every resolution on the very next call. */
  signature(): string;
}

// Inputs the signature cannot see (e.g. which Codex login is active) are re-read at least this often.
const ROSTER_MAX_AGE_MS = 60_000;
let rosterSource: ModelFamilyRosterSource | null = null;
let rosterCache: { at: number; signature: string; models: readonly string[] } | null = null;

/** Register the provider catalogs every family resolution reads. The last registration wins. */
export function setModelFamilyRoster(source: ModelFamilyRosterSource | null): void {
  rosterSource = source;
  rosterCache = null;
}

/** Drop the cached roster so the next resolution re-reads the catalogs. */
export function invalidateModelFamilyRoster(): void {
  rosterCache = null;
}

/** Every model id the installed providers currently expose, across providers. */
export function modelFamilyRoster(): readonly string[] {
  if (!rosterSource) return [];
  const now = Date.now();
  let signature: string;
  try {
    signature = rosterSource.signature();
  } catch {
    return [];
  }
  if (!rosterCache || rosterCache.signature !== signature || now - rosterCache.at > ROSTER_MAX_AGE_MS) {
    // Stamp before reading: a source that itself resolves a model must not recurse into a fresh read.
    rosterCache = { at: now, signature, models: [] };
    try {
      rosterCache = { at: now, signature, models: [...rosterSource.models()] };
    } catch {
      rosterCache = null;
      return [];
    }
  }
  return rosterCache.models;
}

/** `id` resolved to the newest same-family model any installed provider currently exposes. */
export function latestFamilyModel(id: string): string {
  return newestInFamily(id, modelFamilyRoster());
}
