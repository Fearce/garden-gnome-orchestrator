import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createWriteStream, existsSync } from "node:fs";
import { copyFile, mkdir, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type EncoderId = "h264_nvenc" | "libx264";
export type QualityId = "sharp" | "smooth" | "saver";

export interface QualityPreset {
  id: QualityId;
  label: string;
  maxWidth: number;
  maxHeight: number;
  fps: number;
  bitrateKbps: number;
}

export const QUALITY_PRESETS: Record<QualityId, QualityPreset> = {
  sharp: { id: "sharp", label: "Sharp", maxWidth: 3840, maxHeight: 2160, fps: 60, bitrateKbps: 24_000 },
  smooth: { id: "smooth", label: "Smooth", maxWidth: 1920, maxHeight: 1080, fps: 60, bitrateKbps: 12_000 },
  saver: { id: "saver", label: "Data saver", maxWidth: 1280, maxHeight: 720, fps: 30, bitrateKbps: 4_000 },
};

/** Best first: a GPU encoder costs the PC almost nothing, x264 is the CPU fallback every build has. */
export const ENCODER_PREFERENCE: EncoderId[] = ["h264_nvenc", "libx264"];

export const ENCODER_LABELS: Record<EncoderId, string> = {
  h264_nvenc: "NVIDIA NVENC (GPU)",
  libx264: "x264 (CPU)",
};

/**
 * The build GGO can install for itself. Pinned by hash, not "latest": ffmpeg 9 builds want NVENC API
 * 13.1 (NVIDIA driver 610+) and refuse to open the encoder on older drivers, while 8.0.1 speaks the
 * API every 570+ driver has. A floating URL would silently swap that property out from under a setup.
 */
export const MANAGED_FFMPEG = {
  version: "8.0.1",
  url: "https://github.com/GyanD/codexffmpeg/releases/download/8.0.1/ffmpeg-8.0.1-essentials_build.zip",
  sha256: "e2aaeaa0fdbc397d4794828086424d4aaa2102cef1fb6874f6ffd29c0b88b673",
  bytes: 106_259_850,
  member: "ffmpeg-8.0.1-essentials_build/bin/ffmpeg.exe",
  license: "ffmpeg-8.0.1-essentials_build/LICENSE",
} as const;

export interface EncoderProbe {
  encoder: EncoderId;
  ok: boolean;
  error?: string;
}

export interface FfmpegProbe {
  path: string;
  source: "managed" | "path" | "custom";
  version: string | null;
  ddagrab: boolean;
  encoders: EncoderProbe[];
  error?: string;
}

export interface CaptureSize {
  width: number;
  height: number;
}

export function managedFfmpegPath(dir: string): string {
  return join(dir, `ffmpeg-${MANAGED_FFMPEG.version}`, "ffmpeg.exe");
}

/** Every ffmpeg worth probing: the one GGO installed, the one on PATH, and one the owner typed. */
export async function ffmpegCandidates(dir: string, custom: string | null): Promise<{ path: string; source: FfmpegProbe["source"] }[]> {
  const found: { path: string; source: FfmpegProbe["source"] }[] = [];
  const add = (path: string | null, source: FfmpegProbe["source"]) => {
    if (path && !found.some((c) => c.path.toLowerCase() === path.toLowerCase())) found.push({ path, source });
  };
  const managed = managedFfmpegPath(dir);
  if (existsSync(managed)) add(managed, "managed");
  add(await ffmpegOnPath(), "path");
  if (custom?.trim()) add(custom.trim(), "custom");
  return found;
}

async function ffmpegOnPath(): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("where.exe", ["ffmpeg"], { windowsHide: true, timeout: 10_000 });
    return stdout.split(/\r?\n/).map((l) => l.trim()).find((l) => l.toLowerCase().endsWith(".exe")) ?? null;
  } catch {
    return null;
  }
}

/** Can this ffmpeg capture the desktop, and which encoders actually open on this machine's hardware? */
export async function probeFfmpeg(candidate: { path: string; source: FfmpegProbe["source"] }, display: number): Promise<FfmpegProbe> {
  const probe: FfmpegProbe = { ...candidate, version: null, ddagrab: false, encoders: [] };
  try {
    const version = await execFileAsync(candidate.path, ["-hide_banner", "-version"], { windowsHide: true, timeout: 20_000 });
    probe.version = /ffmpeg version (\S+)/.exec(version.stdout)?.[1] ?? "unknown";
    const [filters, encoders] = await Promise.all([
      execFileAsync(candidate.path, ["-hide_banner", "-filters"], { windowsHide: true, timeout: 20_000, maxBuffer: 8 * 1024 * 1024 }),
      execFileAsync(candidate.path, ["-hide_banner", "-encoders"], { windowsHide: true, timeout: 20_000, maxBuffer: 8 * 1024 * 1024 }),
    ]);
    probe.ddagrab = /\sddagrab\s/.test(filters.stdout);
    if (!probe.ddagrab) {
      probe.error = "This ffmpeg build has no ddagrab (Desktop Duplication) capture.";
      return probe;
    }
    for (const encoder of ENCODER_PREFERENCE) {
      if (!new RegExp(`\\s${encoder}\\s`).test(encoders.stdout)) continue;
      probe.encoders.push(await trialEncode(candidate.path, encoder, display));
    }
  } catch (error) {
    probe.error = `Could not run ffmpeg: ${(error as Error).message.split("\n")[0]}`;
  }
  return probe;
}

/** Encode a few real frames of the chosen display: listing an encoder proves nothing about the GPU. */
async function trialEncode(path: string, encoder: EncoderId, display: number): Promise<EncoderProbe> {
  const args = [
    "-hide_banner", "-loglevel", "error", "-nostdin",
    "-filter_complex", captureFilter(encoder, display, 10, null),
    "-frames:v", "5", ...encoderArgs(encoder, QUALITY_PRESETS.saver), "-f", "null", "-",
  ];
  try {
    await execFileAsync(path, args, { windowsHide: true, timeout: 30_000 });
    return { encoder, ok: true };
  } catch (error) {
    return { encoder, ok: false, error: explainEncoderError((error as { stderr?: string }).stderr ?? (error as Error).message) };
  }
}

export function explainEncoderError(stderr: string): string {
  const driver = /Required: ([\d.]+) Found: ([\d.]+)/.exec(stderr);
  if (driver) {
    const minimum = /minimum required Nvidia driver for nvenc is ([\d.]+)/.exec(stderr)?.[1];
    return `This ffmpeg needs NVENC API ${driver[1]} but the NVIDIA driver provides ${driver[2]}${minimum ? ` (update the driver to ${minimum}+ or install GGO's ffmpeg ${MANAGED_FFMPEG.version})` : ""}.`;
  }
  if (/Cannot load nvcuda|No NVENC capable devices|CUDA_ERROR/i.test(stderr)) return "No NVIDIA GPU with NVENC is available.";
  if (/DXGI_ERROR|Failed to (?:enumerate|duplicate|create)|AcquireNextFrame/i.test(stderr)) return "Desktop capture failed: the screen may be locked or showing a secure prompt.";
  const lines = stderr.split(/\r?\n/).map((l) => l.replace(/^\[[^\]]+\]\s*/, "").trim()).filter(Boolean);
  return lines.find((l) => !/^(Conversion failed|Error while|Nothing was written|Terminating thread|Task finished)/.test(l)) ?? lines[0] ?? "The encoder failed to start.";
}

/** Largest even size that fits the preset's box without changing the aspect ratio. */
export function fitSize(source: CaptureSize, preset: QualityPreset): CaptureSize {
  const scale = Math.min(1, preset.maxWidth / source.width, preset.maxHeight / source.height);
  const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);
  return { width: even(source.width * scale), height: even(source.height * scale) };
}

/**
 * The filter graph from Desktop Duplication to encoder input. NVENC reads the GPU texture directly (a
 * D3D11 scale also converts to NV12, the 4:2:0 layout every browser decoder takes); x264 needs the
 * frame downloaded to system memory first. `size` null keeps the capture's own resolution.
 */
export function captureFilter(encoder: EncoderId, display: number, fps: number, size: CaptureSize | null): string {
  const grab = `ddagrab=output_idx=${display}:framerate=${fps}:draw_mouse=1`;
  if (encoder === "h264_nvenc") return `${grab},scale_d3d11=${size ? `width=${size.width}:height=${size.height}:` : ""}format=nv12`;
  return `${grab},hwdownload,format=bgra${size ? `,scale=${size.width}:${size.height}:flags=bilinear` : ""},format=yuv420p`;
}

/** Tuned for latency over compression: no B-frames, no lookahead, CBR with a quarter-second buffer. */
export function encoderArgs(encoder: EncoderId, preset: QualityPreset): string[] {
  const rate = [`-b:v`, `${preset.bitrateKbps}k`, "-maxrate", `${preset.bitrateKbps}k`, "-bufsize", `${Math.round(preset.bitrateKbps / 4)}k`];
  // One keyframe a second is how a viewer that fell behind recovers: it drops frames until the next one.
  const gop = ["-g", String(preset.fps), "-bf", "0"];
  if (encoder === "h264_nvenc") {
    return ["-c:v", "h264_nvenc", "-preset", "p1", "-tune", "ull", "-profile:v", "high", "-rc", "cbr", ...rate, ...gop,
      "-zerolatency", "1", "-delay", "0", "-rc-lookahead", "0", "-forced-idr", "1"];
  }
  return ["-c:v", "libx264", "-preset", "ultrafast", "-tune", "zerolatency", "-pix_fmt", "yuv420p", ...rate, ...gop];
}

export function streamArgs(encoder: EncoderId, display: number, source: CaptureSize, preset: QualityPreset): { args: string[]; size: CaptureSize } {
  const size = fitSize(source, preset);
  const scaled = size.width !== source.width || size.height !== source.height;
  const args = [
    "-hide_banner", "-loglevel", "error", "-nostdin",
    "-filter_complex", captureFilter(encoder, display, preset.fps, scaled ? size : null),
    ...encoderArgs(encoder, preset),
    "-an", "-f", "flv", "-flvflags", "no_duration_filesize", "-flush_packets", "1", "pipe:1",
  ];
  return { args, size };
}

/** One JPEG of a display, for picking the right monitor during setup. */
export function captureThumbnail(path: string, display: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn(path, [
      "-hide_banner", "-loglevel", "error", "-nostdin",
      "-filter_complex", `ddagrab=output_idx=${display}:framerate=5:draw_mouse=0,hwdownload,format=bgra,scale=480:-2,format=yuvj420p`,
      "-frames:v", "1", "-f", "image2pipe", "-c:v", "mjpeg", "-q:v", "5", "pipe:1",
    ], { windowsHide: true });
    const chunks: Buffer[] = [];
    let stderr = "";
    const timer = setTimeout(() => child.kill(), 20_000);
    child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    child.on("error", (error) => { clearTimeout(timer); reject(error); });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0 && chunks.length) resolve(Buffer.concat(chunks));
      else reject(new Error(explainEncoderError(stderr || `ffmpeg exited with code ${code}`)));
    });
  });
}

export interface InstallProgress {
  state: "idle" | "downloading" | "verifying" | "extracting" | "done" | "error";
  receivedBytes: number;
  totalBytes: number;
  error?: string;
}

/** Download the pinned build, check its hash, and keep only ffmpeg.exe and its licence. */
export async function installManagedFfmpeg(dir: string, onProgress: (progress: InstallProgress) => void): Promise<string> {
  const total = MANAGED_FFMPEG.bytes;
  const work = join(dir, `install-${Date.now()}`);
  await mkdir(work, { recursive: true });
  try {
    const zip = join(work, "ffmpeg.zip");
    const digest = await download(MANAGED_FFMPEG.url, zip, (received) => onProgress({ state: "downloading", receivedBytes: received, totalBytes: total }));
    onProgress({ state: "verifying", receivedBytes: total, totalBytes: total });
    if (digest !== MANAGED_FFMPEG.sha256) throw new Error("The downloaded ffmpeg did not match its pinned checksum, so it was discarded.");
    onProgress({ state: "extracting", receivedBytes: total, totalBytes: total });
    await extractMembers(zip, work, [MANAGED_FFMPEG.member, MANAGED_FFMPEG.license]);
    const target = managedFfmpegPath(dir);
    await mkdir(join(target, ".."), { recursive: true });
    await copyFile(join(work, MANAGED_FFMPEG.license), join(target, "..", "LICENSE.txt"));
    await rename(join(work, MANAGED_FFMPEG.member), target);
    return target;
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

async function download(url: string, file: string, onBytes: (received: number) => void): Promise<string> {
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok || !response.body) throw new Error(`Downloading ffmpeg failed: HTTP ${response.status}.`);
  const hash = createHash("sha256");
  let received = 0;
  let lastReport = 0;
  const body = Readable.fromWeb(response.body as import("node:stream/web").ReadableStream<Uint8Array>);
  body.on("data", (chunk: Buffer) => {
    hash.update(chunk);
    received += chunk.length;
    if (received - lastReport > 1024 * 1024) {
      lastReport = received;
      onBytes(received);
    }
  });
  await pipeline(body, createWriteStream(file));
  return hash.digest("hex");
}

/** Windows' own bsdtar reads zip archives; Git Bash's GNU tar on PATH does not, so name it exactly. */
async function extractMembers(zip: string, into: string, members: string[]): Promise<void> {
  const tar = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe");
  await execFileAsync(tar, ["-xf", zip, "-C", into, ...members], { windowsHide: true, timeout: 300_000 });
}
