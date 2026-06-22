import { useEffect, useState } from "react";
import { apiUrl } from "../lib/base.js";

interface LsResponse {
  path: string;
  parent: string | null;
  dirs: { name: string; path: string }[];
}

/** Modal directory browser for the dispatch form. Walks the real on-disk filesystem
 *  via GET /api/fs/ls (auth-gated, dirs-only) so the repo-path hint can be picked
 *  instead of typed. Select returns the currently-open folder; the field stays editable. */
export function FolderPicker({
  initialPath,
  onSelect,
  onClose,
}: {
  initialPath: string;
  onSelect: (path: string) => void;
  onClose: () => void;
}) {
  const [path, setPath] = useState(initialPath.trim() || "C:\\");
  const [data, setData] = useState<LsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError(null);
    fetch(apiUrl(`/api/fs/ls?path=${encodeURIComponent(path)}`))
      .then(async (r) => {
        if (!r.ok) throw new Error((await r.json().catch(() => null))?.error || `error ${r.status}`);
        return (await r.json()) as LsResponse;
      })
      .then((d) => {
        if (!alive) return;
        setData(d);
        // Normalize to the server's canonical spelling (handles trailing slashes etc.).
        if (d.path !== path) setPath(d.path);
      })
      .catch((e: Error) => alive && setError(e.message))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [path]);

  const current = data?.path ?? path;

  return (
    <div className="scrim" onClick={onClose}>
      <div className="modal folder-picker" onClick={(e) => e.stopPropagation()}>
        <div className="m-head">
          <div className="q-context">Pick a repo folder</div>
          <div className="fp-crumb mono">{current}</div>
        </div>
        <div className="m-body">
          <div className="fp-list">
            {data?.parent !== null && data?.parent !== undefined && (
              <button className="fp-row up" onClick={() => setPath(data.parent!)}>
                <FolderIcon up />
                <span className="nm">..</span>
              </button>
            )}
            {data?.dirs.map((d) => (
              <button key={d.path} className="fp-row" onClick={() => setPath(d.path)}>
                <FolderIcon />
                <span className="nm">{d.name}</span>
              </button>
            ))}
            {!loading && !error && data && data.dirs.length === 0 && (
              <div className="fp-empty faint">No subfolders here.</div>
            )}
            {loading && <div className="fp-empty faint">Loading…</div>}
            {error && <div className="fp-empty fp-err">{error}</div>}
          </div>
        </div>
        <div className="m-foot">
          <button className="btn ghost" onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn primary"
            onClick={() => {
              onSelect(current);
              onClose();
            }}
          >
            Select this folder
          </button>
        </div>
      </div>
    </div>
  );
}

function FolderIcon({ up }: { up?: boolean }) {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" />
      {up && <path d="m9 13 3-3 3 3" />}
    </svg>
  );
}
