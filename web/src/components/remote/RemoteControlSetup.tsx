import { useEffect, useMemo, useState } from "react";
import {
  ENCODER_LABELS, QUALITY_OPTIONS, remoteRequest, saveRemoteConfig, setRemoteControlEnabled, thumbnailUrl,
  type CheckReport, type EncoderId, type QualityId, type RemoteControlStatus, type SessionRecord,
} from "./remoteApi.js";
import "./remote.css";

const POLL_MS = 5_000;
const INSTALL_POLL_MS = 1_000;

interface Draft {
  pair: string | null;
  display: number;
  quality: QualityId;
}

/** Settings → Remote control: check the PC, get a working encoder, pick a display, and switch it on.
 *  Once on, the board grows a Remote control tab. */
export function RemoteControlSetup({ onOpenViewer }: { onOpenViewer: () => void }) {
  const [status, setStatus] = useState<RemoteControlStatus | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [customPath, setCustomPath] = useState("");
  const installing = status ? ["downloading", "verifying", "extracting"].includes(status.install.state) : false;

  const refresh = () => remoteRequest<RemoteControlStatus>("status").then((next) => {
    setStatus(next);
    setRemoteControlEnabled(next.supported && next.config.enabled);
    setCustomPath((current) => current || next.config.customFfmpegPath || "");
    return next;
  });

  useEffect(() => {
    refresh().catch((e: Error) => setError(e.message));
  }, []);

  useEffect(() => {
    const timer = window.setInterval(() => { refresh().catch(() => undefined); }, installing ? INSTALL_POLL_MS : POLL_MS);
    return () => window.clearInterval(timer);
  }, [installing]);

  // After an install finishes the server re-runs the check; pick up the new recommendation.
  useEffect(() => {
    if (status?.install.state === "done") setDraft(null);
  }, [status?.install.state]);

  const effectiveDraft = useMemo(() => draft ?? draftFrom(status), [draft, status]);

  if (!status) return error ? <p className="rcs-error">{error}</p> : <p className="rcs-note">Loading…</p>;
  if (!status.supported) return <p className="rcs-note">Remote control needs GGO to be running on Windows.</p>;

  const act = async (label: string, action: () => Promise<unknown>) => {
    setBusy(label);
    setError(null);
    try {
      await action();
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const check = () => act("check", async () => {
    if ((customPath.trim() || null) !== status.config.customFfmpegPath) await saveRemoteConfig({ customFfmpegPath: customPath.trim() || null });
    await remoteRequest<CheckReport>("check", { method: "POST" });
    setDraft(null);
  });
  const install = () => act("install", () => remoteRequest("install-ffmpeg", { method: "POST" }));
  const turnOn = () => act("save", async () => {
    const [ffmpegPath, encoder] = splitPair(effectiveDraft.pair);
    await saveRemoteConfig({ enabled: true, ffmpegPath, encoder, display: effectiveDraft.display, quality: effectiveDraft.quality });
    setDraft(null);
  });
  const turnOff = () => act("off", () => saveRemoteConfig({ enabled: false }));
  const disconnect = () => act("disconnect", () => remoteRequest("disconnect", { method: "POST" }));

  const { config, check: report } = status;
  const pairs = workingPairs(report);
  const dirty = config.enabled && (effectiveDraft.pair !== pairKey(config.ffmpegPath, config.encoder) || effectiveDraft.display !== config.display || effectiveDraft.quality !== config.quality);
  const thumbFfmpeg = splitPair(effectiveDraft.pair)[0] ?? report?.ffmpeg.find((p) => p.ddagrab)?.path ?? null;

  return (
    <div className="rcs">
      <div className="rcs-state">
        <span className={"rcs-pill" + (config.enabled ? " on" : "")}>{config.enabled ? "On" : "Off"}</span>
        {config.enabled ? <button type="button" className="btn primary sm" onClick={onOpenViewer}>Open Remote control</button> : null}
        {config.enabled ? <button type="button" className="btn ghost sm" disabled={!!busy} onClick={turnOff}>Turn off</button> : null}
      </div>
      <p className="rcs-note">
        Control this PC from any browser signed in to this console, like the tablet. Anyone who can sign in here can see and control the PC while this is on.
      </p>
      <SessionLine active={status.active} last={status.lastSession} onDisconnect={disconnect} busy={!!busy} />

      <section className="rcs-step">
        <h4>1. Check this PC</h4>
        <p>Finds the displays and tests each ffmpeg with a short real capture, so only encoders that work on this hardware are offered.</p>
        <label className="rcs-field">Other ffmpeg.exe to test (optional)
          <input value={customPath} onChange={(e) => setCustomPath(e.target.value)} placeholder="C:\\tools\\ffmpeg\\bin\\ffmpeg.exe" spellCheck={false} />
        </label>
        <div className="rcs-row">
          <button type="button" className="btn sm" disabled={!!busy || installing} onClick={check}>{busy === "check" ? "Checking… (up to a minute)" : report ? "Check again" : "Check this PC"}</button>
          {report ? <span className="rcs-note">Last checked {new Date(report.checkedAt).toLocaleTimeString()}</span> : null}
        </div>
        {report ? <CheckResults report={report} /> : null}
        {report && !report.managedInstalled ? <InstallOffer status={status} busy={!!busy} onInstall={install} hasGpu={pairs.some((p) => p.encoder === "h264_nvenc")} /> : null}
      </section>

      {report && pairs.length ? (
        <section className="rcs-step">
          <h4>2. Choose the encoder and display</h4>
          <label className="rcs-field">Encoder
            <select value={effectiveDraft.pair ?? ""} onChange={(e) => setDraft({ ...effectiveDraft, pair: e.target.value })}>
              {pairs.map((p) => <option key={p.key} value={p.key}>{ENCODER_LABELS[p.encoder]} · ffmpeg {p.version} ({p.source === "managed" ? "GGO's own" : p.source === "path" ? "on PATH" : "custom"})</option>)}
            </select>
          </label>
          {report.layout?.displays.length && thumbFfmpeg ? (
            <div className="rcs-displays" role="radiogroup" aria-label="Display to show first">
              {report.layout.displays.map((d) => (
                <button key={d.index} type="button" role="radio" aria-checked={effectiveDraft.display === d.index} className={"rcs-display" + (effectiveDraft.display === d.index ? " on" : "")} onClick={() => setDraft({ ...effectiveDraft, display: d.index })}>
                  <img src={thumbnailUrl(d.index, thumbFfmpeg, report.checkedAt)} alt={`Display ${d.index + 1}`} loading="lazy" />
                  <span>Display {d.index + 1} · {d.width}×{d.height}{d.primary ? " · main" : ""}</span>
                </button>
              ))}
            </div>
          ) : null}
          <label className="rcs-field">Quality
            <select value={effectiveDraft.quality} onChange={(e) => setDraft({ ...effectiveDraft, quality: e.target.value as QualityId })}>
              {QUALITY_OPTIONS.map((q) => <option key={q.id} value={q.id}>{q.label}: {q.hint}</option>)}
            </select>
          </label>
          <p>You can switch display and quality at any time from the viewer's toolbar.</p>
        </section>
      ) : null}

      {report && pairs.length ? (
        <section className="rcs-step">
          <h4>3. {config.enabled ? "Save changes" : "Turn it on"}</h4>
          <div className="rcs-row">
            {!config.enabled ? <button type="button" className="btn primary sm" disabled={!!busy || !effectiveDraft.pair} onClick={turnOn}>{busy === "save" ? "Testing and turning on…" : "Turn on remote control"}</button> : null}
            {config.enabled ? <button type="button" className="btn sm" disabled={!!busy || !dirty} onClick={turnOn}>{busy === "save" ? "Saving…" : "Save changes"}</button> : null}
          </div>
          <p>Once it's on, a Remote control tab appears on the board. It also appears in the All areas menu on a phone or tablet.</p>
        </section>
      ) : null}

      {error ? <p className="rcs-error" role="alert">{error}</p> : null}
    </div>
  );
}

function CheckResults({ report }: { report: CheckReport }) {
  const layout = report.layout;
  return (
    <ul className="rcs-list">
      {report.helperError ? <li className="rcs-bad">Desktop helper: {report.helperError}</li> : null}
      {layout ? (
        <li>
          <span>{layout.displays.length} display{layout.displays.length === 1 ? "" : "s"}: {layout.displays.map((d) => `${d.width}×${d.height}`).join(", ")}</span>
          {!layout.elevated ? <span className="rcs-warn">GGO is not running as administrator, so windows running as administrator and Windows security prompts will ignore remote input.</span> : null}
        </li>
      ) : null}
      {report.ffmpeg.length === 0 ? <li className="rcs-warn">No ffmpeg found on this PC yet.</li> : null}
      {report.ffmpeg.map((probe) => (
        <li key={probe.path}>
          <span>ffmpeg {probe.version ?? "?"} ({probe.source === "managed" ? "GGO's own" : probe.source === "path" ? "on PATH" : "custom"})</span>
          <span className="rcs-path">{probe.path}</span>
          {probe.error ? <span className="rcs-bad">{probe.error}</span> : null}
          {probe.encoders.map((e) => (
            <span key={e.encoder} className={e.ok ? "rcs-ok" : "rcs-bad"}>{ENCODER_LABELS[e.encoder]}: {e.ok ? "works" : e.error}</span>
          ))}
        </li>
      ))}
    </ul>
  );
}

function InstallOffer({ status, busy, onInstall, hasGpu }: { status: RemoteControlStatus; busy: boolean; onInstall: () => void; hasGpu: boolean }) {
  const { install } = status;
  const version = status.check?.managedVersion ?? "";
  const working = ["downloading", "verifying", "extracting"].includes(install.state);
  const percent = Math.round((install.receivedBytes / (install.totalBytes || 1)) * 100);
  return (
    <div className="rcs-step">
      <p>
        {hasGpu ? "" : "No GPU encoder works with the ffmpeg found here. "}
        GGO can download its own ffmpeg {version} (about {Math.round(install.totalBytes / 1_000_000)} MB, checksum-pinned). That build's NVENC works with your current NVIDIA driver.
      </p>
      {working ? (
        <>
          <div className="rcs-progress" aria-label="Download progress"><span style={{ width: `${install.state === "downloading" ? percent : 100}%` }} /></div>
          <span className="rcs-note">{install.state === "downloading" ? `Downloading… ${percent}%` : install.state === "verifying" ? "Verifying checksum…" : "Unpacking…"}</span>
        </>
      ) : (
        <div className="rcs-row"><button type="button" className="btn sm" disabled={busy} onClick={onInstall}>Install ffmpeg {version}</button></div>
      )}
      {install.state === "error" ? <p className="rcs-error">{install.error}</p> : null}
    </div>
  );
}

function SessionLine({ active, last, onDisconnect, busy }: { active: SessionRecord | null; last: SessionRecord | null; onDisconnect: () => void; busy: boolean }) {
  if (active) {
    return (
      <div className="rcs-row">
        <span className="rcs-ok">In use from {describeClient(active)} since {new Date(active.startedAt).toLocaleTimeString()}.</span>
        <button type="button" className="btn danger sm" disabled={busy} onClick={onDisconnect}>Disconnect</button>
      </div>
    );
  }
  if (!last) return null;
  return <p className="rcs-note">Last used from {describeClient(last)}, {new Date(last.startedAt).toLocaleString()}.</p>;
}

function describeClient(record: SessionRecord): string {
  const ua = record.userAgent;
  const device = /iPad|Tablet|Android(?!.*Mobile)/i.test(ua) ? "a tablet" : /Mobile|iPhone/i.test(ua) ? "a phone" : "a computer";
  return `${device} (${record.client})`;
}

function pairKey(path: string | null, encoder: EncoderId | null): string | null {
  return path && encoder ? `${encoder}|${path}` : null;
}

function splitPair(pair: string | null): [string | null, EncoderId | null] {
  if (!pair) return [null, null];
  const at = pair.indexOf("|");
  return [pair.slice(at + 1), pair.slice(0, at) as EncoderId];
}

function workingPairs(report: CheckReport | null) {
  return (report?.ffmpeg ?? []).flatMap((probe) => probe.encoders.filter((e) => e.ok).map((e) => ({
    key: pairKey(probe.path, e.encoder)!, encoder: e.encoder, version: probe.version ?? "?", source: probe.source,
  })));
}

function draftFrom(status: RemoteControlStatus | null): Draft {
  const config = status?.config;
  const recommended = status?.check?.recommended;
  const configured = pairKey(config?.ffmpegPath ?? null, config?.encoder ?? null);
  const available = workingPairs(status?.check ?? null).map((p) => p.key);
  const pair = configured && available.includes(configured) ? configured : recommended ? pairKey(recommended.ffmpegPath, recommended.encoder) : configured;
  return { pair, display: config?.display ?? 0, quality: config?.quality ?? "smooth" };
}
