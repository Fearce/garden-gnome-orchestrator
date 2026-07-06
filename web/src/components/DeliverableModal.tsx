import { useEffect, useMemo, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import hljs from "highlight.js/lib/common";
import type { Finding } from "../types.js";
import { apiUrl } from "../lib/base.js";
import { FileIcon, fileKindOf, basenameOf, type FileKind } from "./FileIcon.js";
import { useResizableModal } from "./useResizableModal.js";

// The deliverable preview modal and its per-type renderers. Split into its own module so the heavy
// markdown/highlight.js deps load lazily (on first View) instead of weighing down the main bundle.

export default function DeliverableModal({ d, onClose }: { d: Finding; onClose: () => void }) {
  const path = d.path ?? "";
  const name = basenameOf(path);
  const kind = fileKindOf(name);
  const { ref, style, startResize, reset } = useResizableModal();
  return (
    <div className="scrim" onClick={onClose}>
      <div className="modal deliverable" ref={ref} style={style} onClick={(e) => e.stopPropagation()}>
        <div className="m-head dl-modal-head">
          <div className="dl-modal-title">
            <FileIcon kind={kind} size={20} />
            <div>
              <h3>{d.label ?? name}</h3>
              <div className="dl-modal-sub" title={path}>
                {name}
              </div>
            </div>
          </div>
          <div className="dl-modal-actions">
            <a className="btn ghost sm" href={apiUrl(`/api/deliverable/${d.id}?download=1`)} download={name}>
              Download
            </a>
            <button className="btn ghost sm" onClick={onClose} aria-label="Close">
              ✕
            </button>
          </div>
        </div>
        <div className="deliverable-body">
          <DeliverablePreview id={d.id} name={name} kind={kind} />
        </div>
        <div className="dl-resize dl-resize-r" onPointerDown={(e) => startResize(e, 1, 0)} title="Drag to resize" />
        <div className="dl-resize dl-resize-b" onPointerDown={(e) => startResize(e, 0, 1)} title="Drag to resize" />
        <div
          className="dl-resize dl-resize-br"
          onPointerDown={(e) => startResize(e, 1, 1)}
          onDoubleClick={reset}
          title="Drag to resize · double-click to reset"
        />
      </div>
    </div>
  );
}

function DeliverablePreview({ id, name, kind }: { id: string; name: string; kind: FileKind }) {
  const url = apiUrl(`/api/deliverable/${id}`);

  // Images and PDFs render straight from the URL — no text fetch needed.
  if (kind === "image") {
    return (
      <div className="dl-image-wrap">
        <img className="dl-image" src={url} alt={name} />
      </div>
    );
  }
  if (kind === "pdf") {
    return <iframe className="dl-pdf" src={url} title={name} />;
  }
  return <TextPreview url={url} name={name} kind={kind} />;
}

function TextPreview({ url, name, kind }: { url: string; name: string; kind: FileKind }) {
  const [state, setState] = useState<{ text: string | null; error: string | null; loading: boolean }>({
    text: null,
    error: null,
    loading: true,
  });

  useEffect(() => {
    let alive = true;
    setState({ text: null, error: null, loading: true });
    fetch(url)
      .then(async (r) => {
        if (!r.ok) throw new Error(`server responded ${r.status}`);
        return r.text();
      })
      .then((text) => {
        if (alive) setState({ text, error: null, loading: false });
      })
      .catch((e: unknown) => {
        if (alive) setState({ text: null, error: e instanceof Error ? e.message : "failed to load", loading: false });
      });
    return () => {
      alive = false;
    };
  }, [url]);

  if (state.loading) return <div className="dl-status faint">loading…</div>;
  if (state.error) return <div className="dl-status err">Couldn’t load this file: {state.error}</div>;
  const text = state.text ?? "";

  if (kind === "markdown") {
    return (
      <div className="md-preview">
        <ReactMarkdown remarkPlugins={[remarkGfm]}>{text}</ReactMarkdown>
      </div>
    );
  }
  if (kind === "csv") return <CsvTable text={text} name={name} />;
  if (kind === "json") return <Highlighted text={prettyJson(text)} />;
  if (kind === "code") return <Highlighted text={text} />;
  // Plain text / logs: monospace, no highlighting.
  return <pre className="dl-pre">{text}</pre>;
}

/** Pretty-print JSON when it parses; otherwise show it verbatim (still highlighted as JSON-ish). */
function prettyJson(text: string): string {
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}

function Highlighted({ text }: { text: string }) {
  const html = useMemo(() => hljs.highlightAuto(text).value, [text]);
  return (
    <pre className="dl-pre">
      <code className="hljs" dangerouslySetInnerHTML={{ __html: html }} />
    </pre>
  );
}

const CSV_ROW_CAP = 2000;

function CsvTable({ text, name }: { text: string; name: string }) {
  const rows = useMemo(() => parseDelimited(text, name.toLowerCase().endsWith(".tsv") ? "\t" : ","), [text, name]);
  if (!rows.length) return <pre className="dl-pre">{text}</pre>;
  const [header, ...body] = rows;
  const shown = body.slice(0, CSV_ROW_CAP);
  const truncated = body.length - shown.length;
  return (
    <div className="csv-wrap">
      <table className="csv-table">
        <thead>
          <tr>
            {header!.map((cell, i) => (
              <th key={i}>{cell}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {shown.map((row, r) => (
            <tr key={r}>
              {header!.map((_, c) => (
                <td key={c}>{row[c] ?? ""}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {truncated > 0 ? <div className="dl-status faint">+{truncated.toLocaleString()} more rows (download for the full file)</div> : null}
    </div>
  );
}

/** Minimal RFC-4180-ish parser: handles quoted fields, escaped quotes ("") and CRLF/CR/LF newlines. */
function parseDelimited(text: string, delim: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
      continue;
    }
    if (c === '"') {
      inQuotes = true;
    } else if (c === delim) {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else {
      field += c;
    }
  }
  if (field.length || row.length) {
    row.push(field);
    rows.push(row);
  }
  // Drop a trailing empty row from a final newline.
  if (rows.length && rows[rows.length - 1]!.length === 1 && rows[rows.length - 1]![0] === "") rows.pop();
  return rows;
}
