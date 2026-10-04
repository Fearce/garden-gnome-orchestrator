import { useEffect, useState } from "react";
import { Icon, Loading, Notice } from "./ModuleFrame.js";
import { usePoll } from "./hooks.js";
import { errorText, formatAgo, formatBytes, moduleJson, moduleUrl } from "./moduleApi.js";
import { formatClock, formatDay, type RecordedSegment, type RecordingsSummary, type SweepResult } from "./surveillanceTypes.js";

type CameraSummary = RecordingsSummary["cameras"][number];

/**
 * What the cameras recorded: pick a camera, a day, then a segment to play here or download. Files are
 * named by the worker's library from each camera's own folder, so this page only ever passes a camera id
 * and a segment name.
 */
export function RecordingsBrowser() {
  const summary = usePoll((signal) => moduleJson<RecordingsSummary>("surveillance", "/recordings", { signal }), 60_000);
  const [cameraId, setCameraId] = useState<string | null>(null);
  const [day, setDay] = useState<string | null>(null);

  const cameras = summary.data?.cameras ?? [];
  const camera = cameras.find((c) => c.cameraId === cameraId) ?? cameras.find((c) => c.segments > 0) ?? cameras[0] ?? null;
  const shownDay = camera?.days.find((d) => d.day === day)?.day ?? camera?.days[0]?.day ?? null;

  if (!summary.data) {
    if (summary.error) {
      return (
        <Notice tone="bad" title="Recordings could not be listed" onRetry={() => void summary.refresh()}>
          {errorText(summary.error)}
        </Notice>
      );
    }
    return <Loading label="Reading the recording folders…" />;
  }

  return (
    <div className="sv-library">
      <RetentionLine retention={summary.data.retention} onCleaned={() => void summary.refresh()} />
      {cameras.length === 0 ? (
        <div className="mod-empty">
          <p>No camera has a recording folder yet. Set one under Recording settings; recordings appear here once a camera has recorded.</p>
        </div>
      ) : (
        <div className="sv-lib">
          <aside className="sv-lib-side">
            <h4 className="sv-lib-heading">Cameras</h4>
            <ul className="sv-lib-list" aria-label="Cameras">
              {cameras.map((c) => (
                <li key={c.cameraId}>
                  <button
                    className={`sv-lib-item${c.cameraId === camera?.cameraId ? " on" : ""}`}
                    aria-current={c.cameraId === camera?.cameraId}
                    onClick={() => {
                      setCameraId(c.cameraId);
                      setDay(null);
                    }}
                  >
                    <strong>{c.name}</strong>
                    <span className="mono faint">{c.segments ? `${formatBytes(c.bytes)} · ${c.days.length} day${c.days.length === 1 ? "" : "s"}` : "nothing yet"}</span>
                  </button>
                </li>
              ))}
            </ul>
            {camera && camera.days.length > 0 ? (
              <>
                <h4 className="sv-lib-heading">Days</h4>
                <ul className="sv-lib-list sv-lib-days" aria-label="Days">
                  {camera.days.map((d) => (
                    <li key={d.day}>
                      <button className={`sv-lib-item${d.day === shownDay ? " on" : ""}`} aria-current={d.day === shownDay} onClick={() => setDay(d.day)}>
                        <strong>{formatDay(d.day)}</strong>
                        <span className="mono faint">
                          {d.count} file{d.count === 1 ? "" : "s"} · {formatBytes(d.bytes)}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              </>
            ) : null}
          </aside>
          <div className="sv-lib-main">{camera ? <CameraRecordings key={camera.cameraId} camera={camera} day={shownDay} /> : null}</div>
        </div>
      )}
    </div>
  );
}

function CameraRecordings({ camera, day }: { camera: CameraSummary; day: string | null }) {
  if (camera.error) {
    return (
      <Notice tone="bad" title={`${camera.name}'s folder could not be read`}>
        {camera.error}
      </Notice>
    );
  }
  if (!day) {
    return (
      <div className="mod-empty">
        <p>{camera.folderFound ? `${camera.name} has no recordings in its folder yet.` : `${camera.name} has not recorded yet: its folder is created with the first recording.`}</p>
      </div>
    );
  }
  return <DayRecordings key={day} camera={camera} day={day} />;
}

function DayRecordings({ camera, day }: { camera: CameraSummary; day: string }) {
  const listing = usePoll((signal) => moduleJson<{ segments: RecordedSegment[] }>("surveillance", `/recordings/${encodeURIComponent(camera.cameraId)}/days/${day}`, { signal }), 30_000);
  const [playing, setPlaying] = useState<string | null>(null);
  const segments = listing.data?.segments ?? [];
  const index = segments.findIndex((s) => s.name === playing);
  const current = index >= 0 ? segments[index]! : null;

  if (!listing.data) {
    if (listing.error) {
      return (
        <Notice tone="bad" title="That day could not be listed" onRetry={() => void listing.refresh()}>
          {errorText(listing.error)}
        </Notice>
      );
    }
    return <Loading label={`Listing ${formatDay(day)}…`} />;
  }

  return (
    <>
      {current ? (
        <Player
          key={current.name}
          cameraId={camera.cameraId}
          cameraName={camera.name}
          segment={current}
          onPrevious={index > 0 ? () => setPlaying(segments[index - 1]!.name) : null}
          onNext={index < segments.length - 1 ? () => setPlaying(segments[index + 1]!.name) : null}
          onClose={() => setPlaying(null)}
        />
      ) : null}
      <div className="sv-lib-day">
        <header>
          <h4>
            {camera.name} · {formatDay(day)}
          </h4>
          <span className="mono faint">
            {segments.length} file{segments.length === 1 ? "" : "s"} · {formatBytes(segments.reduce((sum, s) => sum + s.bytes, 0))}
          </span>
        </header>
        {segments.length === 0 ? (
          <p className="mod-field-hint">These files were deleted since the list was read.</p>
        ) : (
          <ol className="sv-segments">
            {segments.map((segment) => (
              <SegmentRow key={segment.name} cameraId={camera.cameraId} segment={segment} playing={segment.name === playing} onPlay={() => setPlaying(segment.name)} />
            ))}
          </ol>
        )}
      </div>
    </>
  );
}

function segmentPath(cameraId: string, name: string): string {
  return `/recordings/${encodeURIComponent(cameraId)}/segments/${encodeURIComponent(name)}`;
}

function SegmentRow({ cameraId, segment, playing, onPlay }: { cameraId: string; segment: RecordedSegment; playing: boolean; onPlay: () => void }) {
  const path = segmentPath(cameraId, segment.name);
  const range = `${formatClock(segment.startAt)}–${segment.live ? "now" : formatClock(segment.modifiedAt)}`;
  return (
    <li className={`sv-segment${playing ? " on" : ""}`}>
      <button className="sv-segment-play" onClick={onPlay} aria-label={`Play ${range}`} title="Play here">
        <Icon name={playing ? "video" : "play"} size={13} />
        <span className="mono">{range}</span>
      </button>
      {segment.live ? <span className="mod-badge mod-badge-recording">recording</span> : null}
      <span className="mono faint sv-segment-size">{formatBytes(segment.bytes)}</span>
      <a className="mod-icon-btn" href={moduleUrl("surveillance", `${path}/video?download=1&v=${segment.bytes}`)} download title="Download as MP4" aria-label={`Download ${range} as MP4`}>
        <Icon name="download" size={14} />
      </a>
      <a className="mod-icon-btn" href={moduleUrl("surveillance", `${path}/file`)} download title="Download the original recording (.ts)" aria-label={`Download the original ${range} file`}>
        <Icon name="film" size={14} />
      </a>
    </li>
  );
}

/** One segment, played from an MP4 the worker builds on first request (a few seconds for a long file). */
function Player(props: { cameraId: string; cameraName: string; segment: RecordedSegment; onPrevious: (() => void) | null; onNext: (() => void) | null; onClose: () => void }) {
  const { segment } = props;
  const path = segmentPath(props.cameraId, segment.name);
  // The size when playback began pins one MP4, so seeks (and the 30 s list refresh) of a growing segment stay on one copy.
  const [version] = useState(segment.bytes);
  const src = moduleUrl("surveillance", `${path}/video?v=${version}`);
  const [state, setState] = useState<"preparing" | "ready" | "failed">("preparing");
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => {
    if (state !== "failed") return;
    const abort = new AbortController();
    fetch(src, { headers: { range: "bytes=0-0" }, credentials: "same-origin", signal: abort.signal })
      .then(async (res) => {
        if (res.ok) return;
        const body = (await res.json().catch(() => ({}))) as { error?: unknown };
        setProblem(typeof body.error === "string" ? body.error : `HTTP ${res.status}`);
      })
      .catch(() => undefined);
    return () => abort.abort();
  }, [state, src]);

  return (
    <figure className="sv-player">
      <div className="sv-player-frame">
        <video key={src} src={src} controls autoPlay playsInline preload="auto" onLoadedData={() => setState("ready")} onError={() => setState("failed")} onEnded={() => props.onNext?.()} />
        {state === "preparing" ? (
          <div className="sv-player-cover">
            <Loading label="Preparing playback…" />
          </div>
        ) : null}
        {state === "failed" ? (
          <div className="sv-player-cover">
            <p>
              <strong>This recording could not be played here.</strong>
              <span>{problem ?? "Download the original file instead."}</span>
            </p>
          </div>
        ) : null}
      </div>
      <figcaption>
        <span>
          <strong>{props.cameraName}</strong>{" "}
          <span className="mono faint">
            {formatDay(segment.name.slice(0, 10))} {formatClock(segment.startAt)} · {formatBytes(segment.bytes)}
            {segment.live ? " · still recording, plays up to now" : ""}
          </span>
        </span>
        <span className="sv-player-actions">
          <button className="btn ghost sm" disabled={!props.onPrevious} onClick={() => props.onPrevious?.()}>
            Previous
          </button>
          <button className="btn ghost sm" disabled={!props.onNext} onClick={() => props.onNext?.()}>
            Next
          </button>
          <a className="btn ghost sm" href={`${src}&download=1`} download>
            <Icon name="download" size={13} /> MP4
          </a>
          <button className="mod-icon-btn" onClick={props.onClose} aria-label="Close the player" title="Close">
            <Icon name="x" size={15} />
          </button>
        </span>
      </figcaption>
    </figure>
  );
}

function RetentionLine({ retention, onCleaned }: { retention: RecordingsSummary["retention"]; onCleaned: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const rules = [retention.retentionDays ? `${retention.retentionDays} day${retention.retentionDays === 1 ? "" : "s"}` : null, retention.maxGbPerCamera ? `at most ${retention.maxGbPerCamera} GB per camera` : null].filter(Boolean);

  const cleanUp = async () => {
    setBusy(true);
    setError(null);
    try {
      await moduleJson<{ lastSweep: SweepResult }>("surveillance", "/recordings/cleanup", { method: "POST", body: {} });
      onCleaned();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="sv-retention">
      <span>
        {retention.enabled ? (
          <>
            Keeping <strong>{rules.join(", ")}</strong>; older files are deleted automatically.
          </>
        ) : (
          <>
            Keeping <strong>everything</strong>: nothing is deleted. Set a number of days or a size cap under Recording settings.
          </>
        )}
      </span>
      {retention.lastSweep ? <span className="mono faint">{sweepText(retention.lastSweep)}</span> : null}
      {error ? <span className="mod-dialog-error">{error}</span> : null}
      {retention.enabled ? (
        <button className="btn ghost sm" disabled={busy} onClick={() => void cleanUp()}>
          <Icon name="trash" size={13} /> {busy ? "Cleaning up…" : "Clean up now"}
        </button>
      ) : null}
    </div>
  );
}

function sweepText(sweep: SweepResult): string {
  if (sweep.error) return `last cleanup ${formatAgo(sweep.at)} failed: ${sweep.error}`;
  const removed = sweep.deletedFiles ? `removed ${sweep.deletedFiles} file${sweep.deletedFiles === 1 ? "" : "s"} (${formatBytes(sweep.deletedBytes)})` : "had nothing to remove";
  return `last cleanup ${formatAgo(sweep.at)} ${removed}${sweep.failed ? `, ${sweep.failed} could not be deleted` : ""}${sweep.pending ? "; more to go" : ""}`;
}
