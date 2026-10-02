import { useEffect, useState } from "react";
import { useStore } from "../store.js";
import { availabilityLabel, formatDeadline, timeLeft } from "../lib/directorSharing.js";

/**
 * Shown under the Director's header while this console uses capacity another office member shares:
 * whose it is, until when, and whether it can answer right now. One click goes back to this console's
 * own subscriptions; nothing switches back automatically.
 */
export function SharedDirectorStrip() {
  const selection = useStore((s) => s.directorSharing.selection);
  const useShared = useStore((s) => s.useSharedDirector);
  const pending = useStore((s) => s.directorSharePending?.action === "director.share.use");
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!selection) return;
    const id = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(id);
  }, [selection]);
  if (!selection) return null;
  // The server decides availability; the clock only keeps the countdown honest between broadcasts.
  const state = selection.expiresAt <= now ? "expired" : selection.availability;
  const ok = state === "available";
  return (
    <div className={"shared-director-strip" + (ok ? "" : " warn")} role="status">
      <div className="shared-director-text">
        <strong>Shared by {selection.donorName}</strong>
        <span className="dim">
          {" "}on {selection.instanceName} · {selection.providerLabel} · {selection.model}
        </span>
        <div className="dim shared-director-meta">
          <span className={"share-chip " + (ok ? "on" : "off")}>{availabilityLabel(state)}</span>{" "}
          {state === "expired"
            ? `Expired ${formatDeadline(selection.expiresAt)}.`
            : `Until ${formatDeadline(selection.expiresAt)} (${timeLeft(selection.expiresAt, now)}).`}
          {!ok && state !== "expired" ? ` ${selection.detail}` : ""}
        </div>
      </div>
      <button type="button" className="btn sm" disabled={pending} onClick={() => useShared("", null)}>
        Use my own
      </button>
    </div>
  );
}
