import { useEffect, useState } from "react";
import { useStore } from "../store.js";

// The delivery line under an owner message the console is still holding (store.ts `outboundMessages`).
// Every state says only what the console actually knows: "Sending…" while no reply has come back,
// "Waiting for connection" while the socket is down (the message is queued and replays on reconnect),
// "Received" once GGO has stored a task instruction it is still applying, "Not delivered" on a refusal.

/** How long a reply may take before the owner is offered an immediate replay. The automatic one waits
 *  a full minute, which is the right default and far too long to stare at a spinner without a choice. */
const RETRY_OFFER_MS = 15_000;

export function DeliveryReceipt({ id }: { id: string }) {
  const message = useStore((s) => s.outboundMessages.find((m) => m.id === id));
  const connected = useStore((s) => s.connected);
  const retry = useStore((s) => s.retryOutbound);
  const dismiss = useStore((s) => s.dismissOutbound);
  const [retriedAt, setRetriedAt] = useState(0);
  const slow = useElapsed(message?.status === "sending" ? Math.max(message.createdAt, retriedAt) : null, RETRY_OFFER_MS);
  if (!message) return null;

  if (message.status === "failed") {
    return (
      <span className="delivery-receipt failed" role="status" title={message.error}>
        <span aria-hidden="true">!</span>
        Not delivered
        {message.error ? <span className="delivery-reason">{message.error}</span> : null}
        {message.resendable ? (
          <button type="button" className="delivery-action" onClick={() => retry(id)}>
            Send again
          </button>
        ) : null}
        <button type="button" className="delivery-action" onClick={() => dismiss(id)}>
          Dismiss
        </button>
      </span>
    );
  }
  if (message.status === "accepted") {
    return (
      <span className="delivery-receipt accepted" role="status" title="GGO has stored this instruction and is delivering it to the task.">
        <svg className="delivery-check" viewBox="0 0 10 10" aria-hidden="true">
          <path d="M2 5.3 4.1 7.3 8 2.9" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        Received
      </span>
    );
  }
  if (!connected) {
    return (
      <span className="delivery-receipt sending offline" role="status" title="The console is reconnecting. This message is queued and is sent the moment the connection is back.">
        <span className="delivery-spinner" aria-hidden="true" />
        Waiting for connection
      </span>
    );
  }
  return (
    <span className="delivery-receipt sending" role="status">
      <span className="delivery-spinner" aria-hidden="true" />
      Sending…
      {slow ? (
        <button
          type="button"
          className="delivery-action"
          title="Send it again now. It keeps the same delivery id, so GGO can never apply it twice."
          onClick={() => {
            setRetriedAt(Date.now());
            retry(id);
          }}
        >
          Retry now
        </button>
      ) : null}
    </span>
  );
}

/** True once `thresholdMs` has passed since `since`; re-renders exactly once, at that moment. */
function useElapsed(since: number | null, thresholdMs: number): boolean {
  const [now, setNow] = useState(() => Date.now());
  const due = since == null ? null : since + thresholdMs;
  useEffect(() => {
    if (due == null) return;
    const wait = due - Date.now();
    if (wait <= 0) return;
    const timer = setTimeout(() => setNow(Date.now()), wait);
    return () => clearTimeout(timer);
  }, [due]);
  return due != null && now >= due;
}
