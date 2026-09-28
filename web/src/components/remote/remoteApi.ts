import { useSyncExternalStore } from "react";
import { apiUrl } from "../../lib/base.js";

export type EncoderId = "h264_nvenc" | "libx264";
export type QualityId = "sharp" | "smooth" | "saver";

export const ENCODER_LABELS: Record<EncoderId, string> = {
  h264_nvenc: "NVIDIA NVENC (GPU)",
  libx264: "x264 (CPU)",
};

export const QUALITY_OPTIONS: { id: QualityId; label: string; hint: string }[] = [
  { id: "sharp", label: "Sharp", hint: "Native resolution up to 4K, 60 fps, ~24 Mbit/s" },
  { id: "smooth", label: "Smooth", hint: "Up to 1080p, 60 fps, ~12 Mbit/s" },
  { id: "saver", label: "Data saver", hint: "Up to 720p, 30 fps, ~4 Mbit/s" },
];

export interface DisplayInfo {
  index: number;
  name: string;
  x: number;
  y: number;
  width: number;
  height: number;
  primary: boolean;
}

export interface FfmpegProbe {
  path: string;
  source: "managed" | "path" | "custom";
  version: string | null;
  ddagrab: boolean;
  encoders: { encoder: EncoderId; ok: boolean; error?: string }[];
  error?: string;
}

export interface RemoteControlConfig {
  enabled: boolean;
  ffmpegPath: string | null;
  encoder: EncoderId | null;
  display: number;
  quality: QualityId;
  customFfmpegPath: string | null;
  setupAt: number | null;
}

export interface CheckReport {
  checkedAt: number;
  layout: { displays: DisplayInfo[]; elevated: boolean } | null;
  helperError: string | null;
  ffmpeg: FfmpegProbe[];
  recommended: { ffmpegPath: string; encoder: EncoderId } | null;
  managedVersion: string;
  managedInstalled: boolean;
}

export interface InstallProgress {
  state: "idle" | "downloading" | "verifying" | "extracting" | "done" | "error";
  receivedBytes: number;
  totalBytes: number;
  error?: string;
}

export interface SessionRecord {
  startedAt: number;
  endedAt: number | null;
  client: string;
  userAgent: string;
}

export interface RemoteControlStatus {
  supported: boolean;
  config: RemoteControlConfig;
  check: CheckReport | null;
  install: InstallProgress;
  active: SessionRecord | null;
  lastSession: SessionRecord | null;
}

export async function remoteRequest<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(apiUrl(`/api/remote-control/${path}`), { cache: "no-store", ...init });
  const body = (await response.json().catch(() => ({}))) as T & { error?: string };
  if (!response.ok) throw new Error(body.error || `Request failed (${response.status}).`);
  return body;
}

export function saveRemoteConfig(patch: Partial<Omit<RemoteControlConfig, "setupAt">>): Promise<RemoteControlConfig> {
  return remoteRequest<RemoteControlConfig>("config", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(patch),
  });
}

export function thumbnailUrl(display: number, ffmpegPath: string, nonce: number): string {
  return apiUrl(`/api/remote-control/thumbnail?display=${display}&ffmpeg=${encodeURIComponent(ffmpegPath)}&n=${nonce}`);
}

/** The stream socket URL under the current mount; the ticket makes it single-use. */
export function streamUrl(ticket: string): string {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  return `${proto}://${location.host}${apiUrl(`/api/remote-control/stream?ticket=${encodeURIComponent(ticket)}`)}`;
}

/* ---- whether the Remote control tab exists: one shared fetch, refreshed after setup changes ---- */

let enabled = false;
const listeners = new Set<() => void>();
let inflight: Promise<void> | null = null;

function publish(next: boolean): void {
  if (next === enabled) return;
  enabled = next;
  for (const listener of listeners) listener();
}

export function refreshRemoteControlEnabled(): Promise<void> {
  inflight ??= remoteRequest<RemoteControlStatus>("status")
    .then((status) => publish(status.supported && status.config.enabled), () => undefined)
    .finally(() => { inflight = null; });
  return inflight;
}

export function setRemoteControlEnabled(next: boolean): void {
  publish(next);
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (listeners.size === 1) void refreshRemoteControlEnabled();
  return () => listeners.delete(listener);
}

/** True once remote control is set up and switched on for this PC. */
export function useRemoteControlEnabled(): boolean {
  return useSyncExternalStore(subscribe, () => enabled);
}
