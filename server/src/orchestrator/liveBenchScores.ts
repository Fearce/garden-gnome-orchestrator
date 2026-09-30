// Daily LiveBench capability prior for auto model selection, also shown as the Settings leaderboard.
//
// The leaderboard publishes one raw per-task CSV plus a category map per dated release. We cache the
// newest complete release in SQLite's existing kv store, compute the same category-average overall score
// as the website, and keep refresh failures off the dispatch path by retaining the last good snapshot.
// Organizations come from the site's own modelLinks.js table and only label the Settings view.

import type { Db } from "../db/db.js";
import { readAssignedLiteral, recordOf } from "./jsLiteral.js";

const REPO_RAW = "https://raw.githubusercontent.com/LiveBench/new-livebench/main";
const RELEASES_URL = `${REPO_RAW}/src/lib/constants.js`;
const MODEL_LINKS_URL = `${REPO_RAW}/src/Table/modelLinks.js`;
const CACHE_KEY = "livebench_scores_v1";
const CACHE_TTL_MS = 24 * 60 * 60_000;
const REFRESH_CHECK_MS = 5 * 60_000;
const FAILED_REFRESH_COOLDOWN_MS = REFRESH_CHECK_MS;
const FETCH_TIMEOUT_MS = 20_000;

type CategoryScores = Record<string, number>;

export interface LiveBenchRow {
  model: string;
  overall: number;
  categories: CategoryScores;
  /** The site's own provider label from modelLinks.js; absent when the site has no entry for the model. */
  organization?: string;
}

export interface LiveBenchSnapshot {
  version: 1;
  release: string;
  fetchedAt: number;
  rows: LiveBenchRow[];
  /** Absent on snapshots cached before organizations were captured, which makes them due for a refresh. */
  organizationsCaptured?: boolean;
}

/** A model GGO can dispatch to, used to mark the leaderboard rows it could actually run. */
export interface LiveBenchUsableModel {
  provider: string;
  model: string;
}

export interface LiveBenchLeaderboardRow extends LiveBenchRow {
  /** Local `provider:model` ids this row is exact evidence for. */
  usableAs: string[];
}

export interface LiveBenchLeaderboardSnapshot {
  release: string;
  fetchedAt: number;
  /** Category names in the release's own order. */
  categories: string[];
  rows: LiveBenchLeaderboardRow[];
}

export interface LiveBenchLeaderboard {
  snapshot: LiveBenchLeaderboardSnapshot | null;
  refreshing: boolean;
  lastError: string | null;
}

export interface LiveBenchEvidence {
  release: string;
  match: "exact" | "family-prior";
  comparedModel: string;
  variants: LiveBenchRow[];
}

type KvStore = Pick<Db, "kvGet" | "kvSet">;
type Log = (level: "info" | "warn", message: string) => void;

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

function mean(values: number[]): number {
  return values.length ? values.reduce((sum, n) => sum + n, 0) / values.length : 0;
}

/** Small RFC-4180 reader: LiveBench's current cells are simple, but quoted future model names stay safe. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") {
      row.push(cell);
      cell = "";
    } else if (ch === "\n") {
      row.push(cell.replace(/\r$/, ""));
      if (row.some((v) => v.length)) rows.push(row);
      row = [];
      cell = "";
    } else cell += ch;
  }
  if (cell.length || row.length) {
    row.push(cell.replace(/\r$/, ""));
    if (row.some((v) => v.length)) rows.push(row);
  }
  return rows;
}

/** Parse one published release and compute LiveBench's overall = mean(category averages). */
export function parseRelease(tableCsv: string, categoriesJson: string): LiveBenchRow[] {
  const csv = parseCsv(tableCsv);
  const header = csv[0] ?? [];
  if (header[0] !== "model") throw new Error("LiveBench table has no model column");
  const categories = JSON.parse(categoriesJson) as Record<string, string[]>;
  if (!categories || typeof categories !== "object" || !Object.keys(categories).length) throw new Error("LiveBench category map is empty");
  const column = new Map(header.map((name, i) => [name, i]));
  return csv.slice(1).flatMap((cells): LiveBenchRow[] => {
    const model = cells[0]?.trim();
    if (!model) return [];
    const scores: CategoryScores = {};
    for (const [category, tasks] of Object.entries(categories)) {
      const values = tasks.flatMap((task): number[] => {
        const raw = cells[column.get(task) ?? -1];
        const n = Number(raw);
        return Number.isFinite(n) ? [n] : [];
      });
      if (values.length) scores[category] = round1(mean(values));
    }
    const categoryValues = Object.values(scores);
    return categoryValues.length ? [{ model, categories: scores, overall: round1(mean(categoryValues)) }] : [];
  });
}

/** Model id → organization, resolved the way the site's getModelInfo does: a base entry wins, and an
 *  effort variant inherits its base entry's organization. */
export function parseModelOrganizations(modelLinksSource: string): Map<string, string> {
  const links = recordOf(readAssignedLiteral(modelLinksSource, "modelLinks"));
  if (!links) throw new Error("LiveBench modelLinks is not an object");
  const organizations = new Map<string, string>();
  for (const info of Object.values(links).map(recordOf)) {
    const organization = info?.organization;
    if (typeof organization !== "string" || !Array.isArray(info?.variants)) continue;
    for (const variant of info.variants.map(recordOf)) {
      if (typeof variant?.rawName === "string") organizations.set(variant.rawName, organization);
    }
  }
  for (const [model, info] of Object.entries(links)) {
    const organization = recordOf(info)?.organization;
    if (typeof organization === "string") organizations.set(model, organization);
  }
  return organizations;
}

function withOrganizations(rows: LiveBenchRow[], organizations: Map<string, string>): LiveBenchRow[] {
  return rows.map((row) => {
    const organization = organizations.get(row.model);
    return organization ? { ...row, organization } : row;
  });
}

function normalized(id: string): string {
  return id.trim().toLowerCase().replace(/_/g, "-");
}

/** A benchmark row is exact evidence for a local model when either id extends the other (effort suffixes). */
function isExactModel(rowModel: string, localModel: string): boolean {
  const row = normalized(rowModel);
  const wanted = normalized(localModel);
  return row === wanted || row.startsWith(`${wanted}-`) || wanted.startsWith(`${row}-`);
}

/** Every row of the snapshot, categories in release order, each marked with the local models it is exact evidence for. */
export function leaderboardOf(snapshot: LiveBenchSnapshot, usable: LiveBenchUsableModel[]): LiveBenchLeaderboardSnapshot {
  return {
    release: snapshot.release,
    fetchedAt: snapshot.fetchedAt,
    categories: [...new Set(snapshot.rows.flatMap((row) => Object.keys(row.categories)))],
    rows: snapshot.rows.map((row) => ({
      ...row,
      usableAs: usable.filter((u) => isExactModel(row.model, u.model)).map((u) => `${u.provider}:${u.model}`),
    })),
  };
}

interface FamilyVersion {
  family: string;
  version: number;
}

/** Family/version is deliberately narrow: an older benchmark is only a prior for the same named tier. */
function familyVersion(id: string): FamilyVersion | undefined {
  const n = normalized(id);
  let m = n.match(/^claude-(opus|sonnet|haiku|fable)-(\d+)-(\d+)/);
  if (m) return { family: `claude-${m[1]}`, version: Number(m[2]) * 100 + Number(m[3]) };
  m = n.match(/^(gpt|grok|glm)-(\d+)(?:\.(\d+)|-(\d+))?/);
  if (!m) return undefined;
  return { family: m[1]!, version: Number(m[2]) * 100 + Number(m[3] ?? m[4] ?? 0) };
}

/** Match an exact benchmarked model/effort variant, else the newest older release from its family. */
export function evidenceFor(snapshot: LiveBenchSnapshot | null, localModel: string): LiveBenchEvidence | undefined {
  if (!snapshot) return undefined;
  const wanted = normalized(localModel);
  const exact = snapshot.rows.filter((r) => isExactModel(r.model, localModel));
  if (exact.length) return { release: snapshot.release, match: "exact", comparedModel: localModel, variants: exact };

  const local = familyVersion(wanted);
  if (!local) return undefined;
  const familyRows = snapshot.rows.flatMap((row) => {
    const fv = familyVersion(row.model);
    return fv?.family === local.family && fv.version <= local.version ? [{ row, version: fv.version }] : [];
  });
  const newest = Math.max(...familyRows.map((x) => x.version));
  if (!Number.isFinite(newest)) return undefined;
  const variants = familyRows.filter((x) => x.version === newest).map((x) => x.row);
  return variants.length
    ? { release: snapshot.release, match: "family-prior", comparedModel: variants[0]!.model, variants }
    : undefined;
}

function score(row: LiveBenchRow, key: string): string {
  const n = row.categories[key];
  return Number.isFinite(n) ? String(n) : "n/a";
}

/** Compact prompt evidence, including effort variants when LiveBench published more than one. */
export function evidenceNote(evidence: LiveBenchEvidence | undefined): string | undefined {
  if (!evidence) return undefined;
  const kind = evidence.match === "exact" ? "exact model" : `older same-family prior: ${evidence.comparedModel}`;
  const rows = [...evidence.variants]
    .sort((a, b) => b.overall - a.overall)
    .slice(0, 4)
    .map((r) => `${r.model}: overall ${r.overall}, coding ${score(r, "Coding")}, agentic ${score(r, "Agentic Coding")}, reasoning ${score(r, "Reasoning")}`);
  return `LiveBench ${evidence.release} (${kind}) — ${rows.join("; ")}`;
}

function latestRelease(constantsSource: string): string {
  const releases = [...constantsSource.matchAll(/["'](\d{4}-\d{2}-\d{2})["']/g)].map((m) => m[1]!);
  if (!releases.length) throw new Error("LiveBench release list is empty");
  return releases.sort().at(-1)!;
}

async function fetchText(url: string): Promise<string> {
  const res = await fetch(url, { headers: { "user-agent": "GG-Orchestrator/1.0" }, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.text();
}

export class LiveBenchScores {
  private snapshot: LiveBenchSnapshot | null;
  private refreshPromise: Promise<void> | undefined;
  private timer: NodeJS.Timeout | undefined;
  private lastAttemptAt = 0;
  private lastError: string | null = null;

  constructor(private readonly store: KvStore, private readonly log: Log = () => {}) {
    this.snapshot = this.readCache();
  }

  start(): void {
    void this.refreshIfDue();
    // Check cheaply every five minutes: a fresh snapshot returns immediately, while a boot-time network
    // blip retries soon instead of leaving a first-ever install without evidence for a full day.
    this.timer ??= setInterval(() => void this.refreshIfDue(), REFRESH_CHECK_MS);
    this.timer.unref?.();
  }

  /** Awaitable for the first selector after boot; refresh failures retain stale evidence and never throw. */
  refreshIfDue(force = false): Promise<void> {
    if (!force && this.isFresh()) return Promise.resolve();
    if (!force && !this.snapshot && Date.now() - this.lastAttemptAt < FAILED_REFRESH_COOLDOWN_MS) return Promise.resolve();
    if (this.refreshPromise) return this.refreshPromise;
    this.lastAttemptAt = Date.now();
    this.refreshPromise = this.refresh().finally(() => {
      this.refreshPromise = undefined;
    });
    return this.refreshPromise;
  }

  /** Give a first-ever boot a brief chance to fetch evidence, without making LiveBench a dispatch dependency. */
  async prepareForSelection(maxWaitMs = 1_500): Promise<void> {
    const refresh = this.refreshIfDue();
    if (this.snapshot) return refresh;
    await Promise.race([refresh, new Promise<void>((resolve) => setTimeout(resolve, maxWaitMs))]);
  }

  evidence(model: string): LiveBenchEvidence | undefined {
    return evidenceFor(this.snapshot, model);
  }

  note(model: string): string | undefined {
    return evidenceNote(this.evidence(model));
  }

  status(): { release?: string; fetchedAt?: number; models: number } {
    return { release: this.snapshot?.release, fetchedAt: this.snapshot?.fetchedAt, models: this.snapshot?.rows.length ?? 0 };
  }

  /** The cached release as the Settings leaderboard shows it; null until the first refresh has succeeded. */
  leaderboard(usable: LiveBenchUsableModel[]): LiveBenchLeaderboard {
    return {
      snapshot: this.snapshot ? leaderboardOf(this.snapshot, usable) : null,
      refreshing: !!this.refreshPromise,
      lastError: this.lastError,
    };
  }

  private isFresh(): boolean {
    const snapshot = this.snapshot;
    return !!snapshot && snapshot.organizationsCaptured !== undefined && Date.now() - snapshot.fetchedAt < CACHE_TTL_MS;
  }

  private readCache(): LiveBenchSnapshot | null {
    const raw = this.store.kvGet(CACHE_KEY);
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw) as LiveBenchSnapshot;
      return parsed?.version === 1 && typeof parsed.release === "string" && Array.isArray(parsed.rows) ? parsed : null;
    } catch {
      return null;
    }
  }

  private async refresh(): Promise<void> {
    try {
      const constants = await fetchText(RELEASES_URL);
      const release = latestRelease(constants);
      const [table, categories, organizations] = await Promise.all([
        fetchText(`${REPO_RAW}/public/table_${release.replaceAll("-", "_")}.csv`),
        fetchText(`${REPO_RAW}/public/categories_${release.replaceAll("-", "_")}.json`),
        this.fetchOrganizations(),
      ]);
      const parsed = parseRelease(table, categories);
      if (!parsed.length) throw new Error("parsed leaderboard is empty");
      const rows = organizations ? withOrganizations(parsed, organizations) : parsed;
      this.snapshot = { version: 1, release, fetchedAt: Date.now(), rows, organizationsCaptured: !!organizations };
      this.store.kvSet(CACHE_KEY, JSON.stringify(this.snapshot));
      this.lastError = null;
      this.log("info", `LiveBench ${release} cached for auto-selection (${rows.length} models).`);
    } catch (err) {
      this.lastError = String(err);
      this.log("warn", `LiveBench refresh failed; ${this.snapshot ? "using the last cached release" : "auto-selection will continue without benchmark evidence"}: ${String(err)}`);
    }
  }

  /** Organizations only label the Settings leaderboard, so losing them never fails the scores refresh. */
  private async fetchOrganizations(): Promise<Map<string, string> | undefined> {
    try {
      return parseModelOrganizations(await fetchText(MODEL_LINKS_URL));
    } catch (err) {
      this.log("warn", `LiveBench organizations unavailable; caching the release without them: ${String(err)}`);
      return undefined;
    }
  }
}
