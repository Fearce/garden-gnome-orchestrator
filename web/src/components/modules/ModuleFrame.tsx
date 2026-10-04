import { useEffect, useRef, type ReactNode } from "react";
import type { ModuleView } from "../../types.js";
import { useService, type ServiceControl } from "./hooks.js";
import { formatBytes } from "./moduleApi.js";
import "./modules.css";

const STATE_LABEL = { running: "Running", starting: "Starting", stopped: "Stopped", unresponsive: "Not answering" } as const;

/**
 * The frame every local-service tab shares: its title, its worker process (state, memory, an explicit
 * Restart and Stop), and the module's own content. The worker starts when the content first asks it for
 * something; Stop here ends it and whatever user-started work it holds, after a confirmation.
 */
export function ModuleFrame({ id, title, lede, actions, children }: { id: ModuleView; title: string; lede: string; actions?: ReactNode; children: (service: ServiceControl) => ReactNode }) {
  const service = useService(id);
  return (
    <section className="mod" aria-labelledby={`mod-title-${id}`}>
      <header className="mod-head">
        <div className="mod-heading">
          <h3 id={`mod-title-${id}`}>{title}</h3>
          <p>{lede}</p>
        </div>
        <div className="mod-head-actions">
          {actions}
          <ServiceChip service={service} />
        </div>
      </header>
      {service.error ? <Notice tone="bad" title="Service control failed">{service.error}</Notice> : null}
      {service.status?.stale && !service.status.busy ? (
        <Notice tone="warn" title="Older build">
          This service still runs code from an earlier GGO build. <button className="btn ghost sm" onClick={() => void service.act("restart")}>Restart it</button>
        </Notice>
      ) : null}
      <div className="mod-body">{children(service)}</div>
    </section>
  );
}

function ServiceChip({ service }: { service: ServiceControl }) {
  const status = service.status;
  const state = service.pending === "start" || service.pending === "restart" ? "starting" : (status?.state ?? "stopped");
  const detail =
    status?.state === "running" ? `pid ${status.pid} · ${formatBytes(status.rssBytes)}` : state === "starting" ? "launching its worker" : status?.lastError ? "last start failed" : "starts when needed";
  const stop = async () => {
    const busy = status?.busy;
    if (busy && !window.confirm(`This service is ${busy}. Stopping it ends that too. Stop anyway?`)) return;
    await service.act("stop", Boolean(busy));
  };
  return (
    <div className={`mod-service mod-service-${state}`} title={status?.lastError ?? undefined}>
      <span className="mod-dot" aria-hidden="true" />
      <span className="mod-service-text">
        <strong>{STATE_LABEL[state]}</strong>
        <span>{status?.busy ?? detail}</span>
      </span>
      {status?.state === "running" || status?.state === "unresponsive" ? (
        <>
          <button className="btn ghost sm" disabled={service.pending !== null} onClick={() => void service.act("restart")} title="Restart this tab's background service">
            Restart
          </button>
          <button className="btn ghost sm" disabled={service.pending !== null} onClick={() => void stop()} title="Stop this tab's background service now instead of when it idles out">
            {service.pending === "stop" ? "Stopping…" : "Stop"}
          </button>
        </>
      ) : null}
    </div>
  );
}

export function Notice({ tone, title, children, onRetry }: { tone: "bad" | "warn" | "info"; title: string; children?: ReactNode; onRetry?: () => void }) {
  return (
    <div className={`mod-notice mod-notice-${tone}`} role={tone === "bad" ? "alert" : "status"}>
      <div>
        <strong>{title}</strong>
        {children ? <div className="mod-notice-text">{children}</div> : null}
      </div>
      {onRetry ? (
        <button className="btn ghost sm" onClick={onRetry}>
          Try again
        </button>
      ) : null}
    </div>
  );
}

/** A modal editor over the tab. Escape and the scrim close it, and focus goes back to the opener. */
export function ModuleDialog({ title, wide, onClose, children, footer }: { title: string; wide?: boolean; onClose: () => void; children: ReactNode; footer: ReactNode }) {
  const opener = useRef<Element | null>(document.activeElement);
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const back = opener.current;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      event.preventDefault();
      close.current();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      if (back instanceof HTMLElement && back.isConnected) back.focus();
    };
  }, []);
  return (
    <div className="scrim" onMouseDown={onClose}>
      <div className={`modal mod-dialog${wide ? " wide" : ""}`} role="dialog" aria-modal="true" aria-label={title} onMouseDown={(e) => e.stopPropagation()}>
        <div className="mod-dialog-head">
          <h3>{title}</h3>
          <button type="button" className="mod-icon-btn" onClick={onClose} aria-label="Close">
            <Icon name="x" size={16} />
          </button>
        </div>
        <div className="mod-dialog-body">{children}</div>
        <div className="mod-dialog-foot">{footer}</div>
      </div>
    </div>
  );
}

/** A labelled form control with an optional hint under it. */
export function Field({ label, hint, wide, children }: { label: string; hint?: ReactNode; wide?: boolean; children: ReactNode }) {
  return (
    <label className={`mod-field${wide ? " wide" : ""}`}>
      <span className="mod-field-label">{label}</span>
      {children}
      {hint ? <span className="mod-field-hint">{hint}</span> : null}
    </label>
  );
}

export function Loading({ label }: { label: string }) {
  return (
    <div className="mod-loading" role="status">
      <span className="mod-spinner" aria-hidden="true" />
      {label}
    </div>
  );
}

export function Icon({ name, size = 16 }: { name: keyof typeof ICONS; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {ICONS[name]}
    </svg>
  );
}

// Lucide paths, inlined: the console ships no icon library.
const ICONS = {
  play: <polygon points="6 3 20 12 6 21 6 3" />,
  square: <rect width="14" height="14" x="5" y="5" rx="1" />,
  pause: (
    <>
      <rect x="14" y="4" width="4" height="16" rx="1" />
      <rect x="6" y="4" width="4" height="16" rx="1" />
    </>
  ),
  refresh: (
    <>
      <path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8" />
      <path d="M21 3v5h-5" />
      <path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16" />
      <path d="M8 16H3v5" />
    </>
  ),
  home: (
    <>
      <path d="M15 21v-8a1 1 0 0 0-1-1h-4a1 1 0 0 0-1 1v8" />
      <path d="M3 10a2 2 0 0 1 .709-1.528l7-5.999a2 2 0 0 1 2.582 0l7 5.999A2 2 0 0 1 21 10v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
    </>
  ),
  locate: (
    <>
      <line x1="2" x2="5" y1="12" y2="12" />
      <line x1="19" x2="22" y1="12" y2="12" />
      <line x1="12" x2="12" y1="2" y2="5" />
      <line x1="12" x2="12" y1="19" y2="22" />
      <circle cx="12" cy="12" r="7" />
    </>
  ),
  eye: (
    <>
      <path d="M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0" />
      <circle cx="12" cy="12" r="3" />
    </>
  ),
  eyeOff: (
    <>
      <path d="M10.733 5.076a10.744 10.744 0 0 1 11.205 6.575 1 1 0 0 1 0 .696 10.747 10.747 0 0 1-1.444 2.49" />
      <path d="M14.084 14.158a3 3 0 0 1-4.242-4.242" />
      <path d="M17.479 17.499a10.75 10.75 0 0 1-15.417-5.151 1 1 0 0 1 0-.696 10.75 10.75 0 0 1 4.446-5.143" />
      <path d="m2 2 20 20" />
    </>
  ),
  infinity: <path d="M6 16c5 0 7-8 12-8a4 4 0 0 1 0 8c-5 0-7-8-12-8a4 4 0 1 0 0 8" />,
  logs: (
    <>
      <path d="M15 12h-5" />
      <path d="M15 8h-5" />
      <path d="M19 17V5a2 2 0 0 0-2-2H4" />
      <path d="M8 21h12a2 2 0 0 0 2-2v-1a1 1 0 0 0-1-1H11a1 1 0 0 0-1 1v1a2 2 0 1 1-4 0V5a2 2 0 1 0-4 0v2a1 1 0 0 0 1 1h3" />
    </>
  ),
  plus: (
    <>
      <path d="M5 12h14" />
      <path d="M12 5v14" />
    </>
  ),
  x: (
    <>
      <path d="M18 6 6 18" />
      <path d="m6 6 12 12" />
    </>
  ),
  settings: (
    <>
      <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
      <circle cx="12" cy="12" r="3" />
    </>
  ),
  shield: <path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z" />,
  record: <circle cx="12" cy="12" r="6" />,
  maximize: (
    <>
      <path d="M8 3H5a2 2 0 0 0-2 2v3" />
      <path d="M21 8V5a2 2 0 0 0-2-2h-3" />
      <path d="M3 16v3a2 2 0 0 0 2 2h3" />
      <path d="M16 21h3a2 2 0 0 0 2-2v-3" />
    </>
  ),
  search: (
    <>
      <circle cx="11" cy="11" r="8" />
      <path d="m21 21-4.3-4.3" />
    </>
  ),
  trash: (
    <>
      <path d="M3 6h18" />
      <path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6" />
      <path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2" />
    </>
  ),
  pencil: <path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z" />,
  power: (
    <>
      <path d="M12 2v10" />
      <path d="M18.4 6.6a9 9 0 1 1-12.77.04" />
    </>
  ),
  download: (
    <>
      <path d="M12 15V3" />
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <path d="m7 10 5 5 5-5" />
    </>
  ),
  film: (
    <>
      <rect width="18" height="18" x="3" y="3" rx="2" />
      <path d="M7 3v18" />
      <path d="M3 7.5h4" />
      <path d="M3 12h18" />
      <path d="M3 16.5h4" />
      <path d="M17 3v18" />
      <path d="M17 7.5h4" />
      <path d="M17 16.5h4" />
    </>
  ),
  video: (
    <>
      <path d="m16 13 5.223 3.482a.5.5 0 0 0 .777-.416V7.87a.5.5 0 0 0-.752-.432L16 10.5" />
      <rect x="2" y="6" width="14" height="12" rx="2" />
    </>
  ),
};
