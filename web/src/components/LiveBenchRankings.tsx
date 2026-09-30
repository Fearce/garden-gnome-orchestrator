import { useEffect, useMemo, useState } from "react";
import { apiUrl } from "../lib/base.js";
import { ago } from "../lib/format.js";
import {
  DEFAULT_SORT,
  filterRows,
  formatFetchedAt,
  formatRelease,
  formatScore,
  liveBenchColumns,
  nextSort,
  rankRows,
  sortRows,
  type LiveBenchColumn,
  type LiveBenchLeaderboardDTO,
  type RankedRow,
  type SortState,
} from "../lib/liveBench.js";

const PENDING_POLL_MS = 4_000;

type LoadState = { status: "loading" } | { status: "failed"; error: string } | { status: "ready"; data: LiveBenchLeaderboardDTO };

/** Settings → LiveBench rankings. Loads when its page is first opened and again on every revisit, so a
 *  daily refresh that landed while the dialog sat open shows up without a reload. */
export function LiveBenchRankings({ active }: { active: boolean }) {
  const load = useLeaderboard(active);
  if (load.status === "loading") return <p className="settings-note">Loading the cached LiveBench release…</p>;
  if (load.status === "failed") return <p className="settings-note lb-error">Couldn't load the leaderboard: {load.error}</p>;
  const { snapshot, refreshing, lastError } = load.data;
  if (!snapshot) return <MissingSnapshot refreshing={refreshing} lastError={lastError} />;
  return <Leaderboard snapshot={snapshot} lastError={lastError} />;
}

function useLeaderboard(active: boolean): LoadState {
  const [state, setState] = useState<LoadState>({ status: "loading" });
  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    let timer: number | undefined;
    const fetchOnce = async () => {
      try {
        const res = await fetch(apiUrl("/api/livebench"), { cache: "no-store" });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = (await res.json()) as LiveBenchLeaderboardDTO;
        if (cancelled) return;
        setState({ status: "ready", data });
        if (!data.snapshot && data.refreshing) timer = window.setTimeout(fetchOnce, PENDING_POLL_MS);
      } catch (err) {
        if (!cancelled) setState({ status: "failed", error: err instanceof Error ? err.message : String(err) });
      }
    };
    void fetchOnce();
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [active]);
  return state;
}

function MissingSnapshot({ refreshing, lastError }: { refreshing: boolean; lastError: string | null }) {
  if (refreshing) return <p className="settings-note">Fetching the newest LiveBench release for the first time…</p>;
  return (
    <p className="settings-note lb-error">
      No LiveBench release has been cached yet. {lastError ? `The last refresh failed: ${lastError}. ` : ""}GGO retries every five
      minutes while none is cached.
    </p>
  );
}

function Leaderboard({ snapshot, lastError }: { snapshot: NonNullable<LiveBenchLeaderboardDTO["snapshot"]>; lastError: string | null }) {
  const [sort, setSort] = useState<SortState>(DEFAULT_SORT);
  const [query, setQuery] = useState("");
  const [runnableOnly, setRunnableOnly] = useState(false);
  const columns = useMemo(() => liveBenchColumns(snapshot.categories), [snapshot.categories]);
  const ranked = useMemo(() => rankRows(snapshot.rows), [snapshot.rows]);
  const runnable = ranked.filter((row) => row.usableAs.length).length;
  const visible = useMemo(() => sortRows(filterRows(ranked, query, runnableOnly), columns, sort), [ranked, query, runnableOnly, columns, sort]);

  return (
    <div className="lb">
      <div className="lb-meta">
        <span className="lb-snapshot">
          Snapshot: <strong>{formatRelease(snapshot.release)}</strong>
        </span>
        <span>
          fetched {formatFetchedAt(snapshot.fetchedAt)} ({ago(snapshot.fetchedAt)} ago)
        </span>
        <span>{snapshot.rows.length} models</span>
        {lastError ? <span className="lb-stale" title={lastError}>last refresh failed — showing the cached release</span> : null}
      </div>
      <div className="lb-toolbar">
        <input
          className="lb-search"
          type="search"
          placeholder="Filter models or organizations"
          aria-label="Filter LiveBench models"
          value={query}
          spellCheck={false}
          autoComplete="off"
          onChange={(e) => setQuery(e.target.value)}
        />
        <button
          type="button"
          className={"lb-chip" + (runnableOnly ? " on" : "")}
          aria-pressed={runnableOnly}
          disabled={!runnable}
          onClick={() => setRunnableOnly(!runnableOnly)}
        >
          <span className="lb-dot" aria-hidden="true" />
          Runnable in GGO <span className="lb-count">{runnable}</span>
        </button>
        <span className="lb-shown" aria-live="polite">
          {visible.length === ranked.length ? `${ranked.length} rows` : `${visible.length} of ${ranked.length}`}
        </span>
      </div>
      <div className="lb-scroll">
        <table className="lb-table">
          <thead>
            <tr>
              {columns.map((column) => (
                <HeaderCell key={column.key} column={column} sort={sort} onSort={() => setSort(nextSort(sort, column))} />
              ))}
            </tr>
          </thead>
          <tbody>
            {visible.map((row) => (
              <LeaderboardRow key={row.model} row={row} columns={columns} />
            ))}
          </tbody>
        </table>
        {!visible.length ? <p className="lb-empty">No model matches “{query.trim()}”{runnableOnly ? " among the runnable ones" : ""}.</p> : null}
      </div>
    </div>
  );
}

function HeaderCell({ column, sort, onSort }: { column: LiveBenchColumn; sort: SortState; onSort: () => void }) {
  const sorted = sort.key === column.key;
  return (
    <th
      scope="col"
      className={`lb-col-${columnClass(column)}` + (sorted ? " sorted" : "")}
      aria-sort={sorted ? (sort.direction === "asc" ? "ascending" : "descending") : "none"}
    >
      <button type="button" className="lb-sort" onClick={onSort}>
        <span>{column.label}</span>
        <SortArrow direction={sorted ? sort.direction : null} />
      </button>
    </th>
  );
}

function SortArrow({ direction }: { direction: SortState["direction"] | null }) {
  return (
    <svg className={"lb-arrow" + (direction ? " on" : "")} width="9" height="9" viewBox="0 0 10 10" aria-hidden="true">
      <path d={direction === "asc" ? "M5 2 9 7H1Z" : "M5 8 1 3h8Z"} fill="currentColor" />
    </svg>
  );
}

function LeaderboardRow({ row, columns }: { row: RankedRow; columns: LiveBenchColumn[] }) {
  const runnable = row.usableAs.length > 0;
  return (
    <tr className={runnable ? "runnable" : undefined}>
      {columns.map((column) => {
        const value = column.value(row);
        const className = `lb-col-${columnClass(column)}`;
        if (column.key === "model")
          return (
            <th key={column.key} scope="row" className={className} title={runnable ? `${row.model} — runnable in GGO as ${row.usableAs.join(", ")}` : row.model}>
              {runnable ? <span className="lb-dot" aria-label="Runnable in GGO" /> : null}
              {row.model}
            </th>
          );
        if (column.kind === "text") return <td key={column.key} className={className}>{value ?? "—"}</td>;
        return <td key={column.key} className={className}>{column.key === "rank" ? value : formatScore(value)}</td>;
      })}
    </tr>
  );
}

function columnClass(column: LiveBenchColumn): string {
  if (column.key === "rank" || column.key === "model" || column.key === "organization") return column.key;
  return column.key === "overall" ? "num overall" : "num";
}
