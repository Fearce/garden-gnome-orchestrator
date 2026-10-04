import { apiUrl } from "./base.js";
import { useStore } from "../store.js";

/**
 * The console's side of the optional desktop app (desktop/). In a browser `window.ggoDesktop` does not
 * exist and everything here reduces to reading the `?thread=` launch parameter. Inside the app the
 * preload exposes this narrow bridge, and the console's top bar doubles as the window's title bar.
 */
export interface DesktopBridge {
  version: string;
  platform: string;
  /** This app handles `ggo://` links, so browsers on this machine may offer Open in desktop. Absent in
   *  older app builds, which always registered. */
  linksRegistered?: boolean;
  /** Open this console in the system browser — signed in when given a ticket — on this task. */
  openInBrowser(threadId: string | null, ticket: string | null): Promise<void>;
  /** A `ggo://open?thread=…` link arrived while the window was already open. */
  onOpenThread(callback: (threadId: string) => void): () => void;
  setTitleBarStyle(style: { background: string; symbol: string; height: number }): Promise<void>;
}

export const desktopBridge: DesktopBridge | null = (window as { ggoDesktop?: DesktopBridge }).ggoDesktop ?? null;
export const IN_DESKTOP = desktopBridge !== null;

const THREAD_ID = /^[A-Za-z0-9-]{8,64}$/;
/** How long a launch parameter waits for its task to arrive in the first snapshot. */
const LAUNCH_THREAD_WAIT_MS = 30_000;

/** Wire the launch parameters and, inside the app, the window chrome. Call once at boot. */
export function startDesktopShell(): void {
  const launchThread = consumeLaunchParams();
  if (launchThread) openWhenKnown(launchThread);
  dropSpentTicketNotice();
  if (!desktopBridge) return;
  document.documentElement.dataset.shell = "desktop";
  desktopBridge.onOpenThread(openWhenKnown);
  syncTitleBar(desktopBridge);
  if (desktopBridge.linksRegistered !== false) reportPresenceOnceConnected();
}

/** A one-time sign-in ticket, so the other side ("Open in desktop" / "Open in web") lands signed in. */
export async function mintDesktopTicket(): Promise<string | null> {
  try {
    const response = await fetch(apiUrl("/api/desktop/ticket"), { method: "POST" });
    if (!response.ok) return null;
    const { ticket } = (await response.json()) as { ticket?: unknown };
    return typeof ticket === "string" ? ticket : null;
  } catch {
    return null;
  }
}

/** Whether this machine has the desktop app (it registers itself on each launch). */
export async function desktopAvailable(signal: AbortSignal): Promise<boolean> {
  try {
    const response = await fetch(apiUrl("/api/desktop/availability"), { signal });
    return response.ok && ((await response.json()) as { available?: unknown }).available === true;
  } catch {
    return false;
  }
}

/** `?thread=` selects a task on load and is dropped from the address so a reload doesn't repeat it. */
function consumeLaunchParams(): string | null {
  const thread = new URLSearchParams(location.search).get("thread");
  if (thread === null) return null;
  dropQueryParam("thread");
  return THREAD_ID.test(thread) ? thread : null;
}

/** A spent ticket on a console that is signed in anyway lands on `?e=desktop`; the login screen
 *  consumes it when signed out, and nothing needs it when signed in. */
function dropSpentTicketNotice(): void {
  if (new URLSearchParams(location.search).get("e") !== "desktop") return;
  const drop = () => dropQueryParam("e");
  if (useStore.getState().authed) return drop();
  const unsubscribe = useStore.subscribe((s) => {
    if (!s.authed) return;
    unsubscribe();
    drop();
  });
}

function dropQueryParam(name: string): void {
  const params = new URLSearchParams(location.search);
  params.delete(name);
  const query = params.toString();
  history.replaceState(history.state, "", location.pathname + (query ? `?${query}` : "") + location.hash);
}

function openWhenKnown(threadId: string): void {
  if (!THREAD_ID.test(threadId)) return;
  const ready = () => {
    const s = useStore.getState();
    return s.connected && !!s.threads[threadId];
  };
  if (ready()) return useStore.getState().select(threadId);
  const timer = window.setTimeout(() => unsubscribe(), LAUNCH_THREAD_WAIT_MS);
  const unsubscribe = useStore.subscribe(() => {
    if (!ready()) return;
    unsubscribe();
    window.clearTimeout(timer);
    useStore.getState().select(threadId);
  });
}

function reportPresenceOnceConnected(): void {
  const report = () => void fetch(apiUrl("/api/desktop/presence"), { method: "POST" }).catch(() => undefined);
  if (useStore.getState().connected) return report();
  const unsubscribe = useStore.subscribe((s) => {
    if (!s.connected) return;
    unsubscribe();
    report();
  });
}

// ---- title bar ----

/** Keep the OS window buttons the colour of the top bar, through theme changes and focus mode. */
function syncTitleBar(bridge: DesktopBridge): void {
  let last = "";
  let frame = 0;
  const push = () => {
    frame = 0;
    const style = readTitleBarStyle();
    if (!style) return;
    const key = JSON.stringify(style);
    if (key === last) return;
    last = key;
    void bridge.setTitleBarStyle(style).catch(() => undefined);
  };
  const schedule = () => {
    if (!frame) frame = requestAnimationFrame(push);
  };
  new MutationObserver(schedule).observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "style", "class"] });
  const resize = new ResizeObserver(schedule);
  let watched: Element | null = null;
  // The bar mounts after sign-in and again after a lost session, each time a new element under #root.
  const watchBar = () => {
    const bar = document.querySelector(".topbar");
    if (bar === watched) return;
    if (watched) resize.unobserve(watched);
    watched = bar;
    if (bar) resize.observe(bar);
    schedule();
  };
  const root = document.getElementById("root");
  if (root) new MutationObserver(watchBar).observe(root, { childList: true });
  watchBar();
}

/** One bar row is at most this tall; a bar wrapped onto more rows keeps the buttons on its first. */
const SINGLE_ROW_MAX = 64;
const WRAPPED_ROW = 40;

/** Signed out, the window buttons sit on the sign-in screen's plain title strip. */
const SIGNED_OUT_ROW = 32;

function readTitleBarStyle(): { background: string; symbol: string; height: number } | null {
  const bar = document.querySelector<HTMLElement>(".topbar");
  const style = getComputedStyle(bar ?? document.documentElement);
  const background = toRgb(style.getPropertyValue("--shell-bar").trim());
  const symbol = toRgb(style.getPropertyValue("--text-dim").trim());
  if (!background || !symbol) return null;
  if (!bar) return { background, symbol, height: SIGNED_OUT_ROW };
  const height = Math.round(bar.getBoundingClientRect().height);
  return { background, symbol, height: height > SINGLE_ROW_MAX ? WRAPPED_ROW : Math.max(28, height) };
}

let probe: CanvasRenderingContext2D | null = null;

/** The theme speaks oklch; the OS title bar takes only sRGB, so let the browser do the conversion. */
function toRgb(color: string): string | null {
  if (!color) return null;
  probe ??= document.createElement("canvas").getContext("2d", { willReadFrequently: true });
  if (!probe) return null;
  probe.clearRect(0, 0, 1, 1);
  probe.fillStyle = "#000";
  probe.fillStyle = color;
  probe.fillRect(0, 0, 1, 1);
  const [r, g, b] = probe.getImageData(0, 0, 1, 1).data;
  return `rgb(${r}, ${g}, ${b})`;
}
