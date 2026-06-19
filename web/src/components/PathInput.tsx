import { useEffect, useRef, useState } from "react";

interface Entry {
  name: string;
  path: string;
  isDir: boolean;
}

/** Shell-style path completion for the dispatch workspace field. As you type an absolute path it
 *  queries GET /api/fs/complete for child directories matching the fragment after the last separator
 *  and shows them in a small dropdown: ↑/↓ to move, Enter/Tab to accept (a directory appends its
 *  segment + separator so you can keep walking down), click to accept, Esc to dismiss. Requests are
 *  debounced, except a freshly-typed separator fires immediately (you've committed a segment). */
export function PathInput({
  value,
  onChange,
  className,
  placeholder,
  title,
}: {
  value: string;
  onChange: (v: string) => void;
  className?: string;
  placeholder?: string;
  title?: string;
}) {
  const [entries, setEntries] = useState<Entry[]>([]);
  const [open, setOpen] = useState(false);
  const [hi, setHi] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const seq = useRef(0); // guards against an earlier slow request overwriting a newer one

  const sepFor = (p: string) => (p.includes("/") && !p.includes("\\") ? "/" : "\\");

  const run = (path: string) => {
    const mine = ++seq.current;
    fetch(`/api/fs/complete?path=${encodeURIComponent(path)}`)
      .then((r) => (r.ok ? (r.json() as Promise<{ entries: Entry[] }>) : { entries: [] }))
      .then((d) => {
        if (mine !== seq.current) return; // a newer keystroke already superseded this fetch
        setEntries(d.entries);
        setHi(0);
        setOpen(d.entries.length > 0);
      })
      .catch(() => {
        if (mine === seq.current) setOpen(false);
      });
  };

  const schedule = (path: string) => {
    if (timer.current) clearTimeout(timer.current);
    const trimmed = path.trim();
    if (!trimmed) {
      seq.current++; // cancel any in-flight result
      setEntries([]);
      setOpen(false);
      return;
    }
    // A just-typed separator means a segment is committed — list its children immediately; otherwise
    // debounce so we don't fire on every character mid-segment.
    const immediate = trimmed.endsWith("\\") || trimmed.endsWith("/");
    if (immediate) run(trimmed);
    else timer.current = setTimeout(() => run(trimmed), 120);
  };

  useEffect(() => () => void (timer.current && clearTimeout(timer.current)), []);

  const change = (v: string) => {
    onChange(v);
    schedule(v);
  };

  const accept = (e: Entry) => {
    // Every entry is a directory; append the separator so the next query lists its children and the
    // user can keep walking down — exactly like tab-completion in a shell.
    const next = e.isDir ? e.path + sepFor(value || e.path) : e.path;
    onChange(next);
    run(next);
    inputRef.current?.focus();
  };

  const onKeyDown = (ev: React.KeyboardEvent<HTMLInputElement>) => {
    if (!open || entries.length === 0) {
      if (ev.key === "Escape") setOpen(false);
      return;
    }
    if (ev.key === "ArrowDown") {
      ev.preventDefault();
      setHi((h) => Math.min(h + 1, entries.length - 1));
    } else if (ev.key === "ArrowUp") {
      ev.preventDefault();
      setHi((h) => Math.max(h - 1, 0));
    } else if (ev.key === "Enter" || ev.key === "Tab") {
      const pick = entries[hi];
      if (pick) {
        ev.preventDefault();
        accept(pick);
      }
    } else if (ev.key === "Escape") {
      ev.preventDefault();
      ev.stopPropagation();
      setOpen(false);
    }
  };

  return (
    <div className="ws-wrap">
      <input
        ref={inputRef}
        className={className}
        value={value}
        placeholder={placeholder}
        title={title}
        autoComplete="off"
        spellCheck={false}
        onChange={(e) => change(e.target.value)}
        onKeyDown={onKeyDown}
        onFocus={() => entries.length > 0 && setOpen(true)}
        // Close on blur, but defer so a suggestion's mousedown/click lands first.
        onBlur={() => setTimeout(() => setOpen(false), 120)}
      />
      {open && entries.length > 0 && (
        <ul className="ws-menu" role="listbox">
          {entries.map((e, i) => (
            <li
              key={e.path}
              role="option"
              aria-selected={i === hi}
              className={"ws-opt" + (i === hi ? " hi" : "")}
              onMouseEnter={() => setHi(i)}
              // mousedown (not click) so it fires before the input's blur closes the menu.
              onMouseDown={(ev) => {
                ev.preventDefault();
                accept(e);
              }}
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" />
              </svg>
              <span className="nm">{e.name}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
