import type { InjectionReceipt, InjectionReceiptStatus, Role } from "../types.js";
import { clock, gnomeRoleColor } from "../lib/format.js";

// The gnome checkmark under an injected owner message: one small hat per recipient. The hat fills in
// the recipient's role colour once its provider proves the message entered the agent's context, and
// gains the tick only when the agent answered with that input's unique `ACK IR-…:` token. The server
// owns every transition (server/src/orchestrator/injectionReceipts.ts); this only draws them.

const BEARD = "oklch(0.95 0.02 90)"; // the gnome's beard and pom, same off-white as Gnome.tsx

const RECIPIENT_LABEL: Record<InjectionReceipt["recipient"], string> = {
  implementor: "Implementor",
  qa: "QA",
  reviewer: "Reviewer",
  planner: "Planner",
};

const STATUS_WORD: Record<InjectionReceiptStatus, string> = {
  pending: "waiting",
  sent: "sent",
  delivered: "delivered",
  read: "read",
  failed: "not delivered",
};

/** What each provider's delivery proof actually is, so the tooltip never claims more than it saw. */
function deliveryProof(provider: string | null): string {
  switch (provider) {
    case "claude":
    case "zai":
      return `the ${provider === "zai" ? "z.ai" : "Claude"} CLI confirmed the turn that consumed it`;
    case "codex":
    case "grok":
      return `the ${provider === "codex" ? "Codex" : "Grok"} turn carrying it produced model output`;
    case "free":
      return "a model call over it completed";
    default:
      return "its provider confirmed it entered the context";
  }
}

function at(ts: number | null): string {
  return ts ? ` at ${clock(ts)}` : "";
}

/** The concise tooltip and accessible label for one recipient's receipt. */
export function receiptTitle(r: InjectionReceipt, name: string): string {
  const who = `${name} (${RECIPIENT_LABEL[r.recipient]})`;
  switch (r.status) {
    case "read":
      return `Read by ${who}${at(r.readAt)}: it acknowledged this input after ${deliveryProof(r.provider)}. Comprehension is not observable.`;
    case "delivered":
      return `Delivered to ${who}${at(r.deliveredAt)}: ${deliveryProof(r.provider)}. No ACK yet, so it is in the agent's context but not confirmed read.`;
    case "sent":
      return `Sent to ${who}${at(r.sentAt)}. ${r.detail ?? "Its provider has not confirmed taking it yet."}`;
    case "pending":
      return `Waiting for ${who}. ${r.detail ?? "No agent has it yet."}`;
    case "failed":
      return `Not delivered to ${who}${at(r.failedAt)}. ${r.detail ?? ""}`.trim();
  }
}

/** A 14px gnome hat: an outline while the message is on its way, filled once delivered, ticked once read. */
export function GnomeCheck({ status, role }: { status: InjectionReceiptStatus; role: Role }) {
  const hue = status === "failed" ? "var(--danger)" : gnomeRoleColor(role, 1);
  const filled = status === "delivered" || status === "read";
  const outlined = status === "sent" || status === "failed";
  return (
    <svg className="gnome-check" viewBox="0 0 14 14" width="14" height="14" aria-hidden="true" style={{ color: hue }}>
      <g strokeLinejoin="round" strokeLinecap="round">
        <path
          d="M2.4 11.2 6.5 1.9q.5-.9 1 0l4.1 9.3Z"
          fill={filled ? "currentColor" : "none"}
          stroke={filled || outlined ? "currentColor" : "var(--text-faint)"}
          strokeWidth="1.2"
        />
        <rect
          x="1.3" y="10.6" width="11.4" height="2.3" rx="1.15"
          fill={filled ? BEARD : "none"}
          stroke={filled ? BEARD : outlined ? "currentColor" : "var(--text-faint)"}
          strokeWidth={filled ? 0 : 1.1}
        />
        {filled ? <circle cx="7" cy="1.5" r="1.15" fill={BEARD} /> : null}
        {status === "read" ? <path d="M4.7 7.4l1.6 1.6 3.1-3.5" fill="none" stroke={BEARD} strokeWidth="1.5" /> : null}
        {status === "failed" ? <path d="M7 5v2.6M7 9.2v.1" fill="none" stroke="currentColor" strokeWidth="1.3" /> : null}
      </g>
    </svg>
  );
}

/** Every recipient's receipt for one feed message, in a stable recipient order. */
export function ReceiptMarks({ receipts, nameFor }: { receipts: InjectionReceipt[]; nameFor: (role: Role) => string }) {
  if (!receipts.length) return null;
  const order: InjectionReceipt["recipient"][] = ["planner", "qa", "reviewer", "implementor"];
  const sorted = [...receipts].sort((a, b) => order.indexOf(a.recipient) - order.indexOf(b.recipient));
  return (
    <div className="receipt-marks">
      {sorted.map((r) => {
        const title = receiptTitle(r, nameFor(r.recipient));
        return (
          <span key={r.id} className={`receipt-mark ${r.status}`} role="img" aria-label={title} title={title} data-recipient={r.recipient}>
            <GnomeCheck status={r.status} role={r.recipient} />
            <span className="receipt-word">{`${RECIPIENT_LABEL[r.recipient]} ${STATUS_WORD[r.status]}`}</span>
          </span>
        );
      })}
    </div>
  );
}
