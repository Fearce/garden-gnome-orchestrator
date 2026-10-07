import { useEffect, useMemo, useRef, useState } from "react";
import { apiUrl } from "../lib/base.js";
import { useStore } from "../store.js";
import type { Question } from "../types.js";
import { Markdown } from "./Markdown.js";

export function QuestionModal() {
  const questions = useStore((s) => s.questions);
  const threads = useStore((s) => s.threads);
  const answer = useStore((s) => s.answer);
  const q = useMemo(() => questions.find((x) => x.threadId === null) ?? questions[0], [questions]);
  if (!q) return null;
  const context = q.threadId ? threads[q.threadId]?.title ?? "Task" : "Director";
  if (q.kind === "repo") return <RepoQuestionCard key={q.id} q={q} context={context} onAnswer={(a) => answer(q.id, a)} />;
  return <QuestionCard key={q.id} q={q} context={context} onAnswer={(a) => answer(q.id, a)} />;
}

interface RepoRow {
  path: string;
  label: string;
  suggested: boolean;
}

// One row per workspace whatever its spelling; Windows paths compare case-insensitively, POSIX ones exactly.
const repoKey = (path: string) => {
  const trimmed = path.replace(/[/\\]+$/, "");
  return /^[A-Za-z]:|\\/.test(trimmed) ? trimmed.replace(/\//g, "\\").toLowerCase() : trimmed;
};

/** A searchable repo picker for an AUTO repo question. The suggested candidates come first; typing filters
 *  them and searches every verified workspace on the server, so a repo is chosen by name, never typed out
 *  as a path. The search box drives the list as a combobox: ↑/↓ move, Enter picks (or toggles, when
 *  several repos may be chosen), and the answer is the chosen path(s), one per line. */
export function RepoQuestionCard({ q, context, onAnswer }: { q: Question; context: string; onAnswer: (a: string) => void }) {
  const [query, setQuery] = useState("");
  const [found, setFound] = useState<RepoRow[]>([]);
  const [active, setActive] = useState(0);
  const [picked, setPicked] = useState<string[]>([]);
  const listRef = useRef<HTMLUListElement>(null);

  const suggested = useMemo<RepoRow[]>(
    () => q.options.filter((o) => o.description).map((o) => ({ path: o.description!, label: o.label, suggested: true })),
    [q.options],
  );

  useEffect(() => {
    const term = query.trim();
    if (!term) {
      setFound([]);
      return;
    }
    let live = true;
    const timer = setTimeout(() => {
      fetch(apiUrl(`/api/repos/search?q=${encodeURIComponent(term)}`))
        .then((r) => (r.ok ? (r.json() as Promise<{ repos: Array<{ path: string; label: string }> }>) : { repos: [] }))
        .then((d) => live && setFound(d.repos.map((r) => ({ path: r.path, label: r.label, suggested: false }))))
        .catch(() => live && setFound([]));
    }, 150);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [query]);

  const rows = useMemo(() => {
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    const matches = (row: RepoRow) => terms.every((t) => row.path.toLowerCase().includes(t) || row.label.toLowerCase().includes(t));
    const seen = new Set<string>();
    return [...suggested.filter(matches), ...found.filter(matches)].filter((row) => {
      const key = repoKey(row.path);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }, [suggested, found, query]);

  useEffect(() => setActive((i) => Math.max(0, Math.min(i, rows.length - 1))), [rows.length]);
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-index="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [active]);

  const choose = (row: RepoRow) => {
    if (!q.multiSelect) {
      onAnswer(row.path);
      return;
    }
    setPicked((list) => (list.some((p) => repoKey(p) === repoKey(row.path)) ? list.filter((p) => repoKey(p) !== repoKey(row.path)) : [...list, row.path]));
  };
  const isPicked = (row: RepoRow) => picked.some((p) => repoKey(p) === repoKey(row.path));

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((i) => Math.max(0, Math.min(i + 1, rows.length - 1)));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      if ((e.metaKey || e.ctrlKey) && q.multiSelect && picked.length) onAnswer(picked.join("\n"));
      else if (rows[active]) choose(rows[active]);
    }
  };

  const listId = `repo-pick-${q.id}`;
  return (
    <div className="scrim">
      <div className="modal repo-question" role="dialog" aria-modal="true" aria-labelledby={`${listId}-title`}>
        <div className="m-head">
          <div className="q-context">{q.threadId ? `${context} needs your input` : context}</div>
          <span className="chip">{q.header}</span>
          <div id={`${listId}-title`}>
            <Markdown className="q-question" text={q.question} />
          </div>
        </div>
        <div className="m-body">
          <div className="repo-search">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <circle cx="11" cy="11" r="7" />
              <path d="m20 20-3.2-3.2" />
            </svg>
            <input
              autoFocus
              type="text"
              role="combobox"
              aria-expanded="true"
              aria-controls={listId}
              aria-activedescendant={rows[active] ? `${listId}-${active}` : undefined}
              aria-label="Search repositories"
              placeholder="Search repos by name or path…"
              value={query}
              spellCheck={false}
              autoComplete="off"
              onChange={(e) => {
                setQuery(e.target.value);
                setActive(0);
              }}
              onKeyDown={onKeyDown}
            />
          </div>
          <ul id={listId} ref={listRef} className="repo-list" role="listbox" aria-multiselectable={q.multiSelect || undefined} aria-label="Repositories">
            {rows.map((row, i) => (
              <li
                key={row.path}
                id={`${listId}-${i}`}
                data-index={i}
                role="option"
                aria-selected={q.multiSelect ? isPicked(row) : i === active}
                className={"repo-row" + (i === active ? " active" : "") + (isPicked(row) ? " picked" : "")}
                onMouseEnter={() => setActive(i)}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => choose(row)}
              >
                {q.multiSelect && <span className="repo-check" aria-hidden="true" />}
                <span className="repo-row-text">
                  <span className="repo-row-name">{row.label}</span>
                  <span className="repo-row-path">{row.path}</span>
                </span>
                {row.suggested && <span className="repo-row-tag">suggested</span>}
              </li>
            ))}
            {!rows.length && <li className="repo-empty">{query.trim() ? "No repo matches that search." : "No suggestions. Search for the repo by name."}</li>}
          </ul>
          <div className="repo-foot">
            <span className="repo-hint">{q.multiSelect ? "↑↓ move · Enter selects · Ctrl+Enter dispatches" : "↑↓ move · Enter picks"}</span>
            {q.multiSelect && (
              <button className="btn primary" disabled={!picked.length} onClick={() => onAnswer(picked.join("\n"))}>
                {picked.length > 1 ? `Use ${picked.length} repos` : "Use repo"}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function QuestionCard({ q, context, onAnswer }: { q: Question; context: string; onAnswer: (a: string) => void }) {
  const [selected, setSelected] = useState<string[]>([]);
  const [custom, setCustom] = useState("");
  const [showCustom, setShowCustom] = useState(q.options.length === 0);

  const toggle = (label: string) => {
    if (q.multiSelect) {
      setSelected((s) => (s.includes(label) ? s.filter((x) => x !== label) : [...s, label]));
    } else {
      onAnswer(label);
    }
  };

  const submit = () => {
    const parts = [...selected];
    const c = custom.trim();
    if (c) parts.push(c);
    if (parts.length) onAnswer(parts.join(", "));
  };

  const canSubmit = selected.length > 0 || custom.trim().length > 0;
  const showFooter = q.multiSelect || showCustom;

  return (
    <div className="scrim">
      <div className="modal">
        <div className="m-head">
          <div className="q-context">{q.threadId ? `${context} needs your input` : context}</div>
          <span className="chip">{q.header}</span>
          <Markdown className="q-question" text={q.question} />
        </div>
        <div className="m-body">
          {q.options.map((o) => (
            <button
              key={o.label}
              className={"opt" + (selected.includes(o.label) ? " sel" : "")}
              onClick={() => toggle(o.label)}
            >
              <div className="lbl">{o.label}</div>
              {o.description ? <div className="desc">{o.description}</div> : null}
            </button>
          ))}

          {showCustom ? (
            <textarea
              autoFocus
              value={custom}
              placeholder={q.options.length ? "Or type your own answer…" : "Type your answer…"}
              onChange={(e) => setCustom(e.target.value)}
              onKeyDown={(e) => {
                if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                  e.preventDefault();
                  submit();
                }
              }}
            />
          ) : (
            <button className="btn ghost sm" style={{ alignSelf: "flex-start" }} onClick={() => setShowCustom(true)}>
              Other…
            </button>
          )}

          {showFooter ? (
            <div className="m-foot">
              <button className="btn primary" onClick={submit} disabled={!canSubmit}>
                Submit
              </button>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
