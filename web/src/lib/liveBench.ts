// Settings → LiveBench rankings: the table model behind the leaderboard. Columns are derived from the
// snapshot's own categories so a release that adds or renames one needs no console change.

export interface LiveBenchRowDTO {
  model: string;
  overall: number;
  categories: Record<string, number>;
  organization?: string;
  /** Local `provider:model` ids this row is exact evidence for — the models GGO can actually run. */
  usableAs: string[];
}

export interface LiveBenchLeaderboardDTO {
  snapshot: {
    release: string;
    fetchedAt: number;
    categories: string[];
    rows: LiveBenchRowDTO[];
  } | null;
  refreshing: boolean;
  lastError: string | null;
}

export type SortDirection = "asc" | "desc";

export interface LiveBenchColumn {
  key: string;
  label: string;
  kind: "text" | "number";
  /** Direction of the first click: best-first for scores and rank, A→Z for text. */
  firstDirection: SortDirection;
  value: (row: RankedRow) => string | number | null;
}

export interface RankedRow extends LiveBenchRowDTO {
  /** Competition rank by global average (ties share a rank), fixed whatever the table is sorted by. */
  rank: number;
}

export interface SortState {
  key: string;
  direction: SortDirection;
}

export const DEFAULT_SORT: SortState = { key: "overall", direction: "desc" };

/** LiveBench abbreviates only this category in its data; every other key is already a readable name. */
const CATEGORY_LABELS: Record<string, string> = { IF: "Instruction Following" };

export function categoryLabel(category: string): string {
  return CATEGORY_LABELS[category] ?? category;
}

export function liveBenchColumns(categories: string[]): LiveBenchColumn[] {
  return [
    { key: "rank", label: "Rank", kind: "number", firstDirection: "asc", value: (row) => row.rank },
    { key: "model", label: "Model", kind: "text", firstDirection: "asc", value: (row) => row.model },
    { key: "organization", label: "Organization", kind: "text", firstDirection: "asc", value: (row) => row.organization ?? null },
    { key: "overall", label: "Global Average", kind: "number", firstDirection: "desc", value: (row) => row.overall },
    ...categories.map((category): LiveBenchColumn => ({
      key: `category:${category}`,
      label: categoryLabel(category),
      kind: "number",
      firstDirection: "desc",
      value: (row) => row.categories[category] ?? null,
    })),
  ];
}

export function rankRows(rows: LiveBenchRowDTO[]): RankedRow[] {
  const scores = rows.map((row) => row.overall).sort((a, b) => b - a);
  return rows.map((row) => ({ ...row, rank: scores.indexOf(row.overall) + 1 }));
}

/** A header click: the same column flips direction, a new column starts in its natural direction. */
export function nextSort(current: SortState, column: LiveBenchColumn): SortState {
  if (current.key === column.key) return { key: column.key, direction: current.direction === "asc" ? "desc" : "asc" };
  return { key: column.key, direction: column.firstDirection };
}

function isMissing(value: string | number | null): value is null {
  return value === null || (typeof value === "number" && !Number.isFinite(value)) || (typeof value === "string" && !value.trim());
}

const collator = new Intl.Collator("en", { sensitivity: "base", numeric: true });

function compareValues(a: string | number, b: string | number, kind: LiveBenchColumn["kind"]): number {
  return kind === "number" ? Number(a) - Number(b) : collator.compare(String(a), String(b));
}

/** Sort by one column. Missing values go last in BOTH directions; ties fall back to model name. */
export function sortRows<T extends RankedRow>(rows: T[], columns: LiveBenchColumn[], sort: SortState): T[] {
  const column = columns.find((c) => c.key === sort.key) ?? columns.find((c) => c.key === DEFAULT_SORT.key)!;
  const sign = sort.direction === "asc" ? 1 : -1;
  return [...rows].sort((a, b) => {
    const av = column.value(a);
    const bv = column.value(b);
    const aMissing = isMissing(av);
    const bMissing = isMissing(bv);
    if (aMissing || bMissing) return aMissing === bMissing ? collator.compare(a.model, b.model) : aMissing ? 1 : -1;
    return sign * compareValues(av, bv, column.kind) || collator.compare(a.model, b.model);
  });
}

/** Case-insensitive match on model or organization; every term must appear. */
export function filterRows<T extends RankedRow>(rows: T[], query: string, runnableOnly: boolean): T[] {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  return rows.filter((row) => {
    if (runnableOnly && !row.usableAs.length) return false;
    const haystack = `${row.model} ${row.organization ?? ""}`.toLowerCase();
    return terms.every((term) => haystack.includes(term));
  });
}

export function formatScore(value: string | number | null): string {
  return typeof value === "number" && Number.isFinite(value) ? value.toFixed(1) : "—";
}

export function formatFetchedAt(ts: number): string {
  return new Date(ts).toLocaleString("en-GB", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
}

/** Release dates are calendar dates, so format them without a timezone shift. */
export function formatRelease(release: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(release);
  if (!m) return release;
  return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });
}
