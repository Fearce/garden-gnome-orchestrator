import { useEffect, useMemo, useState } from "react";
import { useStore } from "../store.js";
import { newerThan, usePatchNotes, type PatchNote, type PatchNoteKind } from "../lib/patchNotes.js";
import "./patchNotes.css";

/**
 * Patch notes: what changed in this install, newest first, read from its own git history. Features,
 * fixes and speed-ups lead; docs, tests and chores stay folded behind a toggle because nobody using the
 * console acts on them. Commits the upstream has but this checkout does not are listed on top as the
 * next update, so the Update badge's "N new commits" finally says what those commits are.
 */
export function PatchNotes() {
  const { entries, upcoming, running, hasMore, loading, error, seenSha, load, loadOlder, markSeen } = usePatchNotes();
  const [filter, setFilter] = useState<Filter>("all");
  const [showInternal, setShowInternal] = useState(false);
  // Snapshot what was unseen when the area opened, so this visit still marks it after it is recorded as seen.
  const [seenAtOpen] = useState(seenSha);

  useEffect(() => {
    void load().then(markSeen);
  }, [load, markSeen]);

  const newCount = newerThan(entries, seenAtOpen);
  const liveCut = running ? entries.findIndex((e) => e.sha === running) : -1;
  const annotated = useMemo(
    () => entries.map((note, i) => ({ note, isNew: i < newCount, notLive: i < liveCut })),
    [entries, newCount, liveCut],
  );
  const visible = annotated.filter(({ note }) => shows(note, filter, showInternal));
  const internalCount = entries.filter((e) => e.kind === "internal").length;

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
        <DayGroups rows={visible} />
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

function DayGroups({ rows }: { rows: Row[] }) {
  if (rows.length === 0) return <div className="pn-none faint">Nothing in this filter among the loaded changes.</div>;
  return (
    <>
      {groupByDay(rows).map((group) => (
        <section className="pn-day" key={group.key}>
          <h3 className="pn-day-head">{group.label}</h3>
          <ul className="pn-list">
            {group.rows.map((row) => (
              <NoteRow key={row.note.sha} {...row} />
            ))}
          </ul>
        </section>
      ))}
    </>
  );
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
            <span className="pn-flag pending" title="Committed after the running server was built. It goes live with the next deploy or restart.">
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

function groupByDay(rows: Row[]): { key: string; label: string; rows: Row[] }[] {
  const groups: { key: string; label: string; rows: Row[] }[] = [];
  for (const row of rows) {
    const key = new Date(row.note.at).toDateString();
    const last = groups.at(-1);
    if (last?.key === key) last.rows.push(row);
    else groups.push({ key, label: dayLabel(row.note.at), rows: [row] });
  }
  return groups;
}

function dayLabel(at: number): string {
  const day = new Date(at);
  const today = new Date();
  const yesterday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1);
  if (day.toDateString() === today.toDateString()) return "Today";
  if (day.toDateString() === yesterday.toDateString()) return "Yesterday";
  return day.toLocaleDateString(undefined, {
    weekday: "long",
    day: "numeric",
    month: "long",
    ...(day.getFullYear() === today.getFullYear() ? {} : { year: "numeric" }),
  });
}

function timeOfDay(at: number): string {
  return new Date(at).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}
