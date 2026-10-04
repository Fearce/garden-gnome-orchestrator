import { randomBytes } from "node:crypto";
import { HttpError } from "../router.js";
import { defaultRecordingSettings, normalizeRecordingSettings, type RecordingSettings } from "./recordingPlan.js";

export type PreviewStrategy = "snapshot" | "rtsp-mjpeg-proxy" | "none";

export interface PrivacyState {
  enabled: boolean;
  updatedAt: string | null;
  lastResult: unknown;
}

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
  onvifUrl: string;
  snapshotUrl: string;
  streamUrl: string;
  subStreamUrl: string;
  previewStrategy: PreviewStrategy;
  refreshMs: number;
  /** Width in 12ths of the grid; above 6 is a "wide" tile. */
  gridSpan: number;
  /** Fixed preview height in px, or 0 for 16:9. */
  previewHeight: number;
  uiCollapsed: boolean;
  /** Whether this camera records while recording is on (24/7 or on schedule). */
  recordEnabled: boolean;
  recordingDir: string;
  recordingFps: number;
  /** 0 picks the size from the model (Duo lenses record at half size). */
  recordingWidth: number;
  recordingHeight: number;
  recordingBitrateKbps: number | null;
  /** Read by the stale-recording alert watcher; it skips a muted camera. */
  muteStaleAlert: boolean;
  notes: string;
  privacyMode: PrivacyState | null;
}

export interface SurveillanceConfig {
  recordingRoot: string;
  /** An ffmpeg the owner chose; blank uses GGO's own or the one on PATH. */
  ffmpegPath: string;
  recording: RecordingSettings;
  cameras: Camera[];
}

export const SECRET_MASK = "********";

export function emptyConfig(): SurveillanceConfig {
  return { recordingRoot: "", ffmpegPath: "", recording: defaultRecordingSettings(), cameras: [] };
}

export function newCameraId(): string {
  return `cam-${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`;
}

export function blankCamera(overrides: Partial<Camera> = {}): Camera {
  return {
    id: newCameraId(),
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
    recordEnabled: true,
    recordingDir: "",
    recordingFps: 2,
    recordingWidth: 1280,
    recordingHeight: 720,
    recordingBitrateKbps: null,
    muteStaleAlert: false,
    notes: "",
    privacyMode: null,
    ...overrides,
  };
}

/** Coerce anything camera-shaped (the Deck's saved JSON, a browser edit) into a well-formed camera. */
export function normalizeCamera(raw: unknown): Camera {
  const input = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const base = blankCamera();
  const legacyWide = Number(input.gridWidth) === 2;
  const span = clampInt(input.gridSpan, 3, 12, legacyWide ? 12 : 6);
  const strategy = input.previewStrategy;
  return {
    id: text(input.id, 80) || base.id,
    name: text(input.name, 120) || "Unnamed camera",
    vendor: text(input.vendor, 80),
    model: text(input.model, 120),
    modelPreset: text(input.modelPreset, 80),
    location: text(input.location, 120),
    host: text(input.host, 255),
    port: clampInt(input.port, 1, 65535, 80),
    username: text(input.username, 255),
    password: typeof input.password === "string" ? input.password.slice(0, 512) : "",
    onvifUrl: text(input.onvifUrl, 2048),
    snapshotUrl: text(input.snapshotUrl, 2048),
    streamUrl: text(input.streamUrl, 2048),
    subStreamUrl: text(input.subStreamUrl, 2048),
    previewStrategy: strategy === "snapshot" || strategy === "rtsp-mjpeg-proxy" ? strategy : "none",
    refreshMs: clampInt(input.refreshMs, 250, 120_000, 5000),
    gridSpan: span,
    previewHeight: clampInt(input.previewHeight, 0, 4000, 0),
    uiCollapsed: input.uiCollapsed === true,
    recordEnabled: input.recordEnabled !== false,
    recordingDir: text(input.recordingDir, 1024),
    recordingFps: clampInt(input.recordingFps, 1, 12, 2),
    recordingWidth: clampInt(input.recordingWidth, 160, 1920, 0),
    recordingHeight: clampInt(input.recordingHeight, 120, 1080, 0),
    recordingBitrateKbps: input.recordingBitrateKbps == null || input.recordingBitrateKbps === "" ? null : clampInt(input.recordingBitrateKbps, 64, 4000, 220),
    muteStaleAlert: input.muteStaleAlert === true,
    notes: typeof input.notes === "string" ? input.notes.slice(0, 4000) : "",
    privacyMode: normalizePrivacy(input.privacyMode),
  };
}

/** A config without a recording block predates it (the Deck's, or an early GGO one): it keeps every recording. */
export function normalizeConfig(raw: unknown): SurveillanceConfig {
  const input = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const cameras = Array.isArray(input.cameras) ? input.cameras.map(normalizeCamera) : [];
  const seen = new Set<string>();
  for (const camera of cameras) {
    if (seen.has(camera.id)) camera.id = newCameraId();
    seen.add(camera.id);
  }
  return {
    recordingRoot: text(input.recordingRoot, 1024),
    ffmpegPath: text(input.ffmpegPath, 1024),
    recording: normalizeRecordingSettings(input.recording, defaultRecordingSettings()),
    cameras,
  };
}

/**
 * The Deck's "surveillance" settings section. Its recording was parked by clearing `recordingRoot` and keeping
 * the folder in `recordingRootParked`; the folder is carried over either way, and recording stays off until
 * the owner starts it in GGO.
 */
export function fromDeckSection(section: unknown): SurveillanceConfig | null {
  if (!section || typeof section !== "object") return null;
  const deck = section as Record<string, unknown>;
  const config = normalizeConfig({ cameras: deck.cameras, recordingRoot: text(deck.recordingRoot, 1024) || text(deck.recordingRootParked, 1024) });
  return config.cameras.length || config.recordingRoot ? config : null;
}

/** What the browser sees: passwords, and credentials inside camera URLs, are replaced by a mask. */
export function maskCamera(camera: Camera): Camera & { passwordSet: boolean } {
  return {
    ...camera,
    password: camera.password ? SECRET_MASK : "",
    passwordSet: Boolean(camera.password),
    snapshotUrl: maskUrl(camera.snapshotUrl),
    streamUrl: maskUrl(camera.streamUrl),
    subStreamUrl: maskUrl(camera.subStreamUrl),
    onvifUrl: maskUrl(camera.onvifUrl),
    notes: camera.notes.replace(notesSecretPattern(camera), SECRET_MASK),
  };
}

/** Put the stored secrets back wherever the browser sent the mask unchanged. */
export function restoreSecrets(incoming: Camera, stored: Camera | undefined): Camera {
  const restored = { ...incoming };
  if (incoming.password === SECRET_MASK) {
    if (!stored) throw new HttpError(400, `${incoming.name}: enter the camera password again`);
    restored.password = stored.password;
  }
  for (const field of ["snapshotUrl", "streamUrl", "subStreamUrl", "onvifUrl"] as const) {
    restored[field] = restoreUrl(incoming[field], stored?.[field] ?? "", incoming.name, field);
  }
  restored.notes = restoreNotes(incoming.notes, stored, incoming.name);
  return restored;
}

/** Owners write logins into notes; mask the camera's own secrets and any `scheme://user:pass@` password there. */
function notesSecretPattern(camera: Camera): RegExp {
  const urls = [camera.snapshotUrl, camera.streamUrl, camera.subStreamUrl, camera.onvifUrl].flatMap(credentialsIn);
  const secrets = [...new Set([camera.password, ...urls, ...urls.map(safeDecode)])]
    .filter((secret) => secret && secret !== SECRET_MASK)
    .sort((a, b) => b.length - a.length)
    .map((secret) => secret.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  return new RegExp([String.raw`(?<=\b[A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s/:@]+:)[^\s@]+(?=@)`, ...secrets].join("|"), "g");
}

/** Fill each mask back in with what it hid, in order; a mask with nothing behind it is refused. */
function restoreNotes(incoming: string, stored: Camera | undefined, cameraName: string): string {
  if (!incoming.includes(SECRET_MASK)) return incoming;
  const hidden = stored ? [...stored.notes.matchAll(notesSecretPattern(stored))].map((match) => match[0]) : [];
  const parts = incoming.split(SECRET_MASK);
  if (parts.length - 1 > hidden.length) throw new HttpError(400, `${cameraName}: the notes show ${SECRET_MASK} where no saved password was; type it in full`);
  return parts.reduce((out, part, i) => (i === 0 ? part : `${out}${hidden[i - 1]}${part}`), "");
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export function maskUrl(value: string): string {
  if (!value) return value;
  try {
    const url = new URL(value);
    if (url.password) url.password = SECRET_MASK;
    for (const key of [...url.searchParams.keys()]) if (/^(password|pwd|pass|token)$/i.test(key)) url.searchParams.set(key, SECRET_MASK);
    return url.toString().replace(/%2A/g, "*");
  } catch {
    return value;
  }
}

function restoreUrl(incoming: string, stored: string, cameraName: string, field: string): string {
  if (!incoming.includes(SECRET_MASK)) return incoming;
  if (stored && maskUrl(stored) === incoming) return stored;
  const secrets = credentialsIn(stored);
  if (!secrets.length) throw new HttpError(400, `${cameraName}: ${field} hides a password that was never saved; type it in full`);
  let index = 0;
  return incoming.split(SECRET_MASK).reduce((out, part, i) => (i === 0 ? part : `${out}${secrets[Math.min(index++, secrets.length - 1)]}${part}`), "");
}

function credentialsIn(value: string): string[] {
  try {
    const url = new URL(value);
    const found: string[] = [];
    if (url.password) found.push(url.password);
    for (const [key, val] of url.searchParams) if (/^(password|pwd|pass|token)$/i.test(key) && val) found.push(encodeURIComponent(val));
    return found;
  } catch {
    return [];
  }
}

function normalizePrivacy(raw: unknown): PrivacyState | null {
  if (!raw || typeof raw !== "object") return null;
  const input = raw as Record<string, unknown>;
  return { enabled: input.enabled === true, updatedAt: typeof input.updatedAt === "string" ? input.updatedAt : null, lastResult: input.lastResult ?? null };
}

function text(value: unknown, max: number): string {
  return typeof value === "string" ? value.trim().slice(0, max) : typeof value === "number" ? String(value) : "";
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const n = Math.round(Number(value));
  return Number.isFinite(n) && n !== 0 ? Math.max(min, Math.min(max, n)) : fallback;
}
