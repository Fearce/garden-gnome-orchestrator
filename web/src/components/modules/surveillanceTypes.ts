// The Surveillance worker's JSON shapes as the tab reads them (server/src/modules/worker/surveillance).

export type PreviewStrategy = "snapshot" | "rtsp-mjpeg-proxy" | "none";
export type RecordingMode = "off" | "continuous" | "schedule";

export interface Camera {
  id: string;
  name: string;
  vendor: string;
  model: string;
  modelPreset: string;
  location: string;
  host: string;
  port: number;
  username: string;
  password: string;
  passwordSet?: boolean;
  onvifUrl: string;
  snapshotUrl: string;
  streamUrl: string;
  subStreamUrl: string;
  previewStrategy: PreviewStrategy;
  refreshMs: number;
  gridSpan: number;
  previewHeight: number;
  uiCollapsed: boolean;
  notificationsEnabled: boolean;
  recordEnabled: boolean;
  recordingDir: string;
  recordingFps: number;
  recordingWidth: number;
  recordingHeight: number;
  recordingBitrateKbps: number | null;
  muteStaleAlert: boolean;
  notes: string;
  privacyMode: { enabled: boolean; updatedAt: string | null; lastResult: unknown } | null;
}

export interface RecordingSchedule {
  days: number[];
  start: string;
  end: string;
}

export interface RecordingSettings {
  mode: RecordingMode;
  schedule: RecordingSchedule;
  segmentMinutes: number;
  retentionDays: number;
  maxGbPerCamera: number;
}

export interface SurveillanceConfig {
  origin: "dashboard-deck" | "new" | "deck-unreachable";
  importedAt: number | null;
  recordingRoot: string;
  ffmpegPath: string;
  ffmpegFound: boolean;
  recording: RecordingSettings;
  cameras: Camera[];
}

export interface CameraRecording {
  cameraId: string;
  state: "recording" | "connecting" | "waiting" | "not-configured" | "disabled";
  usingSubStream: boolean;
  targetDir: string | null;
  lastFrameAt: number | null;
  retryAt: number | null;
  failures: number;
}

export interface RecordingView {
  mode: RecordingMode;
  active: boolean;
  inWindow: boolean | null;
  nextChangeAt: number | null;
  lastError: string | null;
  schedule: RecordingSchedule;
  segmentMinutes: number;
  recordingRoot: string;
  cameras: CameraRecording[];
}

export interface SweepResult {
  at: number;
  deletedFiles: number;
  deletedBytes: number;
  failed: number;
  pending: boolean;
  error: string | null;
}

export interface RecordingsSummary {
  retention: { retentionDays: number; maxGbPerCamera: number; enabled: boolean; lastSweep: SweepResult | null };
  cameras: {
    cameraId: string;
    name: string;
    folderFound: boolean;
    error: string | null;
    segments: number;
    bytes: number;
    oldestAt: number | null;
    newestAt: number | null;
    days: { day: string; count: number; bytes: number }[];
  }[];
}

export interface RecordedSegment {
  name: string;
  startAt: number;
  bytes: number;
  modifiedAt: number;
  live: boolean;
}

export const SEGMENT_MINUTE_CHOICES = [1, 5, 10, 15, 30, 60];

/** Monday first, the way a week reads here; values are JavaScript's getDay() numbers. */
export const WEEK = [
  { day: 1, short: "Mon" },
  { day: 2, short: "Tue" },
  { day: 3, short: "Wed" },
  { day: 4, short: "Thu" },
  { day: 5, short: "Fri" },
  { day: 6, short: "Sat" },
  { day: 0, short: "Sun" },
];

export function describeDays(days: number[]): string {
  const set = new Set(days);
  if (set.size === 7) return "Every day";
  if (set.size === 0) return "No days chosen";
  if (set.size === 5 && [1, 2, 3, 4, 5].every((d) => set.has(d))) return "Weekdays";
  if (set.size === 2 && set.has(0) && set.has(6)) return "Weekends";
  return WEEK.filter((w) => set.has(w.day)).map((w) => w.short).join(", ");
}

export function describeSchedule(schedule: RecordingSchedule): string {
  const allDay = schedule.start === schedule.end;
  return `${describeDays(schedule.days)}, ${allDay ? "all day" : `${schedule.start}–${schedule.end}`}`;
}

/** "07:00" today or tomorrow morning, "Mon 22:00" further out. */
export function formatWhen(at: number, now = Date.now()): string {
  const date = new Date(at);
  const time = date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return at - now < 20 * 3_600_000 ? time : `${date.toLocaleDateString([], { weekday: "short" })} ${time}`;
}

export function formatDay(day: string): string {
  const [y, m, d] = day.split("-").map(Number) as [number, number, number];
  return new Date(y, m - 1, d).toLocaleDateString([], { weekday: "short", day: "numeric", month: "short" });
}

export function formatClock(at: number): string {
  return new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}
