import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { Field, Icon, Loading, ModuleDialog, ModuleFrame, Notice } from "./ModuleFrame.js";
import { RecordingBar, RecordingDialog } from "./RecordingPlan.js";
import { RecordingsBrowser } from "./SurveillanceRecordings.js";
import { CameraViewer } from "./CameraViewer.js";
import { usePoll } from "./hooks.js";
import { errorText, formatAgo, moduleJson } from "./moduleApi.js";
import type { Camera, CameraRecording, PreviewStrategy, RecordingMode, RecordingView, SurveillanceConfig } from "./surveillanceTypes.js";

import { useFrameStream, type FrameStore, type LiveFrameEntry, type StreamStatus } from "./surveillanceFrames.js";
import { unlockMotionSound, motionConfigChanged } from "./surveillanceNotifications.js";

interface Preset {
  id: string;
  vendor: string;
  model: string;
  aliases: string[];
  notes: string[];
}

interface Discovery {
  draftId: string | null;
  detectedVendor: string;
  matchedPreset: { id: string; vendor: string; model: string; notes: string[] } | null;
  openPorts: number[];
  onvifProbes: { url: string; ok: boolean; statusCode: number | null; error: string | null }[];
  rtspCandidates: { label: string; url: string }[];
  snapshotProbes: { url: string; ok: boolean; statusCode: number | null; contentType: string | null; error: string | null }[];
  cameraDraft: Camera;
}

const STALE_FRAME_MS = 30_000;
const RECORDING_LABEL: Record<CameraRecording["state"], string> = { recording: "recording", connecting: "connecting", waiting: "not recording", "not-configured": "no recording source", disabled: "not recorded" };
const MODE_LOG: Record<RecordingMode, string> = { off: "Recording turned off", continuous: "Recording 24/7", schedule: "Recording on the schedule" };

export function Surveillance() {
  return (
    <ModuleFrame
      id="surveillance"
      title="Surveillance"
      lede="Live pictures, recording and playback for your cameras. Recording is off until you choose 24/7 or a schedule; then it keeps going with this tab closed and after restarts, until you turn it off."
    >
      {(service) => <SurveillanceBody onRecordingChange={() => void service.refresh()} />}
    </ModuleFrame>
  );
}

type SaveableConfig = Pick<SurveillanceConfig, "recordingRoot" | "ffmpegPath" | "recording" | "cameras">;
type Dialog = { kind: "camera"; camera: Camera; isNew: boolean } | { kind: "discover" } | { kind: "settings" } | null;

function SurveillanceBody({ onRecordingChange }: { onRecordingChange: () => void }) {
  const config = usePoll((signal) => moduleJson<SurveillanceConfig>("surveillance", "/config", { signal }), null);
  const recording = usePoll((signal) => moduleJson<RecordingView>("surveillance", "/recording", { signal }), 5_000);
  const [current, setCurrent] = useState<SurveillanceConfig | null>(null);
  const latest = useRef(current);
  latest.current = current;
  const cameraUpdates = useRef<Promise<void>>(Promise.resolve());
  const [dialog, setDialog] = useState<Dialog>(null);
  const [view, setView] = useState<"live" | "recordings">("live");
  const [modeBusy, setModeBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (config.data) { setCurrent(config.data); motionConfigChanged(config.data); }
  }, [config.data]);

  const saveConfig = useCallback(async (next: SaveableConfig) => {
    const saved = await moduleJson<SurveillanceConfig>("surveillance", "/config", {
      method: "PUT",
      body: { recordingRoot: next.recordingRoot, ffmpegPath: next.ffmpegPath, recording: next.recording, cameras: next.cameras },
    });
    motionConfigChanged(saved);
    latest.current = saved;
    setCurrent(saved);
    return saved;
  }, []);

  const setMode = useCallback(
    async (mode: RecordingMode) => {
      if (mode === "off" && !window.confirm("Turn recording off? Every camera stops recording now, and nothing records until you choose 24/7 or Schedule again.")) return;
      setModeBusy(true);
      setError(null);
      try {
        await moduleJson("surveillance", "/recording/mode", { method: "PUT", body: { mode } });
        setCurrent((c) => (c ? { ...c, recording: { ...c.recording, mode } } : c));
        await recording.refresh();
        onRecordingChange();
      } catch (err) {
        setError(`${MODE_LOG[mode]} failed: ${errorText(err)}`);
      } finally {
        setModeBusy(false);
      }
    },
    [recording, onRecordingChange],
  );

  const updateCamera = useCallback(
    (camera: Camera, change: Partial<Camera> | ((camera: Camera) => Partial<Camera>)) => {
      // Whole-config saves must use the result of the preceding click, even before React renders it.
      const update = cameraUpdates.current.then(async () => {
        const config = latest.current;
        if (!config || !config.cameras.some(c => c.id === camera.id)) return;
        await saveConfig({ ...config, cameras: config.cameras.map(c => c.id === camera.id
          ? { ...c, ...(typeof change === "function" ? change(c) : change) } : c) });
      });
      cameraUpdates.current = update.catch(err => {
        setError(errorText(err));
      });
      return cameraUpdates.current;
    },
    [saveConfig],
  );

  const setPrivacy = useCallback(async (camera: Camera, enabled: boolean) => {
    setError(null);
    try {
      const answer = await moduleJson<SurveillanceConfig>("surveillance", `/cameras/${encodeURIComponent(camera.id)}/privacy`, { method: "POST", body: { enabled } });
      setCurrent(answer);
    } catch (err) {
      setError(errorText(err));
    }
  }, []);

  if (!current) {
    if (config.error) {
      return (
        <Notice tone="bad" title="Surveillance could not be read" onRetry={() => void config.refresh()}>
          {errorText(config.error)}
        </Notice>
      );
    }
    return <Loading label="Loading your cameras…" />;
  }

  const switcher = (
    <div className="segment sv-view" role="tablist" aria-label="Surveillance view">
      <button role="tab" aria-selected={view === "live"} className={view === "live" ? "on" : ""} onClick={() => setView("live")}>
        Live
      </button>
      <button role="tab" aria-selected={view === "recordings"} className={view === "recordings" ? "on" : ""} onClick={() => setView("recordings")}>
        Recordings
      </button>
    </div>
  );

  return (
    <div className="sv">
      <RecordingBar config={current} view={recording.data} busy={modeBusy} onMode={(mode) => void setMode(mode)} onSettings={() => setDialog({ kind: "settings" })} />

      {error ? <Notice tone="bad" title="That did not work">{error}</Notice> : null}
      {recording.error ? (
        <Notice tone="bad" title="Recording status could not be read" onRetry={() => void recording.refresh()}>
          {errorText(recording.error)}
        </Notice>
      ) : null}
      {current.origin === "deck-unreachable" ? (
        <Notice tone="info" title="Nothing was imported">
          No Script Hub answered, so there were no Dashboard Deck cameras to bring over. Add cameras here; if the hub is running the next time this service starts and you have not saved anything yet, its cameras are imported then.
        </Notice>
      ) : null}
      {!current.ffmpegFound ? (
        <Notice tone="warn" title="ffmpeg was not found">
          Recording, stream-only cameras and playback need ffmpeg. Install it on PATH or set its location under Recording settings.
        </Notice>
      ) : null}

      {view === "live" ? (
        <LiveView
          toolbar={switcher}
          cameras={current.cameras}
          statuses={recording.data?.cameras ?? []}
          onDiscover={() => setDialog({ kind: "discover" })}
          onCollapse={(camera) => void updateCamera(camera, c => ({ uiCollapsed: !c.uiCollapsed }))}
          onEdit={(camera) => setDialog({ kind: "camera", camera: structuredClone(camera), isNew: false })}
          onNotifications={(camera) => { unlockMotionSound(); void updateCamera(camera, c => ({ notificationsEnabled: !c.notificationsEnabled })); }}
          onPrivacy={(camera, enabled) => void setPrivacy(camera, enabled)}
        />
      ) : (
        <>
          <div className="sv-bar">{switcher}</div>
          <RecordingsBrowser />
        </>
      )}

      {dialog?.kind === "camera" ? (
        <CameraDialog
          camera={dialog.camera}
          isNew={dialog.isNew}
          onClose={() => setDialog(null)}
          onSave={async (camera) => {
            const cameras = dialog.isNew ? [camera, ...current.cameras] : current.cameras.map((c) => (c.id === camera.id ? camera : c));
            await saveConfig({ ...current, cameras });
            setDialog(null);
          }}
          onRemove={async () => {
            await saveConfig({ ...current, cameras: current.cameras.filter((c) => c.id !== dialog.camera.id) });
            setDialog(null);
          }}
          onRediscovered={(next) => setCurrent(next)}
        />
      ) : null}
      {dialog?.kind === "discover" ? (
        <DiscoverDialog
          onClose={() => setDialog(null)}
          onAdded={(next) => {
            setCurrent(next);
            setDialog(null);
          }}
          onManual={() => setDialog({ kind: "camera", camera: blankCamera(), isNew: true })}
        />
      ) : null}
      {dialog?.kind === "settings" ? (
        <RecordingDialog
          config={current}
          statuses={recording.data?.cameras ?? []}
          onClose={() => setDialog(null)}
          onSave={async (settings) => {
            await saveConfig({
              recordingRoot: settings.recordingRoot,
              ffmpegPath: settings.ffmpegPath,
              recording: { ...settings.recording, mode: current.recording.mode },
              cameras: current.cameras.map((c) => ({ ...c, recordEnabled: settings.recordCameras[c.id] ?? c.recordEnabled })),
            });
            await recording.refresh();
            setDialog(null);
          }}
        />
      ) : null}
    </div>
  );
}

/** The camera grid shares its picture socket with motion notifications. */
function LiveView(props: {
  toolbar: ReactNode;
  cameras: Camera[];
  statuses: CameraRecording[];
  onDiscover: () => void;
  onCollapse: (camera: Camera) => void;
  onEdit: (camera: Camera) => void;
  onNotifications: (camera: Camera) => void;
  onPrivacy: (camera: Camera, enabled: boolean) => void;
}) {
  const { store, state: streamState, reconnect } = useFrameStream();
  const [enlarged, setEnlarged] = useState<Camera | null>(null);
  const statusById = new Map(props.statuses.map((s) => [s.cameraId, s]));
  return (
    <>
      <div className="sv-bar">
        {props.toolbar}
        <span className="sv-bar-spacer" />
        <StreamState state={streamState} onRetry={reconnect} />
        <button className="btn ghost sm" onClick={props.onDiscover}>
          <Icon name="plus" size={13} /> Add camera
        </button>
      </div>
      {props.cameras.length === 0 ? (
        <div className="mod-empty">
          <p>No cameras yet. Discovery probes a camera's address for its streams and snapshot URL.</p>
          <button className="btn primary sm" onClick={props.onDiscover}>
            <Icon name="search" size={13} /> Find a camera
          </button>
        </div>
      ) : (
        <div className="sv-grid">
          {props.cameras.map((camera) => (
            <CameraTile
              key={camera.id}
              camera={camera}
              store={store}
              recording={statusById.get(camera.id) ?? null}
              onCollapse={() => props.onCollapse(camera)}
              onEdit={() => props.onEdit(camera)}
              onView={() => setEnlarged(camera)}
              onNotifications={() => props.onNotifications(camera)}
              onPrivacy={(enabled) => props.onPrivacy(camera, enabled)}
            />
          ))}
        </div>
      )}
      {enlarged ? (
        <CameraViewer key={enlarged.id} name={enlarged.name} onClose={() => setEnlarged(null)} age={<FrameAge store={store} id={enlarged.id} />}>
          <LiveFrame store={store} camera={enlarged} large />
        </CameraViewer>
      ) : null}
    </>
  );
}

// ---- live frames ----------------------------------------------------------------------------------

function useFrame(store: FrameStore, id: string): LiveFrameEntry | null {
  return useSyncExternalStore(
    (listener) => store.subscribe(id, listener),
    () => store.get(id),
  );
}

function StreamState({ state, onRetry }: { state: StreamStatus; onRetry: () => void }) {
  if (state === "live") return <span className="mod-chip on">Live</span>;
  if (state === "paused") return <span className="mod-chip">Paused while hidden</span>;
  if (state === "connecting") return <span className="mod-chip">Connecting…</span>;
  return (
    <button className="mod-chip bad" onClick={onRetry} title="The picture stream dropped; it retries on its own. Click to retry now.">
      Pictures offline · retry
    </button>
  );
}

function LiveFrame({ store, camera, large }: { store: FrameStore; camera: Camera; large?: boolean }) {
  const frame = useFrame(store, camera.id);
  const style = !large && camera.previewHeight ? { height: camera.previewHeight } : undefined;
  return (
    <div className={`sv-frame${large ? " large" : ""}${camera.previewHeight && !large ? " fixed" : ""}`} style={style}>
      {frame ? <img src={frame.url} alt={`${camera.name}, live`} /> : <span className="sv-frame-empty">{camera.previewStrategy === "none" && !camera.snapshotUrl ? "No preview source" : "Waiting for a picture…"}</span>}
    </div>
  );
}

function FrameAge({ store, id }: { store: FrameStore; id: string }) {
  const frame = useFrame(store, id);
  const [, tick] = useState(0);
  useEffect(() => {
    const timer = window.setInterval(() => tick((n) => n + 1), 5_000);
    return () => window.clearInterval(timer);
  }, []);
  if (!frame) return <span className="mono faint">no picture yet</span>;
  const stale = Date.now() - frame.at > STALE_FRAME_MS;
  return <span className={`mono ${stale ? "sv-stale" : "faint"}`}>{stale ? `picture is ${formatAgo(frame.at)}` : `picture ${formatAgo(frame.at)}`}</span>;
}

function CameraTile(props: { camera: Camera; store: FrameStore; recording: CameraRecording | null; onCollapse: () => void; onEdit: () => void; onView: () => void; onNotifications: () => void; onPrivacy: (enabled: boolean) => void }) {
  const { camera, recording } = props;
  const reolink = /reolink/i.test(camera.vendor) || /reolink/i.test(camera.modelPreset);
  const privacy = camera.privacyMode?.enabled === true;
  return (
    <article className={`sv-tile${camera.uiCollapsed ? " collapsed" : ""}`} style={{ "--span": camera.gridSpan } as React.CSSProperties}>
      <header className="sv-tile-head">
        <button className="sv-tile-title" onClick={props.onCollapse} aria-expanded={!camera.uiCollapsed} title={camera.uiCollapsed ? "Show the picture" : "Fold the picture away"}>
          <h4>{camera.name}</h4>
          {camera.location ? <span className="faint">{camera.location}</span> : null}
        </button>
        {recording ? (
          <span className={`mod-badge mod-badge-${recording.state === "recording" ? "recording" : recording.state === "connecting" ? "pending" : "stopped"}`} title={recording.failures ? `${recording.failures} failed connection attempts` : undefined}>
            {RECORDING_LABEL[recording.state]}
            {recording.usingSubStream ? " · sub" : ""}
          </span>
        ) : null}
        <button className={`mod-chip${camera.notificationsEnabled ? " on" : ""}`} onClick={props.onNotifications} aria-label={`Motion notifications for ${camera.name}`} aria-pressed={camera.notificationsEnabled === true} title="Ping and count motion while this console is open">
          Notifications {camera.notificationsEnabled ? "on" : "off"}
        </button>
        {reolink ? (
          <button className={`mod-icon-btn${privacy ? " on" : ""}`} onClick={() => props.onPrivacy(!privacy)} title={privacy ? "Privacy mode is on: alerts are muted. Click to turn alerts back on." : "Turn on privacy mode: mute push and email alerts"} aria-pressed={privacy}>
            <Icon name="shield" size={15} />
          </button>
        ) : null}
        <button className="mod-icon-btn" onClick={props.onView} aria-label={`Enlarge ${camera.name}`} title="Enlarge">
          <Icon name="maximize" size={15} />
        </button>
        <button className="mod-icon-btn" onClick={props.onEdit} aria-label={`Edit ${camera.name}`} title="Edit">
          <Icon name="pencil" size={14} />
        </button>
      </header>
      {camera.uiCollapsed ? null : (
        <>
          <button className="sv-open-camera" onClick={props.onView} aria-label={`Open ${camera.name} fullscreen`} title="Open fullscreen">
            <LiveFrame store={props.store} camera={camera} />
          </button>
          <footer className="sv-tile-foot">
            <FrameAge store={props.store} id={camera.id} />
            {recording?.retryAt ? <span className="mono sv-stale">retrying {formatAgo(recording.retryAt).replace(" ago", "")}</span> : null}
          </footer>
        </>
      )}
    </article>
  );
}

// ---- editors --------------------------------------------------------------------------------------

function blankCamera(): Camera {
  return {
    id: "",
    name: "New camera",
    vendor: "",
    model: "",
    modelPreset: "",
    location: "",
    host: "",
    port: 80,
    username: "",
    password: "",
    onvifUrl: "",
    snapshotUrl: "",
    streamUrl: "",
    subStreamUrl: "",
    previewStrategy: "none",
    refreshMs: 5000,
    gridSpan: 6,
    previewHeight: 0,
    uiCollapsed: false,
    notificationsEnabled: false,
    recordEnabled: true,
    recordingDir: "",
    recordingFps: 2,
    recordingWidth: 1280,
    recordingHeight: 720,
    recordingBitrateKbps: null,
    muteStaleAlert: false,
    notes: "",
    privacyMode: null,
  };
}

function usePresets(): Preset[] {
  const presets = usePoll((signal) => moduleJson<{ presets: Preset[] }>("surveillance", "/presets", { signal }), null);
  return presets.data?.presets ?? [];
}

function CameraDialog(props: { camera: Camera; isNew: boolean; onClose: () => void; onSave: (camera: Camera) => Promise<void>; onRemove: () => Promise<void>; onRediscovered: (config: SurveillanceConfig) => void }) {
  const [camera, setCamera] = useState(props.camera);
  const [busy, setBusy] = useState<"save" | "remove" | "rediscover" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const presets = usePresets();
  const set = <K extends keyof Camera>(key: K, value: Camera[K]) => setCamera((c) => ({ ...c, [key]: value }));
  const num = (value: string, fallback: number) => (value === "" ? fallback : Number(value));

  const run = async (kind: "save" | "remove" | "rediscover", work: () => Promise<void>) => {
    setBusy(kind);
    setError(null);
    try {
      await work();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(null);
    }
  };

  const rediscover = () =>
    run("rediscover", async () => {
      const answer = await moduleJson<SurveillanceConfig & { discovery: Discovery }>("surveillance", `/cameras/${encodeURIComponent(camera.id)}/rediscover`, { method: "POST", body: {} });
      props.onRediscovered(answer);
      const updated = answer.cameras.find((c) => c.id === camera.id);
      if (updated) setCamera(updated);
      setNote(`Found ${answer.discovery.detectedVendor || "an unknown vendor"}; open ports ${answer.discovery.openPorts.join(", ") || "none"}. The URLs below are updated.`);
    });

  return (
    <ModuleDialog
      title={props.isNew ? "New camera" : camera.name}
      wide
      onClose={props.onClose}
      footer={
        <>
          {error ? <span className="mod-dialog-error">{error}</span> : null}
          {!props.isNew ? (
            <button className="btn danger sm mod-foot-left" disabled={busy !== null} onClick={() => window.confirm(`Remove ${camera.name}? Its recordings stay on disk.`) && void run("remove", props.onRemove)}>
              <Icon name="trash" size={13} /> Remove
            </button>
          ) : null}
          <button className="btn ghost sm" onClick={props.onClose}>
            Cancel
          </button>
          <button className="btn primary sm" disabled={busy !== null} onClick={() => void run("save", () => props.onSave(camera))}>
            {busy === "save" ? "Saving…" : "Save camera"}
          </button>
        </>
      }
    >
      {note ? <p className="mod-dialog-lede">{note}</p> : null}
      <fieldset className="mod-fieldset">
        <legend>Camera</legend>
        <div className="mod-fields">
          <Field label="Name">
            <input className="mod-input" value={camera.name} onChange={(e) => set("name", e.target.value)} />
          </Field>
          <Field label="Motion notifications" hint="Ping and count movement while this console is open, including other tabs. One alert per camera every 30 seconds; picture changes and lighting can trigger alerts.">
            <label><input type="checkbox" checked={camera.notificationsEnabled === true} onChange={(e) => { unlockMotionSound(); set("notificationsEnabled", e.target.checked); }} /> Notifications on</label>
          </Field>
          <Field label="Location">
            <input className="mod-input" value={camera.location} onChange={(e) => set("location", e.target.value)} />
          </Field>
          <Field label="Model preset" hint="Tells discovery which stream paths and ports to try.">
            <select className="mod-select" value={camera.modelPreset} onChange={(e) => set("modelPreset", e.target.value)}>
              <option value="">Unknown</option>
              {presets.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.vendor} {p.model}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Vendor · model">
            <div className="mod-pair">
              <input className="mod-input" value={camera.vendor} onChange={(e) => set("vendor", e.target.value)} aria-label="Vendor" />
              <input className="mod-input" value={camera.model} onChange={(e) => set("model", e.target.value)} aria-label="Model" />
            </div>
          </Field>
        </div>
      </fieldset>
      <fieldset className="mod-fieldset">
        <legend>Connection</legend>
        <div className="mod-fields">
          <Field label="Address">
            <input className="mod-input mono" value={camera.host} onChange={(e) => set("host", e.target.value)} placeholder="192.0.2.20" />
          </Field>
          <Field label="Web port">
            <input className="mod-input" type="number" min={1} max={65535} value={camera.port} onChange={(e) => set("port", num(e.target.value, 80))} />
          </Field>
          <Field label="User name">
            <input className="mod-input" autoComplete="off" value={camera.username} onChange={(e) => set("username", e.target.value)} />
          </Field>
          <Field label="Password" hint={camera.passwordSet ? "Saved. Leave the dots to keep it." : undefined}>
            <input className="mod-input" type="password" autoComplete="new-password" value={camera.password} onChange={(e) => set("password", e.target.value)} />
          </Field>
        </div>
        {!props.isNew ? (
          <button className="btn ghost sm" disabled={busy !== null || !camera.host} onClick={() => void rediscover()} title="Probe the saved address again for streams and a snapshot URL (save changes first)">
            <Icon name="search" size={13} /> {busy === "rediscover" ? "Probing… (up to a minute)" : "Rediscover streams"}
          </button>
        ) : null}
      </fieldset>
      <fieldset className="mod-fieldset">
        <legend>Picture</legend>
        <div className="mod-fields">
          <Field label="Snapshot URL" wide hint="Saved passwords show as ********; leave them to keep them.">
            <input className="mod-input mono" value={camera.snapshotUrl} onChange={(e) => set("snapshotUrl", e.target.value)} />
          </Field>
          <Field label="Main stream (RTSP)" wide>
            <input className="mod-input mono" value={camera.streamUrl} onChange={(e) => set("streamUrl", e.target.value)} />
          </Field>
          <Field label="Sub stream (RTSP)" wide hint="Recording falls back to it when the main stream fails.">
            <input className="mod-input mono" value={camera.subStreamUrl} onChange={(e) => set("subStreamUrl", e.target.value)} />
          </Field>
          <Field label="ONVIF URL" wide>
            <input className="mod-input mono" value={camera.onvifUrl} onChange={(e) => set("onvifUrl", e.target.value)} />
          </Field>
          <Field label="Live preview from">
            <select className="mod-select" value={camera.previewStrategy} onChange={(e) => set("previewStrategy", e.target.value as PreviewStrategy)}>
              <option value="snapshot">Snapshot URL</option>
              <option value="rtsp-mjpeg-proxy">RTSP stream (uses ffmpeg)</option>
              <option value="none">Automatic</option>
            </select>
          </Field>
          <Field label="Snapshot every (ms)" hint="While not recording. 250 or more.">
            <input className="mod-input" type="number" min={250} step={250} value={camera.refreshMs} onChange={(e) => set("refreshMs", num(e.target.value, 5000))} />
          </Field>
          <Field label="Tile width" hint="In twelfths of the grid; 12 is full width.">
            <input className="mod-input" type="number" min={3} max={12} value={camera.gridSpan} onChange={(e) => set("gridSpan", num(e.target.value, 6))} />
          </Field>
          <Field label="Picture height (px)" hint="0 keeps 16:9.">
            <input className="mod-input" type="number" min={0} max={4000} value={camera.previewHeight} onChange={(e) => set("previewHeight", num(e.target.value, 0))} />
          </Field>
        </div>
      </fieldset>
      <fieldset className="mod-fieldset">
        <legend>Recording</legend>
        <label className="mod-check sv-record-toggle">
          <input type="checkbox" checked={camera.recordEnabled} onChange={(e) => set("recordEnabled", e.target.checked)} /> Record this camera when recording is on (24/7 or on the schedule)
        </label>
        <div className="mod-fields">
          <Field label="Folder" wide hint="Blank records into a folder named after the camera under the recording folder.">
            <input className="mod-input mono" value={camera.recordingDir} onChange={(e) => set("recordingDir", e.target.value)} />
          </Field>
          <Field label="Frames per second">
            <input className="mod-input" type="number" min={1} max={12} value={camera.recordingFps} onChange={(e) => set("recordingFps", num(e.target.value, 2))} />
          </Field>
          <Field label="Size (width × height)" hint="Blank picks a size from the model.">
            <div className="mod-pair">
              <input className="mod-input" type="number" min={160} max={1920} value={camera.recordingWidth || ""} onChange={(e) => set("recordingWidth", num(e.target.value, 0))} aria-label="Width" />
              <input className="mod-input" type="number" min={120} max={1080} value={camera.recordingHeight || ""} onChange={(e) => set("recordingHeight", num(e.target.value, 0))} aria-label="Height" />
            </div>
          </Field>
          <Field label="Bitrate (kbit/s)" hint="Blank lets ffmpeg choose.">
            <input className="mod-input" type="number" min={64} max={4000} value={camera.recordingBitrateKbps ?? ""} onChange={(e) => set("recordingBitrateKbps", e.target.value === "" ? null : Number(e.target.value))} />
          </Field>
          <div className="mod-field mod-field-checks">
            <label className="mod-check">
              <input type="checkbox" checked={camera.muteStaleAlert} onChange={(e) => set("muteStaleAlert", e.target.checked)} /> Don't alert when this camera's recording goes stale
            </label>
          </div>
          <Field label="Notes" wide>
            <textarea className="mod-input" rows={2} value={camera.notes} onChange={(e) => set("notes", e.target.value)} />
          </Field>
        </div>
      </fieldset>
    </ModuleDialog>
  );
}

function DiscoverDialog({ onClose, onAdded, onManual }: { onClose: () => void; onAdded: (config: SurveillanceConfig) => void; onManual: () => void }) {
  const presets = usePresets();
  const [form, setForm] = useState({ host: "", port: "80", username: "admin", password: "", modelPreset: "" });
  const [busy, setBusy] = useState<"discover" | "add" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<Discovery | null>(null);

  const discover = async () => {
    setBusy("discover");
    setError(null);
    setResult(null);
    try {
      setResult(await moduleJson<Discovery>("surveillance", "/discover", { method: "POST", body: { ...form, port: Number(form.port) || 80 } }));
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(null);
    }
  };

  const add = async () => {
    if (!result?.draftId) return;
    setBusy("add");
    setError(null);
    try {
      onAdded(await moduleJson<SurveillanceConfig>("surveillance", "/cameras/from-discovery", { method: "POST", body: { draftId: result.draftId } }));
    } catch (err) {
      setError(errorText(err));
      setBusy(null);
    }
  };

  return (
    <ModuleDialog
      title="Add a camera"
      wide
      onClose={onClose}
      footer={
        <>
          {error ? <span className="mod-dialog-error">{error}</span> : null}
          <button className="btn ghost sm mod-foot-left" onClick={onManual}>
            Enter it by hand
          </button>
          <button className="btn ghost sm" disabled={busy !== null || !form.host.trim()} onClick={() => void discover()}>
            <Icon name="search" size={13} /> {busy === "discover" ? "Probing… (up to a minute)" : result ? "Probe again" : "Probe camera"}
          </button>
          {result ? (
            <button className="btn primary sm" disabled={busy !== null || !result.draftId} onClick={() => void add()}>
              {busy === "add" ? "Adding…" : "Add this camera"}
            </button>
          ) : null}
        </>
      }
    >
      <p className="mod-dialog-lede">Discovery sweeps the camera's ports, reads its web page for a vendor, and tries the known ONVIF, RTSP and snapshot paths with these credentials.</p>
      <div className="mod-fields">
        <Field label="Address">
          <input className="mod-input mono" value={form.host} onChange={(e) => setForm({ ...form, host: e.target.value })} placeholder="192.0.2.20" autoFocus />
        </Field>
        <Field label="Web port">
          <input className="mod-input" type="number" value={form.port} onChange={(e) => setForm({ ...form, port: e.target.value })} />
        </Field>
        <Field label="User name">
          <input className="mod-input" autoComplete="off" value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value })} />
        </Field>
        <Field label="Password">
          <input className="mod-input" type="password" autoComplete="new-password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} />
        </Field>
        <Field label="Model" hint="Optional; discovery guesses from the web page.">
          <select className="mod-select" value={form.modelPreset} onChange={(e) => setForm({ ...form, modelPreset: e.target.value })}>
            <option value="">Detect</option>
            {presets.map((p) => (
              <option key={p.id} value={p.id}>
                {p.vendor} {p.model}
              </option>
            ))}
          </select>
        </Field>
      </div>
      {result ? <DiscoveryResult result={result} /> : null}
    </ModuleDialog>
  );
}

function DiscoveryResult({ result }: { result: Discovery }) {
  const snapshotOk = result.snapshotProbes.find((p) => p.ok);
  return (
    <div className="sv-discovery">
      <h4>
        {result.matchedPreset ? `${result.matchedPreset.vendor} ${result.matchedPreset.model}` : result.detectedVendor || "Unknown camera"}
        <span className="mono faint"> · open ports {result.openPorts.join(", ") || "none"}</span>
      </h4>
      <dl>
        <dt>Snapshot</dt>
        <dd className={snapshotOk ? "ok" : "bad"}>{snapshotOk ? <code>{snapshotOk.url}</code> : "no snapshot path answered"}</dd>
        <dt>Streams</dt>
        <dd>{result.rtspCandidates.length ? result.rtspCandidates.map((c) => <code key={c.url}>{c.label}: {c.url}</code>) : <span className="bad">no RTSP port open</span>}</dd>
        <dt>ONVIF</dt>
        <dd>{result.onvifProbes.some((p) => p.ok) ? <code>{result.onvifProbes.find((p) => p.ok)!.url}</code> : <span className="faint">not answering</span>}</dd>
      </dl>
      {result.matchedPreset?.notes.length ? (
        <ul className="sv-discovery-notes">
          {result.matchedPreset.notes.map((n, i) => (
            <li key={i}>{n}</li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
