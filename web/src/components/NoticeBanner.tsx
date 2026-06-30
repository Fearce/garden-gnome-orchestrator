import { useStore } from "../store.js";

/** A dismissible, app-level warning banner for server-pushed `notice` events (currently the token-safety
 *  auto-stop). It guarantees the message is seen even with desktop notifications off; dismissing clears it.
 *  Only the most recent notice is held, so a later one replaces an undismissed banner rather than stacking. */
export function NoticeBanner() {
  const notice = useStore((s) => s.notice);
  const clearNotice = useStore((s) => s.clearNotice);
  if (!notice) return null;
  return (
    <div className="notice-banner" role="alert">
      <span className="notice-icon" aria-hidden="true">
        ⚠
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
