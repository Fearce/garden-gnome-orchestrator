import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";

export type CodexLauncher = {
  /** Executable passed to spawn(). */
  command: string;
  /** Fixed arguments that must precede the Codex subcommand. */
  args: string[];
  /** The installation artifact used for availability checks and diagnostics. */
  path: string;
  source: "npm-override" | "npm" | "desktop";
};

/**
 * Resolve a usable Codex CLI without making the desktop application a prerequisite.
 *
 * GGO historically required the global npm package and launched its JavaScript entry
 * with Node. Codex Desktop ships the same CLI as a native executable, so a desktop
 * login could be perfectly healthy while GGO reported a missing CLI. Prefer the
 * explicit override and npm install for compatibility, then discover Desktop on
 * Windows before retaining the old actionable missing-npm path.
 */
export function resolveCodexLauncher(
  env: NodeJS.ProcessEnv = process.env,
  exists: (path: string) => boolean = existsSync,
  platform: NodeJS.Platform = process.platform,
): CodexLauncher {
  const npmBinJs =
    env.CODEX_BIN_JS ||
    resolve(env.APPDATA ?? resolve(homedir(), "AppData", "Roaming"), "npm", "node_modules", "@openai", "codex", "bin", "codex.js");
  if (env.CODEX_BIN_JS) {
    return { command: process.execPath, args: [npmBinJs], path: npmBinJs, source: "npm-override" };
  }
  if (exists(npmBinJs)) {
    return { command: process.execPath, args: [npmBinJs], path: npmBinJs, source: "npm" };
  }

  const desktopExe = resolve(env.LOCALAPPDATA ?? resolve(homedir(), "AppData", "Local"), "Programs", "OpenAI", "Codex", "bin", "codex.exe");
  if (platform === "win32" && exists(desktopExe)) {
    return { command: desktopExe, args: [], path: desktopExe, source: "desktop" };
  }

  // Keep the familiar error target when neither installation exists.
  return { command: process.execPath, args: [npmBinJs], path: npmBinJs, source: "npm" };
}
