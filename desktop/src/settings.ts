import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { DEFAULT_SERVER_URL, normalizeServerUrl } from "./serverUrl";

export interface WindowBounds {
  x: number;
  y: number;
  width: number;
  height: number;
  maximized: boolean;
}

/** Everything the desktop app remembers. It lives in Electron's per-user data folder, never in the repo. */
export interface DesktopSettings {
  serverUrl: string;
  /** A GGO checkout chosen by hand, for a copy of the app that does not sit inside one. */
  checkoutDir: string | null;
  bounds: WindowBounds | null;
}

const FILE = "desktop-settings.json";

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function readBounds(value: unknown): WindowBounds | null {
  const b = value as Partial<WindowBounds> | null;
  if (!b || !finite(b.x) || !finite(b.y) || !finite(b.width) || !finite(b.height)) return null;
  if (b.width < 400 || b.height < 300) return null;
  return { x: b.x, y: b.y, width: b.width, height: b.height, maximized: b.maximized === true };
}

/** Read the stored settings; a missing, unreadable or hand-mangled file falls back field by field. */
export function loadSettings(userDataDir: string): DesktopSettings {
  let raw: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(userDataDir, FILE), "utf8"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) raw = parsed as Record<string, unknown>;
  } catch {
    /* first run */
  }
  const serverUrl = typeof raw.serverUrl === "string" ? normalizeServerUrl(raw.serverUrl) : null;
  const checkoutDir = typeof raw.checkoutDir === "string" && isAbsolute(raw.checkoutDir) ? raw.checkoutDir : null;
  return { serverUrl: serverUrl ?? DEFAULT_SERVER_URL, checkoutDir, bounds: readBounds(raw.bounds) };
}

/** Write through a temp file so a crash mid-write never leaves a half-written settings file. */
export function saveSettings(userDataDir: string, settings: DesktopSettings): void {
  const file = join(userDataDir, FILE);
  mkdirSync(dirname(file), { recursive: true });
  const temp = `${file}.tmp`;
  writeFileSync(temp, `${JSON.stringify(settings, null, 2)}\n`);
  renameSync(temp, file);
}
