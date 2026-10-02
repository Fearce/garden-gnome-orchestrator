import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { useStore } from "../store.js";
import { ago, modelLabel } from "../lib/format.js";
import type { CliAutoUpdateStatus, HighlightNewsItem } from "../types.js";

/**
 * The top bar's "highlighted news" chip. It only exists while there is unseen news, and the server only
 * makes news for a newly released model, so the chip appearing at all is the signal. Opening it is the
 * acknowledgement: the items it shows are dismissed server-side right then (so they stay gone across
 * reloads and browsers), the chip disappears immediately, and the panel keeps listing them until it
 * closes. A model announced while the panel is open was never shown, so it brings the chip back once
 * the panel closes.
 */
export function NewsChip() {
  const news = useStore((s) => s.news);
  const dismiss = useStore((s) => s.dismissNews);
  // What the open panel lists: the items as they were when the chip was opened, already dismissed.
  const [opened, setOpened] = useState<{ news: HighlightNewsItem[]; anchor: NewsAnchor } | null>(null);
  const wrap = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const close = useCallback(() => setOpened(null), []);
  useDismissOnOutside(opened !== null, wrap, close);
  if (!news.length && !opened) return null;

  const open = (): void => {
    if (!button.current) return;
    const { left, bottom } = button.current.getBoundingClientRect();
    setOpened({ news, anchor: { left, bottom } });
    for (const item of news) dismiss(item.id);
  };
  const label = news.length === 1 ? "New model" : `${news.length} new models`;
  const names = news.map((item) => modelLabel(item.model)).join(", ");
  return (
    <div className="news" ref={wrap}>
      {!opened ? (
        <button
          ref={button}
          type="button"
          className="news-chip"
          aria-expanded={false}
          aria-haspopup="dialog"
          title={`${label}: ${names}`}
          onClick={open}
        >
          <SparkIcon />
          <span className="news-chip-label">{label}</span>
        </button>
      ) : null}
      {opened ? <NewsPanel news={opened.news} anchor={opened.anchor} /> : null}
    </div>
  );
}

type NewsAnchor = Pick<DOMRect, "left" | "bottom">;

function NewsPanel({ news, anchor }: { news: HighlightNewsItem[]; anchor: NewsAnchor }) {
  const status = useStore((s) => s.settings.cliAutoUpdate);
  const autoUpdate = useStore((s) => s.settings.autoUpdateClis);
  const position = usePanelPosition(anchor);
  return (
    <div className="news-panel" role="dialog" aria-label="Highlighted news" style={position}>
      <div className="news-head">
        <span className="news-title">Highlighted news</span>
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
  return (
    <li className="news-item">
      <span className={"news-provider " + item.provider}>{item.provider === "claude" ? "Claude" : "Codex"}</span>
      <span className="news-model">{modelLabel(item.model)}</span>
      <code className="news-id">{item.model}</code>
      <span className="news-when">Spotted {ago(item.at)} ago · pickable in Settings → Subscriptions now</span>
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
function usePanelPosition(anchor: NewsAnchor): CSSProperties {
  const [style, setStyle] = useState<CSSProperties>({ visibility: "hidden" });
  useLayoutEffect(() => {
    const place = (): void => {
      const width = Math.min(360, window.innerWidth - 16);
      const left = Math.max(8, Math.min(anchor.left, window.innerWidth - width - 8));
      setStyle({ top: anchor.bottom + 6, left, width });
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
