import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { useStore } from "../store.js";
import { ago, modelLabel } from "../lib/format.js";
import type { CliAutoUpdateStatus, HighlightNewsItem } from "../types.js";

/**
 * The top bar's "highlighted news" chip. It only exists while there is undismissed news, and the server
 * only makes news for a newly released model, so the chip appearing at all is the signal. Clicking opens
 * a small panel listing each release with a dismiss control.
 */
export function NewsChip() {
  const news = useStore((s) => s.news);
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  useDismissOnOutside(open, wrap, () => setOpen(false));
  useEffect(() => {
    if (!news.length) setOpen(false);
  }, [news.length]);
  if (!news.length) return null;

  const label = news.length === 1 ? "New model" : `${news.length} new models`;
  const names = news.map((item) => modelLabel(item.model)).join(", ");
  return (
    <div className="news" ref={wrap}>
      <button
        ref={button}
        type="button"
        className={"news-chip" + (open ? " open" : "")}
        aria-expanded={open}
        aria-haspopup="dialog"
        title={`${label}: ${names}`}
        onClick={() => setOpen((o) => !o)}
      >
        <SparkIcon />
        <span className="news-chip-label">{label}</span>
      </button>
      {open ? <NewsPanel news={news} anchor={button.current} /> : null}
    </div>
  );
}

function NewsPanel({ news, anchor }: { news: HighlightNewsItem[]; anchor: HTMLElement | null }) {
  const dismissAll = useStore((s) => s.dismissAllNews);
  const status = useStore((s) => s.settings.cliAutoUpdate);
  const autoUpdate = useStore((s) => s.settings.autoUpdateClis);
  const position = usePanelPosition(anchor);
  return (
    <div className="news-panel" role="dialog" aria-label="Highlighted news" style={position}>
      <div className="news-head">
        <span className="news-title">Highlighted news</span>
        {news.length > 1 ? (
          <button type="button" className="news-clear" onClick={dismissAll}>
            Dismiss all
          </button>
        ) : null}
      </div>
      <ul className="news-list">
        {news.map((item) => (
          <NewsRow key={item.id} item={item} />
        ))}
      </ul>
      <p className="news-foot">{runtimeLine(status, autoUpdate)}</p>
    </div>
  );
}

function NewsRow({ item }: { item: HighlightNewsItem }) {
  const dismiss = useStore((s) => s.dismissNews);
  return (
    <li className="news-item">
      <div className="news-item-main">
        <span className={"news-provider " + item.provider}>{item.provider === "claude" ? "Claude" : "Codex"}</span>
        <span className="news-model">{modelLabel(item.model)}</span>
        <code className="news-id">{item.model}</code>
        <span className="news-when">Spotted {ago(item.at)} ago · pickable in Settings → Models now</span>
      </div>
      <button type="button" className="news-dismiss" aria-label={`Dismiss ${modelLabel(item.model)}`} title="Dismiss" onClick={() => dismiss(item.id)}>
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true">
          <path d="M18 6 6 18M6 6l12 12" />
        </svg>
      </button>
    </li>
  );
}

/** Which runtimes are live, so "is it usable yet?" is answered in the same place the news is. */
function runtimeLine(status: CliAutoUpdateStatus, autoUpdate: boolean): string {
  const claude = status.claude.runtime ? `Claude Code ${status.claude.runtime}` : null;
  const codex = status.codex.installed ? `Codex CLI ${status.codex.installed}` : null;
  const versions = [claude, codex].filter(Boolean).join(" · ");
  if (!autoUpdate) return `${versions ? `${versions}. ` : ""}CLI auto-update is off in Settings.`;
  return versions ? `${versions}, kept on the latest release automatically.` : "The agent CLIs are kept on their latest release automatically.";
}

/** The panel is fixed to the viewport, under the chip and kept on-screen: the top bar clips overflow. */
function usePanelPosition(anchor: HTMLElement | null): CSSProperties {
  const [style, setStyle] = useState<CSSProperties>({ visibility: "hidden" });
  useLayoutEffect(() => {
    if (!anchor) return;
    const place = (): void => {
      const rect = anchor.getBoundingClientRect();
      const width = Math.min(360, window.innerWidth - 16);
      const left = Math.max(8, Math.min(rect.left, window.innerWidth - width - 8));
      setStyle({ top: rect.bottom + 6, left, width });
    };
    place();
    window.addEventListener("resize", place);
    return () => window.removeEventListener("resize", place);
  }, [anchor]);
  return style;
}

function useDismissOnOutside(open: boolean, ref: React.RefObject<HTMLElement | null>, close: () => void): void {
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) close();
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") close();
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, ref, close]);
}

function SparkIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z" />
      <path d="M19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8z" />
    </svg>
  );
}
