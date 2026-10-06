import { useEffect, useMemo, useState } from "react";
import { useStore } from "../store.js";
import { DIGEST_MIN_CHANGES, digestKey, localDay, msUntilNextDay, newerThan, usePatchNotes, type PatchNote, type PatchNoteKind } from "../lib/patchNotes.js";
import "./patchNotes.css";

/**
 * Patch notes: what changed in this install, newest first, read from its own git history. Features,
 * fixes and speed-ups lead; docs, tests and chores stay folded behind a toggle because nobody using the
 * console acts on them. Commits the upstream has but this checkout does not are listed on top as the
 * next update, so the Update badge's "N new commits" finally says what those commits are. A busy day
 * that has ended opens with a one-line model-written overview of its changes above the bullets; today
 * gets none until midnight, since every new commit would otherwise rewrite it.
 */
export function PatchNotes() {
  const { entries, upcoming, pending, hasMore, lastDayComplete, loading, error, seenSha, load, loadOlder, markSeen } = usePatchNotes();
  const [filter, setFilter] = useState<Filter>("all");
  const [showInternal, setShowInternal] = useState(false);
  // Snapshot what was unseen when the area opened, so this visit still marks it after it is recorded as seen.
  const [seenAtOpen] = useState(seenSha);

  useEffect(() => {
    void load().then(markSeen);
  }, [load, markSeen]);

  const newCount = newerThan(entries, seenAtOpen);
  const annotated = useMemo(() => {
    const unbuilt = new Set(pending);
    return entries.map((note, i) => ({ note, isNew: i < newCount, notLive: unbuilt.has(note.sha) }));
  }, [entries, newCount, pending]);
  const internalCount = entries.filter((e) => e.kind === "internal").length;
  const today = useToday();

  return (
    <div className="pn-view">
      <div className="pn-toolbar">
        <FilterTabs value={filter} onChange={setFilter} />
        <label className="pn-internal" title="Docs, tests, chores and refactors: changes to how GGO is built, not to what it does">
          <input type="checkbox" checked={showInternal} onChange={(e) => setShowInternal(e.target.checked)} />
          Internal changes{internalCount ? ` (${internalCount})` : ""}
        </label>
      </div>

      {upcoming.length > 0 ? <UpcomingUpdate notes={upcoming} /> : null}

      {error ? <div className="pn-error">Couldn't read the change history: {error}</div> : null}

      {!error && entries.length === 0 ? (
        <div className="empty">
          <div className="big">{loading ? "Reading the change history…" : "No changes recorded"}</div>
        </div>
      ) : (
        <DayGroups rows={annotated} filter={filter} showInternal={showInternal} lastDayComplete={lastDayComplete} today={today} />
      )}

      {hasMore ? (
        <div className="pn-more">
          <button className="btn ghost sm" onClick={() => void loadOlder()} disabled={loading}>
            {loading ? "Loading…" : "Show older changes"}
          </button>
        </div>
      ) : null}
    </div>
  );
}

/** The viewer's current `localDay`, moving on at local midnight so yesterday gets its digest (and its
 *  "Yesterday" label) without a reload. Rechecked on return to the tab: a sleeping machine delays timers. */
function useToday(): string {
  const [today, setToday] = useState(() => localDay(Date.now()));
  useEffect(() => {
    const recheck = () => setToday(localDay(Date.now()));
    const timer = setTimeout(recheck, msUntilNextDay(Date.now()) + 1000);
    document.addEventListener("visibilitychange", recheck);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", recheck);
    };
  }, [today]);
  return today;
}

type Filter = "all" | "feature" | "fix" | "perf";

const FILTERS: { value: Filter; label: string }[] = [
  { value: "all", label: "Everything" },
  { value: "feature", label: "New" },
  { value: "fix", label: "Fixed" },
  { value: "perf", label: "Faster" },
];

const KIND_LABEL: Record<PatchNoteKind, string> = {
  feature: "New",
  fix: "Fixed",
  perf: "Faster",
  other: "Changed",
  internal: "Internal",
};

function shows(note: PatchNote, filter: Filter, showInternal: boolean): boolean {
  if (filter !== "all") return note.kind === filter;
  return showInternal || note.kind !== "internal";
}

function FilterTabs({ value, onChange }: { value: Filter; onChange: (f: Filter) => void }) {
  return (
    <div className="pn-filters" role="tablist" aria-label="Filter patch notes">
      {FILTERS.map((f) => (
        <button key={f.value} role="tab" aria-selected={value === f.value} className={"pn-filter" + (value === f.value ? " on" : "")} onClick={() => onChange(f.value)}>
          {f.label}
        </button>
      ))}
    </div>
  );
}

/** What the Update badge would pull in, with the same apply action one click away. */
function UpcomingUpdate({ notes }: { notes: PatchNote[] }) {
  const applying = useStore((s) => s.updateApplying);
  const blockedBy = useStore((s) => s.gitUpdate?.blockedBy ?? []);
  const applyGitUpdate = useStore((s) => s.applyGitUpdate);
  const shown = notes.filter((n) => n.kind !== "internal");
  const hidden = notes.length - shown.length;

  return (
    <section className="pn-upcoming" aria-label="In the next update">
      <header className="pn-upcoming-head">
        <div>
          <h3>In the next update</h3>
          <span className="pn-upcoming-sub">
            {notes.length} {notes.length === 1 ? "commit" : "commits"} upstream{hidden ? ` · ${hidden} internal not listed` : ""}
          </span>
        </div>
        <button
          className="btn primary sm"
          onClick={() => void applyGitUpdate()}
          disabled={applying}
          title={blockedBy.length ? `Uncommitted changes to ${blockedBy.join(", ")} would be overwritten. Clicking explains what to do.` : "Pull, rebuild and reload"}
        >
          {applying ? "Updating…" : "Update now"}
        </button>
      </header>
      {shown.length ? (
        <ul className="pn-list">
          {shown.map((note) => (
            <NoteRow key={note.sha} note={note} isNew={false} notLive={false} />
          ))}
        </ul>
      ) : (
        <p className="pn-upcoming-sub">Only internal changes (docs, tests, chores).</p>
      )}
    </section>
  );
}

type Row = { note: PatchNote; isNew: boolean; notLive: boolean };

/** Days are grouped over every loaded change, so a day's digest and its "busy" test do not depend on
 *  the filter; the filter only decides which bullets show under it. A digest needs the whole day: one
 *  that has ended, and that is not cut off at the end of the loaded page. */
function DayGroups({ rows, filter, showInternal, lastDayComplete, today }: { rows: Row[]; filter: Filter; showInternal: boolean; lastDayComplete: boolean; today: string }) {
  const days = groupByDay(rows)
    .map((group, i, all) => ({
      ...group,
      visible: group.rows.filter(({ note }) => shows(note, filter, showInternal)),
      complete: group.key < today && (lastDayComplete || i < all.length - 1),
    }))
    .filter((group) => group.visible.length > 0);
  if (days.length === 0) return <div className="pn-none faint">Nothing in this filter among the loaded changes.</div>;
  return (
    <>
      {days.map((group) => (
        <section className="pn-day" key={group.key}>
          <h3 className="pn-day-head">{dayLabel(group.key, today)}</h3>
          {filter === "all" && group.complete ? <DayDigest day={group.key} rows={group.rows} /> : null}
          <ul className="pn-list">
            {group.visible.map((row) => (
              <NoteRow key={row.note.sha} {...row} />
            ))}
          </ul>
        </section>
      ))}
    </>
  );
}

/** The overview above a busy day. It covers the operator-facing changes only, like the default list.
 *  The last loaded day may continue on the next page, so it waits until that page is loaded. */
function DayDigest({ day, rows }: { day: string; rows: Row[] }) {
  const shas = useMemo(() => rows.filter(({ note }) => note.kind !== "internal").map(({ note }) => note.sha), [rows]);
  const busy = shas.length >= DIGEST_MIN_CHANGES;
  const key = busy ? digestKey(shas) : null;
  const digest = usePatchNotes((s) => (key ? s.digests[key] : undefined));
  const requestDigest = usePatchNotes((s) => s.requestDigest);

  useEffect(() => {
    if (busy) requestDigest(day, shas);
  }, [busy, day, shas, requestDigest]);

  if (!busy || !digest || digest.status === "failed") return null;
  if (digest.status === "loading") {
    return (
      <p className="pn-digest loading" aria-busy="true">
        Summarizing {shas.length} changes…
      </p>
    );
  }
  return <p className="pn-digest">{digest.summary}</p>;
}

function NoteRow({ note, isNew, notLive }: Row) {
  const [open, setOpen] = useState(false);
  const paragraphs = useMemo(() => bodyParagraphs(note.body), [note.body]);
  const expandable = paragraphs.length > 0;

  return (
    <li className={"pn-row k-" + note.kind + (open ? " open" : "")}>
      <span className="pn-kind">{KIND_LABEL[note.kind]}</span>
      <div className="pn-main">
        <button className="pn-summary" onClick={() => expandable && setOpen((o) => !o)} aria-expanded={expandable ? open : undefined} disabled={!expandable}>
          {note.summary}
          {expandable ? <Chevron open={open} /> : null}
        </button>
        <div className="pn-meta">
          {note.scope ? <span className="pn-scope">{note.scope}</span> : null}
          {note.breaking ? <span className="pn-flag breaking">Breaking</span> : null}
          {isNew ? <span className="pn-flag new">New to you</span> : null}
          {notLive ? (
            <span className="pn-flag pending" title="This change is committed but not built into what is running yet. A server change goes live with the next deploy, a web change with the next web build and a reload.">
              Not live yet
            </span>
          ) : null}
          <span className="pn-sha" title={note.sha}>{note.short}</span>
          <span className="pn-time">{timeOfDay(note.at)}</span>
        </div>
        {open ? (
          <div className="pn-body">
            {paragraphs.map((p, i) => (
              <p key={i}>{p}</p>
            ))}
          </div>
        ) : null}
      </div>
    </li>
  );
}

function Chevron({ open }: { open: boolean }) {
  return (
    <svg className="pn-chevron" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={open ? "m18 15-6-6-6 6" : "m6 9 6 6 6-6"} />
    </svg>
  );
}

/** Commit bodies are hard-wrapped near 72 columns; rejoin each paragraph so it reflows to the panel. */
function bodyParagraphs(body: string): string[] {
  return body
    .split(/\n\s*\n/)
    .map((block) => block.split("\n").map((l) => l.trim()).join(" ").trim())
    .filter(Boolean);
}

/** Groups by `localDay`, the same key the digest names, so "today" means one thing everywhere. */
function groupByDay(rows: Row[]): { key: string; rows: Row[] }[] {
  const groups: { key: string; rows: Row[] }[] = [];
  for (const row of rows) {
    const key = localDay(row.note.at);
    const last = groups.at(-1);
    if (last?.key === key) last.rows.push(row);
    else groups.push({ key, rows: [row] });
  }
  return groups;
}

function dayLabel(key: string, today: string): string {
  const [year, month, date] = key.split("-").map(Number) as [number, number, number];
  const day = new Date(year, month - 1, date);
  const [ty, tm, td] = today.split("-").map(Number) as [number, number, number];
  if (key === today) return "Today";
  if (key === localDay(new Date(ty, tm - 1, td - 1).getTime())) return "Yesterday";
  return day.toLocaleDateString(undefined, {
    weekday: "long",
    day: "numeric",
    month: "long",
    ...(year === ty ? {} : { year: "numeric" }),
  });
}

function timeOfDay(at: number): string {
  return new Date(at).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}
