import { useStore } from "../store.js";

/** A dismissible, app-level banner for server-pushed `notice` events (token-safety auto-stop / token-reset
 *  auto-resume). It guarantees the message is seen even with desktop notifications off; dismissing clears it.
 *  Only the most recent notice is held, so a later one replaces an undismissed banner rather than stacking.
 *  `level` sets the tone: warn = amber alert, info = neutral green (a recovery/resume). */
export function NoticeBanner() {
  const notice = useStore((s) => s.notice);
  const clearNotice = useStore((s) => s.clearNotice);
  if (!notice) return null;
  const info = notice.level === "info";
  return (
    <div className={`notice-banner${info ? " info" : ""}`} role="alert">
      <span className="notice-icon" aria-hidden="true">
        {info ? "↺" : "⚠"}
      </span>
      <div className="notice-text">
        <div className="notice-title">{notice.title}</div>
        <div className="notice-message">{notice.message}</div>
      </div>
      <button className="notice-x" aria-label="Dismiss notification" onClick={clearNotice}>
        ✕
      </button>
    </div>
  );
}
