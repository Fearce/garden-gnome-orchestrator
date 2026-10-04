import { FFMPEG_TAG } from "./processes.js";

/** Live tiles favour fidelity: up to 2560 px wide at 2 fps, JPEG quality 2. */
export const LIVE_PREVIEW_FPS = 2;
const MAX_LIVE_PREVIEW_WIDTH = 2560;
const LIVE_PREVIEW_JPEG_Q = 2;

export function rtspInputArgs(sourceUrl: string, logLevel: "warning" | "error"): string[] {
  return [
    "-hide_banner",
    "-loglevel", logLevel,
    "-rtsp_transport", "tcp",
    // 8 s socket I/O timeout (µs); without it a dead camera leaves a pipe open forever.
    "-timeout", "8000000",
    "-fflags", "+nobuffer+discardcorrupt",
    "-flags", "low_delay",
    "-use_wallclock_as_timestamps", "1",
    "-i", sourceUrl,
  ];
}

/** The live-preview output: multipart JPEG on stdout, each part with its own Content-Length. */
export function previewOutputArgs(): string[] {
  return [
    "-map", "0:v:0",
    "-an",
    "-vf", `fps=${LIVE_PREVIEW_FPS},scale='min(${MAX_LIVE_PREVIEW_WIDTH},iw):-2'`,
    "-q:v", String(LIVE_PREVIEW_JPEG_Q),
    "-c:v", "mjpeg",
    "-f", "mpjpeg",
    "-boundary_tag", FFMPEG_TAG,
    "pipe:1",
  ];
}

export interface RecordingQuality {
  fps: number;
  width: number;
  height: number;
  bitrateKbps: number;
}

/** Long-term storage stays tiny: low fps, size and bitrate, cut into fixed-length files at a per-camera offset. */
export function segmentOutputArgs(quality: RecordingQuality, outputPattern: string, clocktimeOffset: number, segmentSeconds: number): string[] {
  const scale = `scale='min(${quality.width},iw):min(${quality.height},ih):force_original_aspect_ratio=decrease'`;
  const gop = String(Math.max(1, quality.fps * 10));
  return [
    "-map", "0:v:0",
    "-an",
    "-vf", `fps=${quality.fps},${scale}`,
    "-c:v", "libx264",
    "-preset", "veryfast",
    "-tune", "zerolatency",
    "-pix_fmt", "yuv420p",
    "-g", gop,
    "-keyint_min", gop,
    "-sc_threshold", "0",
    "-b:v", `${quality.bitrateKbps}k`,
    "-maxrate", `${quality.bitrateKbps}k`,
    "-bufsize", `${quality.bitrateKbps * 2}k`,
    "-f", "segment",
    "-segment_format", "mpegts",
    "-segment_atclocktime", "1",
    "-segment_clocktime_offset", String(clocktimeOffset),
    "-segment_time", String(segmentSeconds),
    "-segment_time_delta", "1",
    "-reset_timestamps", "1",
    "-strftime", "1",
    outputPattern,
  ];
}
