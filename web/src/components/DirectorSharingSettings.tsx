import { useEffect, useState } from "react";
import { useStore } from "../store.js";
import type { DirectorShareOffer, DirectorShareView } from "../types.js";
import {
  availabilityLabel,
  browserTimeZone,
  deadlineProblem,
  formatDeadline,
  fromLocalInput,
  relayProblem,
  timeLeft,
  toLocalInput,
} from "../lib/directorSharing.js";

const DEFAULT_SHARE_HOURS = 2;

/** Ticks every 30 s so countdowns and the Expired chip stay honest between server broadcasts. */
function useNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(id);
  }, []);
  return now;
}

/** The donor side: each connected subscription with its own sharing state and controls. */
export function DirectorShareDonorSection() {
  const sharing = useStore((s) => s.directorSharing);
  const problem = relayProblem(sharing.relay);
  const now = useNow();
  return (
    <div className="dshare">
      <p className="settings-note tight">
        Lend an API-key subscription to other members of the online office as their Director. Their Director's model
        calls send their conversation context here and run on your key, which never leaves this machine. They never reach your tasks, memory, tools or
        files, and the tasks their Director dispatches run on their own subscriptions. Each share ends at its own
        deadline, enforced by this server.
      </p>
      <p className="settings-note tight">
        Stop sharing and expiry abort active requests and withhold late replies. A provider may still finish or
        bill a request it already started. New calls are refused immediately.
      </p>
      {problem ? <p className="settings-note tight dshare-warn">{problem}</p> : null}
      {sharing.subscriptions.length === 0 ? (
        <p className="settings-note tight">No subscriptions are connected on this console.</p>
      ) : (
        <div className="dshare-list">
          {sharing.subscriptions.map((view) => (
            <DonorRow key={view.subscription.id} view={view} relayReady={!problem} now={now} />
          ))}
        </div>
      )}
    </div>
  );
}

function statusOf(view: DirectorShareView, now: number): "private" | "shared" | "expired" {
  const share = view.share;
  if (!share || share.status === "stopped") return "private";
  if (share.status === "expired" || share.expiresAt <= now) return "expired";
  return "shared";
}

function DonorRow({ view, relayReady, now }: { view: DirectorShareView; relayReady: boolean; now: number }) {
  const { subscription, share } = view;
  const status = statusOf(view, now);
  const error = useStore((s) => (s.directorShareError?.key === subscription.id ? s.directorShareError.error : null));
  return (
    <div className="dshare-row" data-subscription={subscription.id}>
      <div className="dshare-row-head">
        <div className="dshare-row-title">
          <div className="settings-row-label">{subscription.label}</div>
          <div className="settings-row-hint">{subscription.providerLabel}</div>
        </div>
        <span className={`share-chip ${status === "shared" ? "on" : status === "expired" ? "off" : ""}`}>
          {status === "shared" ? "Shared" : status === "expired" ? "Expired" : "Private"}
        </span>
      </div>
      {!subscription.shareable ? (
        <p className="dshare-reason">
          Cannot be shared. {subscription.reason}{" "}
          <a href={subscription.sourceUrl} target="_blank" rel="noreferrer">Provider terms</a>
        </p>
      ) : status === "shared" && share ? (
        <LiveShare view={view} now={now} />
      ) : (
        <>
          {status === "expired" && share ? (
            <p className="dshare-reason">
              Expired {formatDeadline(share.expiresAt, share.timeZone)}. Sharing again is a fresh opt-in.
            </p>
          ) : null}
          <ShareForm subscriptionId={subscription.id} relayReady={relayReady} lastModel={share?.model} />
        </>
      )}
      {share && status !== "private" ? <UsageSummary view={view} /> : null}
      {error ? <p className="office-error dshare-error">{error}</p> : null}
    </div>
  );
}

function ShareForm({ subscriptionId, relayReady, lastModel }: { subscriptionId: string; relayReady: boolean; lastModel?: string }) {
  const models = useStore((s) => s.directorShareModels[subscriptionId]);
  const loadModels = useStore((s) => s.loadDirectorShareModels);
  const shareDirector = useStore((s) => s.shareDirector);
  const pending = useStore((s) => s.directorSharePending?.key === subscriptionId);
  const [model, setModel] = useState(lastModel ?? "");
  const [deadline, setDeadline] = useState(() => toLocalInput(Date.now() + DEFAULT_SHARE_HOURS * 3_600_000));
  const [concurrent, setConcurrent] = useState(1);
  const [perHour, setPerHour] = useState(60);
  const zone = browserTimeZone();

  useEffect(() => {
    if (relayReady && !models) loadModels(subscriptionId);
  }, [relayReady, models, loadModels, subscriptionId]);
  useEffect(() => {
    if (!model && models?.models.length) setModel(models.models.includes(lastModel ?? "") ? lastModel! : models.models[0]!);
  }, [models, model, lastModel]);

  const expiresAt = fromLocalInput(deadline);
  const problem = deadlineProblem(expiresAt);
  const canShare = relayReady && !!model && !problem && !pending;
  return (
    <div className="dshare-form">
      <label className="office-field">
        <span>Model</span>
        <select className="model-select" value={model} disabled={!models?.models.length} onChange={(e) => setModel(e.target.value)}>
          {!models?.models.length ? <option value="">{models?.loading ? "Loading models..." : "No models listed"}</option> : null}
          {models?.models.map((m) => <option key={m} value={m}>{m}</option>)}
        </select>
      </label>
      <DeadlineField value={deadline} onChange={setDeadline} zone={zone} problem={deadline ? problem : null} />
      <LimitFields concurrent={concurrent} perHour={perHour} onConcurrent={setConcurrent} onPerHour={setPerHour} />
      {models?.error ? <p className="office-error dshare-error">{models.error}</p> : null}
      <div className="dshare-actions">
        <button
          type="button"
          className="btn primary sm"
          disabled={!canShare}
          onClick={() => shareDirector({ subscriptionId, model, expiresAt, timeZone: zone, maxConcurrent: concurrent, maxRequestsPerHour: perHour })}
        >
          {pending ? "Sharing..." : "Share"}
        </button>
      </div>
    </div>
  );
}

function LiveShare({ view, now }: { view: DirectorShareView; now: number }) {
  const share = view.share!;
  const subscriptionId = view.subscription.id;
  const update = useStore((s) => s.updateDirectorShare);
  const stop = useStore((s) => s.stopDirectorShare);
  const pending = useStore((s) => s.directorSharePending?.key === subscriptionId ? s.directorSharePending.action : null);
  const [deadline, setDeadline] = useState(() => toLocalInput(share.expiresAt));
  const [concurrent, setConcurrent] = useState(share.maxConcurrent);
  const [perHour, setPerHour] = useState(share.maxRequestsPerHour);
  // Adopt the server's values when they change under us (another tab, a successful save).
  useEffect(() => setDeadline(toLocalInput(share.expiresAt)), [share.expiresAt]);
  useEffect(() => setConcurrent(share.maxConcurrent), [share.maxConcurrent]);
  useEffect(() => setPerHour(share.maxRequestsPerHour), [share.maxRequestsPerHour]);
  const zone = browserTimeZone();
  const expiresAt = fromLocalInput(deadline);
  const problem = deadlineProblem(expiresAt);
  const changed = expiresAt !== share.expiresAt || concurrent !== share.maxConcurrent || perHour !== share.maxRequestsPerHour;
  return (
    <div className="dshare-form">
      <p className="dshare-live">
        Sharing <span className="mono">{share.model}</span> until {formatDeadline(share.expiresAt, share.timeZone)} ({timeLeft(share.expiresAt, now)}).
      </p>
      <DeadlineField value={deadline} onChange={setDeadline} zone={zone} problem={problem} />
      <LimitFields concurrent={concurrent} perHour={perHour} onConcurrent={setConcurrent} onPerHour={setPerHour} />
      <div className="dshare-actions">
        <button
          type="button"
          className="btn sm"
          disabled={!changed || !!problem || !!pending}
          onClick={() => update({ subscriptionId, expiresAt, timeZone: zone, maxConcurrent: concurrent, maxRequestsPerHour: perHour })}
        >
          {pending === "director.share.update" ? "Saving..." : "Save changes"}
        </button>
        <button type="button" className="btn danger sm" disabled={!!pending} onClick={() => stop(subscriptionId)}>
          {pending === "director.share.stop" ? "Stopping..." : "Stop sharing"}
        </button>
      </div>
    </div>
  );
}

function DeadlineField({ value, onChange, zone, problem }: { value: string; onChange: (v: string) => void; zone: string; problem: string | null }) {
  const ms = fromLocalInput(value);
  return (
    <label className="office-field">
      <span>Share until ({zone})</span>
      <input className="text-input" type="datetime-local" value={value} onChange={(e) => onChange(e.target.value)} />
      <small className={"dshare-hint" + (problem ? " bad" : "")}>
        {problem ?? `Returns to private at ${formatDeadline(ms, zone)}.`}
      </small>
    </label>
  );
}

function LimitFields({ concurrent, perHour, onConcurrent, onPerHour }: { concurrent: number; perHour: number; onConcurrent: (n: number) => void; onPerHour: (n: number) => void }) {
  return (
    <div className="dshare-limits">
      <label className="office-field">
        <span>At once</span>
        <select className="model-select" value={concurrent} onChange={(e) => onConcurrent(Number(e.target.value))}>
          {[1, 2, 3, 4].map((n) => <option key={n} value={n}>{n}</option>)}
        </select>
      </label>
      <label className="office-field">
        <span>Requests per hour</span>
        <input
          className="text-input"
          type="number"
          min={1}
          max={600}
          value={perHour}
          onChange={(e) => onPerHour(Math.max(1, Math.min(600, Math.round(Number(e.target.value) || 1))))}
        />
      </label>
    </div>
  );
}

function UsageSummary({ view }: { view: DirectorShareView }) {
  const share = view.share!;
  const recipients = Object.entries(share.usage.recipients).sort((a, b) => b[1].lastAt - a[1].lastAt);
  return (
    <div className="dshare-usage">
      <div>
        {share.usage.requests} request{share.usage.requests === 1 ? "" : "s"} · {share.usage.denied} refused ·{" "}
        {share.usage.inputTokens.toLocaleString()} in / {share.usage.outputTokens.toLocaleString()} out tokens
        {share.status === "shared" ? ` · ${share.inFlight} running · ${share.requestsLastHour}/${share.maxRequestsPerHour} this hour` : ""}
      </div>
      {recipients.length ? (
        <div className="dim">
          Used by {recipients.map(([, r]) => `${r.name} (${r.requests})`).join(", ")}
          {share.usage.lastUsedAt ? `, last ${formatDeadline(share.usage.lastUsedAt)}` : ""}
        </div>
      ) : null}
    </div>
  );
}

/** The recipient side: what others share right now, and which one (if any) this console uses. */
export function DirectorShareRecipientSection() {
  const sharing = useStore((s) => s.directorSharing);
  const useShared = useStore((s) => s.useSharedDirector);
  const pending = useStore((s) => s.directorSharePending?.action === "director.share.use");
  const error = useStore((s) => (s.directorShareError?.action === "director.share.use" ? s.directorShareError.error : null));
  const now = useNow();
  const problem = relayProblem(sharing.relay);
  const sel = sharing.selection;
  const selState = sel ? (sel.expiresAt <= now ? "expired" : sel.availability) : null;
  return (
    <div className="dshare">
      <p className="settings-note tight">
        Use capacity another office member shares as your Director. Each model call sends your conversation context
        through the office relay to their machine and provider. Your stored chat, tools, memory access and files stay on this console, and dispatched tasks run on your own
        subscriptions. If the shared Director becomes unavailable it says so; it never switches to your own
        subscriptions on its own.
      </p>
      {problem ? <p className="settings-note tight dshare-warn">{problem}</p> : null}
      {sel && selState ? (
        <div className="dshare-row dshare-current">
          <div className="dshare-row-head">
            <div className="dshare-row-title">
              <div className="settings-row-label">Using {sel.donorName}'s Director</div>
              <div className="settings-row-hint">
                {sel.instanceName} · {sel.providerLabel} · <span className="mono">{sel.model}</span>
              </div>
            </div>
            <span className={`share-chip ${selState === "available" ? "on" : "off"}`}>{availabilityLabel(selState)}</span>
          </div>
          <p className="dshare-reason">
            {selState === "expired" ? `Expired ${formatDeadline(sel.expiresAt)}.` : `Until ${formatDeadline(sel.expiresAt)} (${timeLeft(sel.expiresAt, now)}).`}
            {selState !== "available" && selState !== "expired" ? ` ${sel.detail}` : ""}
          </p>
          <div className="dshare-actions">
            <button type="button" className="btn sm" disabled={pending} onClick={() => useShared("", null)}>
              Use my own subscriptions
            </button>
          </div>
        </div>
      ) : (
        <p className="settings-note tight">Your Director runs on your own subscriptions.</p>
      )}
      {sharing.offers.length ? (
        <div className="dshare-list">
          {sharing.offers.map((offer) => (
            <OfferRow key={`${offer.instanceId}:${offer.shareId}`} offer={offer} now={now} selected={sel?.shareId === offer.shareId && sel.instanceId === offer.instanceId} disabled={pending || !!problem} onUse={() => useShared(offer.instanceId, offer.shareId)} />
          ))}
        </div>
      ) : !problem ? (
        <p className="settings-note tight">Nobody in the office is sharing a Director right now.</p>
      ) : null}
      {error ? <p className="office-error dshare-error">{error}</p> : null}
    </div>
  );
}

function OfferRow({ offer, now, selected, disabled, onUse }: { offer: DirectorShareOffer; now: number; selected: boolean; disabled: boolean; onUse: () => void }) {
  const full = offer.inFlight >= offer.maxConcurrent;
  return (
    <div className="dshare-row dshare-offer" data-share={offer.shareId}>
      <div className="dshare-row-head">
        <div className="dshare-row-title">
          <div className="settings-row-label">{offer.donorName}</div>
          <div className="settings-row-hint">
            {offer.instanceName} · {offer.providerLabel} · <span className="mono">{offer.model}</span>
          </div>
        </div>
        <span className={`share-chip ${full ? "off" : "on"}`}>{full ? "Busy" : "Available"}</span>
      </div>
      <p className="dshare-reason">
        Until {formatDeadline(offer.expiresAt)} ({timeLeft(offer.expiresAt, now)}) · {offer.inFlight}/{offer.maxConcurrent} in use
      </p>
      <div className="dshare-actions">
        <button type="button" className="btn primary sm" disabled={disabled || selected} onClick={onUse}>
          {selected ? "In use" : "Use as my Director"}
        </button>
      </div>
    </div>
  );
}
