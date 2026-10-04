import { BrowserWindow, screen, shell, type WebPreferences } from "electron";
import { join } from "node:path";
import type { WindowBounds } from "./settings";
import type { TitleBarStyle } from "./contract";
import { parseTitleBarStyle } from "./titleBarStyle";

/** Matches the console's `--bg` (oklch 0.165 0.012 264) so the window never flashes white while loading. */
export const BACKGROUND = "#0e1016";
/** The connection screen's top strip (40px, the console's `--bg-1` / `--text-dim`); the console page
 *  reports its own bar once it loads. */
const CONNECT_TITLE_BAR: TitleBarStyle = { background: "#15171f", symbol: "#a6abb8", height: 40 };

/** The settings every page in this app runs with, the main window and any child window alike. */
export function securePreferences(preload?: string, version?: string, linksRegistered = true): WebPreferences {
  return {
    contextIsolation: true,
    sandbox: true,
    nodeIntegration: false,
    nodeIntegrationInSubFrames: false,
    webSecurity: true,
    allowRunningInsecureContent: false,
    webviewTag: false,
    spellcheck: true,
    ...(preload ? { preload } : {}),
    ...(version ? { additionalArguments: [`--ggo-desktop-version=${version}`, `--ggo-desktop-links=${linksRegistered ? 1 : 0}`] } : {}),
  };
}

function visibleOnSomeDisplay(bounds: WindowBounds): boolean {
  return screen.getAllDisplays().some(({ workArea }) => {
    const overlapX = Math.min(bounds.x + bounds.width, workArea.x + workArea.width) - Math.max(bounds.x, workArea.x);
    const overlapY = Math.min(bounds.y + bounds.height, workArea.y + workArea.height) - Math.max(bounds.y, workArea.y);
    return overlapX >= 120 && overlapY >= 80;
  });
}

/**
 * GGO_DESKTOP_BACKGROUND=1 (the lab and the load probe): open on a monitor other than the primary one
 * and never take focus, so a test run never lands on top of whatever the owner is doing.
 */
export const backgroundWindows = process.env.GGO_DESKTOP_BACKGROUND === "1";

function initialBounds(saved: WindowBounds | null): Partial<WindowBounds> {
  if (saved && visibleOnSomeDisplay(saved)) return saved;
  const primary = screen.getPrimaryDisplay();
  const display = backgroundWindows ? (screen.getAllDisplays().find((d) => d.id !== primary.id) ?? primary) : primary;
  const { workArea } = display;
  const width = Math.min(1600, Math.round(workArea.width * 0.86));
  const height = Math.min(1000, Math.round(workArea.height * 0.88));
  if (display === primary) return { width, height };
  return { x: workArea.x + Math.round((workArea.width - width) / 2), y: workArea.y + Math.round((workArea.height - height) / 2), width, height };
}

/** Bring the window up: in front and focused, or quietly behind the owner's work in background mode. */
export function revealWindow(win: BrowserWindow): void {
  if (backgroundWindows) return win.showInactive();
  win.show();
  win.focus();
}

export function createMainWindow(options: { saved: WindowBounds | null; preload: string; icon: string; version: string; linksRegistered: boolean }): BrowserWindow {
  const { x, y, width, height } = initialBounds(options.saved);
  const win = new BrowserWindow({
    x,
    y,
    width,
    height,
    minWidth: 720,
    minHeight: 480,
    show: false,
    title: "GG Orchestrator",
    icon: options.icon,
    backgroundColor: BACKGROUND,
    // The console's own top bar becomes the title bar; the OS keeps drawing the window buttons over it.
    titleBarStyle: "hidden",
    titleBarOverlay: overlayOptions(CONNECT_TITLE_BAR),
    autoHideMenuBar: true,
    webPreferences: securePreferences(options.preload, options.version, options.linksRegistered),
  });
  if (options.saved?.maximized && visibleOnSomeDisplay(options.saved)) win.maximize();
  win.once("ready-to-show", () => (backgroundWindows ? win.showInactive() : win.show()));
  return win;
}

export function currentBounds(win: BrowserWindow): WindowBounds {
  const { x, y, width, height } = win.getNormalBounds();
  return { x, y, width, height, maximized: win.isMaximized() };
}

function overlayOptions(style: TitleBarStyle): Electron.TitleBarOverlayOptions {
  return { color: style.background, symbolColor: style.symbol, height: style.height };
}

/** Match the window buttons to the console's top bar. macOS draws its own traffic lights instead. */
export function applyTitleBarStyle(win: BrowserWindow, input: unknown): void {
  const style = parseTitleBarStyle(input);
  if (style && process.platform !== "darwin") win.setTitleBarOverlay(overlayOptions(style));
}

export function resetTitleBarStyle(win: BrowserWindow): void {
  applyTitleBarStyle(win, CONNECT_TITLE_BAR);
}

/** A console page opened in its own window (a deliverable preview): same session, no preload, no
 *  further windows, and any navigation off the console goes to the system browser. */
export function childWindowOptions(parent: BrowserWindow, icon: string): Electron.BrowserWindowConstructorOptions {
  const outer = parent.getBounds();
  const width = Math.round(outer.width * 0.7);
  const height = Math.round(outer.height * 0.85);
  return {
    // Centred on the app, so it opens on the app's monitor rather than wherever the OS picks.
    x: outer.x + Math.round((outer.width - width) / 2),
    y: outer.y + Math.round((outer.height - height) / 2),
    width,
    height,
    icon,
    backgroundColor: BACKGROUND,
    autoHideMenuBar: true,
    webPreferences: securePreferences(),
  };
}

export function openExternal(url: string): void {
  void shell.openExternal(url).catch(() => {
    /* no handler for the scheme: nothing to open */
  });
}

export function staticPath(distDir: string, ...parts: string[]): string {
  return join(distDir, "static", ...parts);
}
