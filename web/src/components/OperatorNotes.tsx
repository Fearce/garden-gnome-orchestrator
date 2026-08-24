import { useState } from "react";
import { useStore } from "../store.js";
import { NOTE_MAX_CHARS, type OperatorNote } from "../types.js";
import { useCoarseNow } from "../lib/timing.js";
import { since } from "../lib/format.js";

/**
 * The owner's note list: short pointers the agents leave them — a branch pushed, a PR to review — that
 * they click, act on, and delete. Rendered by the Board in place of the task lanes when the header
 * toggle is on "Notes". Deliberately an inbox (one dense row per note, newest first), not a card grid:
 * the whole value is skimming it in seconds and clearing rows off it.
 */
export function OperatorNotes() {
  const notes = useStore((s) => s.notes);
  const clearNotes = useStore((s) => s.clearNotes);

  return (
    <div className="notes-view">
      <div className="notes-toolbar">
        <span className="faint mono" style={{ fontSize: 11 }}>
          {notes.length} {notes.length === 1 ? "note" : "notes"}
        </span>
        {notes.length > 1 ? (
          <button
            className="btn ghost sm"
            title="Delete every note on the list"
            onClick={() => {
              if (window.confirm(`Clear all ${notes.length} notes? They're gone for good.`)) clearNotes();
            }}
          >
            Clear all
          </button>
        ) : null}
      </div>

      <NoteComposer />

      {notes.length === 0 ? (
        <div className="empty">
          <div className="big">Nothing waiting on you</div>
          <div className="faint">
            Agents leave a line here when they push a branch or open a PR you need to review — click it, then tick it off.
          </div>
        </div>
      ) : (
        <ul className="notes-list">
          {notes.map((n) => (
            <NoteRow key={n.id} note={n} />
          ))}
        </ul>
      )}
    </div>
  );
}

function NoteRow({ note }: { note: OperatorNote }) {
  const now = useCoarseNow();
  const deleteNote = useStore((s) => s.deleteNote);
  const select = useStore((s) => s.select);
  const setBoardView = useStore((s) => s.setBoardView);
  const thread = useStore((s) => (note.threadId ? s.threads[note.threadId] : undefined));
  // The server already refuses anything but http(s), but this value reaches an `href` and originates
  // with an agent — so the render refuses it independently rather than trusting a single writer.
  const href = safeHref(note.url);
  const kind = noteKind(href);

  const openTask = () => {
    if (!thread) return;
    setBoardView("tasks");
    select(thread.id);
  };

  return (
    <li className={"note-row k-" + kind}>
      <span className="note-kind" title={KIND_LABEL[kind]} aria-label={KIND_LABEL[kind]}>
        <KindIcon kind={kind} />
      </span>

      <div className="note-main">
        {href ? (
          <a className="note-body" href={href} target="_blank" rel="noreferrer noopener" title={href}>
            {note.body}
          </a>
        ) : (
          <span className="note-body plain">{note.body}</span>
        )}
        <div className="note-meta">
          {href ? <span className="note-link mono">{prettyLink(href)}</span> : null}
          <NoteSource note={note} canOpen={!!thread} onOpen={openTask} />
          <time className="note-age" title={new Date(note.createdAt).toLocaleString()}>
            {since(now, note.createdAt)} ago
          </time>
        </div>
      </div>

      <button className="note-done" title="Handled — take it off the list" aria-label="Delete this note" onClick={() => deleteNote(note.id)}>
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="m5 12 5 5L20 7" />
        </svg>
      </button>
    </li>
  );
}

/** Who left the note, and — while its task still exists — a jump to it. */
function NoteSource({ note, canOpen, onOpen }: { note: OperatorNote; canOpen: boolean; onOpen: () => void }) {
  if (!note.threadId) return <span className="note-from">you</span>;
  const who = [note.fromName, note.fromRole].filter(Boolean).join(" · ") || "an agent";
  const repo = note.workspace ? leaf(note.workspace) : null;
  const label = repo ? `${who} · ${repo}` : who;
  if (!canOpen) {
    return (
      <span className="note-from" title={note.threadTitle ?? undefined}>
        {label}
      </span>
    );
  }
  return (
    <button className="note-from link" onClick={onOpen} title={`Open the task “${note.threadTitle ?? ""}”`}>
      {label}
    </button>
  );
}

/** The owner's own note — a link they spotted themselves and want off their mind until later. */
function NoteComposer() {
  const addNote = useStore((s) => s.addNote);
  const [body, setBody] = useState("");
  const [url, setUrl] = useState("");
  const canAdd = !!body.trim() || !!url.trim();

  const submit = () => {
    if (!canAdd) return;
    addNote(body, url);
    setBody("");
    setUrl("");
  };
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") submit();
  };

  return (
    <div className="note-compose">
      <input
        className="note-compose-body"
        value={body}
        maxLength={NOTE_MAX_CHARS}
        placeholder="Note to self — e.g. “review the menu-crawler PR before Friday”"
        onChange={(e) => setBody(e.target.value)}
        onKeyDown={onKey}
      />
      <input
        className="note-compose-url mono"
        value={url}
        placeholder="https://… (optional)"
        spellCheck={false}
        onChange={(e) => setUrl(e.target.value)}
        onKeyDown={onKey}
      />
      <button className="btn primary sm" onClick={submit} disabled={!canAdd}>
        Add
      </button>
    </div>
  );
}

type NoteKind = "pr" | "branch" | "link" | "note";

const KIND_LABEL: Record<NoteKind, string> = {
  pr: "Pull request",
  branch: "Branch",
  link: "Link",
  note: "Note",
};

/** The note's link, but only if it is one we're willing to put in an `href` — http(s) and nothing else.
 *  Anything the guard rejects renders as a plain note, so a bad link degrades to text, never to a
 *  clickable `javascript:`/`data:` payload. */
function safeHref(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    return u.protocol === "https:" || u.protocol === "http:" ? url : null;
  } catch {
    return null;
  }
}

/** What the link points at, read off the URL shape — GitHub, GitLab and Bitbucket all encode it in the
 *  path. Only used to pick an icon, so an unrecognized host simply reads as a plain link. */
function noteKind(url: string | null | undefined): NoteKind {
  if (!url) return "note";
  const path = safePath(url);
  if (/\/(pull|pull-requests|merge_requests)\//.test(path) || /\/pulls?$/.test(path)) return "pr";
  if (/\/(tree|compare|commits|branches|src)\//.test(path)) return "branch";
  return "link";
}

/** The link without its scheme or a `www.` — long enough to recognize, short enough for one line. */
function prettyLink(url: string): string {
  try {
    const u = new URL(url);
    return (u.host.replace(/^www\./, "") + u.pathname + u.search).replace(/\/$/, "");
  } catch {
    return url;
  }
}

function safePath(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return "";
  }
}

function leaf(path: string): string {
  const norm = path.replace(/[\\/]+$/, "");
  const i = Math.max(norm.lastIndexOf("\\"), norm.lastIndexOf("/"));
  return i < 0 ? norm : norm.slice(i + 1);
}

function KindIcon({ kind }: { kind: NoteKind }) {
  const common = { width: 14, height: 14, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round" as const, strokeLinejoin: "round" as const, "aria-hidden": true };
  if (kind === "pr") {
    return (
      <svg {...common}>
        <circle cx="6" cy="6" r="3" />
        <circle cx="18" cy="18" r="3" />
        <path d="M13 6h3a2 2 0 0 1 2 2v7" />
        <path d="m10 9-3-3 3-3" />
        <path d="M6 9v9" />
      </svg>
    );
  }
  if (kind === "branch") {
    return (
      <svg {...common}>
        <line x1="6" y1="3" x2="6" y2="15" />
        <circle cx="18" cy="6" r="3" />
        <circle cx="6" cy="18" r="3" />
        <path d="M18 9a9 9 0 0 1-9 9" />
      </svg>
    );
  }
  if (kind === "link") {
    return (
      <svg {...common}>
        <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
        <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
      </svg>
    );
  }
  return (
    <svg {...common}>
      <path d="M15 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h9l7-7V5a2 2 0 0 0-2-2z" />
      <path d="M14 21v-5a2 2 0 0 1 2-2h5" />
    </svg>
  );
}
