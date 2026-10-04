import { execFile, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { ffmpegCandidates } from "../../../remoteControl/ffmpeg.js";

const execFileAsync = promisify(execFile);

/** Every ffmpeg this module starts uses this multipart boundary on its preview output, which doubles as the
 *  tag a worker uses to find its predecessor's leftovers. It names the data folder, so a lab or dev GGO
 *  clearing its own leftovers never kills the live instance's recording. */
export const FFMPEG_TAG = ffmpegTag(process.env.GGO_MODULE_DATA_DIR ?? "");

export function ffmpegTag(dataDir: string): string {
  return `ggosurveillance${createHash("sha256").update(resolve(dataDir).toLowerCase()).digest("hex").slice(0, 10)}`;
}

/** The owner's chosen ffmpeg, else the one GGO installed for Remote Control, else the one on PATH. */
export async function resolveFfmpeg(dataDir: string, custom: string): Promise<string | null> {
  if (custom.trim()) return custom.trim();
  const candidates = await ffmpegCandidates(join(dataDir, "remote-control"), null);
  return candidates[0]?.path ?? null;
}

/** Kill a child and everything under it without blocking the worker on taskkill. */
export function killTree(child: ChildProcess | null | undefined): void {
  if (!child?.pid || child.exitCode !== null) return;
  if (process.platform === "win32") {
    execFile("taskkill", ["/F", "/T", "/PID", String(child.pid)], { windowsHide: true }, () => undefined);
  } else {
    child.kill("SIGKILL");
  }
}

/**
 * ffmpeg processes a previous worker left behind (killed without its tree). They hold the camera's few RTSP
 * slots, so a fresh worker clears them before opening its own.
 */
export async function killTaggedFfmpeg(log: (line: string) => void): Promise<void> {
  if (process.platform !== "win32") return;
  const script = `Get-CimInstance Win32_Process -Filter "Name='ffmpeg.exe'" | Where-Object { $_.CommandLine -like '*${FFMPEG_TAG}*' } | ForEach-Object { $_.ProcessId }`;
  try {
    const { stdout } = await execFileAsync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { windowsHide: true, timeout: 20_000 });
    const pids = stdout.split(/\s+/).map(Number).filter((pid) => pid > 0);
    for (const pid of pids) await execFileAsync("taskkill", ["/F", "/T", "/PID", String(pid)], { windowsHide: true, timeout: 10_000 }).catch(() => undefined);
    if (pids.length) log(`stopped ${pids.length} leftover camera ffmpeg process(es): ${pids.join(", ")}`);
  } catch (error) {
    log(`could not look for leftover camera ffmpeg processes: ${(error as Error).message}`);
  }
}
