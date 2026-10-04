import { BrowserWindow, dialog, session, shell, type WebContents } from "electron";
import type { ConnectionPhase, ConnectionView, SetServerResult } from "./contract";
import { isTicket, parseDeepLink } from "./deepLink";
import { checkoutPort, findCheckout, findNode, isCheckout, portInUse, serverLogPath, startDetachedServer, urlPort } from "./localServer";
import { APP_ORIGIN, classifyNavigation, classifyWindowOpen, isAppPage } from "./navigationPolicy";
import { probeServer } from "./probe";
import { consoleUrl, isLocalServer, isServerPage, isThreadId, normalizeServerUrl, redeemUrl, sameServer } from "./serverUrl";
import { loadSettings, saveSettings, type DesktopSettings } from "./settings";
import { applyTitleBarStyle, backgroundWindows, childWindowOptions, createMainWindow, currentBounds, openExternal, resetTitleBarStyle, revealWindow } from "./window";

const CONNECT_PAGE = `${APP_ORIGIN}/connect.html`;
/** Seconds between automatic retries while nothing answers; the last value repeats. */
const RETRY_DELAYS_MS = [1_500, 3_000, 5_000, 8_000, 12_000, 15_000];
const START_POLL_MS = 1_000;
/** A cold boot on a busy machine has measured past 30s; give a fresh server generous room. */
const START_TIMEOUT_MS = 180_000;
/** Chromium's "navigation aborted": a page replaced by another navigation, not a failure. */
const ERR_ABORTED = -3;

export interface ControllerPaths {
  userData: string;
  preload: string;
  icon: string;
  /** Where to look upward for the GGO checkout this copy of the app belongs to. */
  checkoutSearch: string[];
  /** This run registered itself for `ggo://` links (a throwaway profile does not). */
  linksRegistered: boolean;
}

/**
 * Owns the one main window and its connection to a GGO server: probing, retrying, starting a local
 * server, deep links, and keeping every navigation on the console. It never stops a server.
 */
export class DesktopController {
  private win: BrowserWindow | null = null;
  private settings: DesktopSettings;
  private view: ConnectionView;
  /** The console page to show once the server answers. */
  private resumeUrl: string | null = null;
  private timer: NodeJS.Timeout | null = null;
  private retryAttempt = 0;
  /** Bumped whenever a newer connection attempt supersedes the one in flight. */
  private attempt = 0;
  private readonly node: string | null;

  constructor(
    private readonly paths: ControllerPaths,
    private readonly version: string,
  ) {
    this.settings = loadSettings(paths.userData);
    this.node = findNode();
    this.view = this.freshView("connecting");
  }

  get server(): string {
    return this.settings.serverUrl;
  }

  get window(): BrowserWindow | null {
    return this.win;
  }

  viewSnapshot(): ConnectionView {
    return { ...this.view };
  }

  /** Create the window if there is none and connect it, landing on `target` when one is given. */
  open(deepLink: string | null): void {
    if (!this.win) this.createWindow();
    if (deepLink) this.handleDeepLink(deepLink);
    else this.connect(null);
  }

  focus(): void {
    if (!this.win) return this.open(null);
    if (this.win.isMinimized()) this.win.restore();
    revealWindow(this.win);
  }

  handleDeepLink(raw: string): void {
    const link = parseDeepLink(raw);
    if (!this.win) this.createWindow();
    this.focus();
    // A link this version can't read, or one from a console on another server (whose ticket and task
    // mean nothing here), still brings the app up; a fresh window must start connecting.
    if (!link || (link.kind === "open" && link.server && !sameServer(link.server, this.server))) {
      if (!this.onConsole() && !this.onConnectPage()) this.connect(null);
      return;
    }
    const thread = link.kind === "open" ? link.thread : null;
    if (link.ticket) return this.connect(redeemUrl(this.server, link.ticket, thread));
    if (thread && this.onConsole()) {
      this.win?.webContents.send("console:open-thread", thread);
      return;
    }
    if (!this.onConsole()) this.connect(consoleUrl(this.server, thread));
  }

  retry(): void {
    this.connect(this.resumeUrl);
  }

  back(): void {
    this.connect(consoleUrl(this.server));
  }

  async startServer(): Promise<void> {
    const checkout = this.view.checkout;
    if (!this.view.local || !checkout || !this.node || this.view.checkoutPort !== null || this.view.phase === "starting") return;
    const attempt = this.supersede();
    // "starting" at once: it hides Start GGO and blocks a second click while the checks below run.
    this.show("starting");
    const found = await probeServer(session.defaultSession, this.server);
    if (attempt !== this.attempt) return;
    if (found === "ggo") return this.loadConsole();
    const busy = found === "other" || (await portInUse(this.server));
    if (attempt !== this.attempt) return;
    if (busy) return this.show("offline", { conflict: true, detail: `Another program is using ${new URL(this.server).host}, so GGO can't start there.` });
    try {
      await startDetachedServer(checkout, this.node);
    } catch (error) {
      if (attempt === this.attempt) this.show("offline", { detail: `Couldn't start GGO: ${error instanceof Error ? error.message : String(error)}` });
      return;
    }
    if (attempt !== this.attempt) return;
    this.show("starting", { logPath: serverLogPath(checkout) });
    this.pollStartingServer(attempt, Date.now() + START_TIMEOUT_MS);
  }

  setServer(input: unknown): SetServerResult {
    const url = typeof input === "string" ? normalizeServerUrl(input) : null;
    if (!url) return { ok: false, error: "Enter an http:// or https:// address, like 127.0.0.1:4317." };
    this.settings = { ...this.settings, serverUrl: url };
    saveSettings(this.paths.userData, this.settings);
    this.connect(consoleUrl(url));
    return { ok: true };
  }

  async chooseCheckout(): Promise<void> {
    if (!this.win) return;
    const picked = await dialog.showOpenDialog(this.win, { title: "Choose your GG Orchestrator folder", properties: ["openDirectory"] });
    const dir = picked.filePaths[0];
    if (picked.canceled || !dir) return;
    if (!isCheckout(dir)) {
      return this.show(this.view.phase, { detail: "That folder isn't a GG Orchestrator checkout: it needs server/ and web/ from the repository." });
    }
    this.settings = { ...this.settings, checkoutDir: dir };
    saveSettings(this.paths.userData, this.settings);
    const port = checkoutPort(dir);
    this.show(this.view.phase, { checkout: dir, checkoutPort: port !== urlPort(this.server) ? port : null, detail: null, logPath: null });
  }

  openLog(): void {
    if (this.view.logPath) void shell.openPath(this.view.logPath);
  }

  setTitleBarStyle(style: unknown): void {
    if (this.win) applyTitleBarStyle(this.win, style);
  }

  /** With a ticket the console minted, the browser lands signed in; without one it shows its own sign-in. */
  openInBrowser(threadId: unknown, ticket: unknown): void {
    const thread = isThreadId(threadId) ? threadId : null;
    openExternal(isTicket(ticket) ? redeemUrl(this.server, ticket, thread) : consoleUrl(this.server, thread));
  }

  /** The frame an IPC call came from must be the main window's top frame. */
  isMainFrame(frame: Electron.WebFrameMain | null | undefined): boolean {
    return !!frame && !!this.win && !this.win.isDestroyed() && frame === this.win.webContents.mainFrame;
  }

  dispose(): void {
    this.clearTimer();
    this.attempt++;
  }

  // ---- connection lifecycle ----

  private connect(target: string | null): void {
    this.resumeUrl = target ?? this.resumeUrl ?? consoleUrl(this.server);
    this.retryAttempt = 0;
    const attempt = this.supersede();
    // From a live console page, probe quietly and swap pages once; elsewhere paint the local screen first.
    if (!this.onConsole()) this.show(this.view.phase === "lost" ? "lost" : "connecting");
    void this.probe(attempt);
  }

  private async probe(attempt: number): Promise<void> {
    const found = await probeServer(session.defaultSession, this.server);
    if (attempt !== this.attempt || !this.win) return;
    if (found === "ggo") return this.loadConsole();
    const phase: ConnectionPhase = this.view.phase === "lost" ? "lost" : "offline";
    const detail = found === "other" ? `Something other than GGO answers at ${new URL(this.server).host}.` : null;
    this.show(phase, { conflict: found === "other", detail });
    this.scheduleRetry(attempt);
  }

  private scheduleRetry(attempt: number): void {
    const delay = RETRY_DELAYS_MS[Math.min(this.retryAttempt, RETRY_DELAYS_MS.length - 1)] ?? 15_000;
    this.retryAttempt += 1;
    this.view.retryAt = Date.now() + delay;
    this.push();
    this.timer = setTimeout(() => {
      this.timer = null;
      if (attempt === this.attempt) void this.probe(attempt);
    }, delay);
  }

  private pollStartingServer(attempt: number, deadline: number): void {
    this.timer = setTimeout(async () => {
      this.timer = null;
      if (attempt !== this.attempt) return;
      const found = await probeServer(session.defaultSession, this.server, 2_000);
      if (attempt !== this.attempt) return;
      if (found === "ggo") return this.loadConsole();
      if (Date.now() < deadline) return this.pollStartingServer(attempt, deadline);
      this.show("offline", { detail: "GGO didn't answer within 3 minutes of starting. Its log usually says why." });
    }, START_POLL_MS);
  }

  private loadConsole(): void {
    this.clearTimer();
    const target = this.resumeUrl && isServerPage(this.resumeUrl, this.server) ? this.resumeUrl : consoleUrl(this.server);
    this.resumeUrl = null;
    this.retryAttempt = 0;
    void this.win?.loadURL(target).catch(() => {
      /* reported through did-fail-load */
    });
  }

  /** A server page that stopped loading: come back to it once the server answers again. */
  private lost(url: string, detail: string | null): void {
    this.resumeUrl = isServerPage(url, this.server) ? url : this.resumeUrl;
    const attempt = this.supersede();
    this.show("lost", { detail });
    this.scheduleRetry(attempt);
  }

  private supersede(): number {
    this.clearTimer();
    return ++this.attempt;
  }

  private clearTimer(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  // ---- the connection screen ----

  private freshView(phase: ConnectionPhase): ConnectionView {
    const local = isLocalServer(this.server);
    const checkout = local ? findCheckout(this.settings.checkoutDir, this.paths.checkoutSearch) : null;
    const port = checkout ? checkoutPort(checkout) : null;
    return {
      phase,
      server: this.server,
      local,
      checkout,
      checkoutPort: port !== null && port !== urlPort(this.server) ? port : null,
      nodeFound: !!this.node,
      conflict: false,
      detail: null,
      logPath: null,
      retryAt: null,
      since: Date.now(),
    };
  }

  private show(phase: ConnectionPhase, patch: Partial<ConnectionView> = {}): void {
    const base = phase === this.view.phase && this.view.server === this.server ? { ...this.view, retryAt: null } : this.freshView(phase);
    this.view = { ...base, ...patch, phase };
    if (!this.win) return;
    if (this.onConnectPage()) return this.push();
    resetTitleBarStyle(this.win);
    void this.win.loadURL(CONNECT_PAGE).catch(() => undefined);
  }

  private push(): void {
    if (this.win && this.onConnectPage()) this.win.webContents.send("connect:view", this.viewSnapshot());
  }

  private onConnectPage(): boolean {
    return !!this.win && isAppPage(this.win.webContents.getURL());
  }

  private onConsole(): boolean {
    return !!this.win && isServerPage(this.win.webContents.getURL(), this.server) && !this.win.webContents.isLoading();
  }

  // ---- the window ----

  private createWindow(): void {
    const win = createMainWindow({ saved: this.settings.bounds, preload: this.paths.preload, icon: this.paths.icon, version: this.version, linksRegistered: this.paths.linksRegistered });
    this.win = win;
    this.guardNavigation(win.webContents);
    this.watchLoads(win.webContents);
    win.on("close", () => {
      this.settings = { ...this.settings, bounds: currentBounds(win) };
      saveSettings(this.paths.userData, this.settings);
    });
    win.on("closed", () => {
      this.win = null;
      this.dispose();
    });
  }

  private watchLoads(contents: WebContents): void {
    contents.on("did-fail-load", (_event, code, description, url, isMainFrame) => {
      if (isMainFrame && code !== ERR_ABORTED && isServerPage(url, this.server)) this.lost(url, description);
    });
    contents.on("did-navigate", (_event, url, status) => {
      if (status >= 500 && isServerPage(url, this.server)) this.lost(url, `The server answered HTTP ${status}.`);
    });
    contents.on("render-process-gone", (_event, details) => {
      if (details.reason === "clean-exit") return;
      this.resumeUrl = isServerPage(contents.getURL(), this.server) ? contents.getURL() : this.resumeUrl;
      this.supersede();
      this.show("crashed", { detail: `The window stopped (${details.reason}).` });
    });
  }

  private guardNavigation(contents: WebContents): void {
    const onNavigate = (event: Electron.Event, url: string) => {
      const decision = classifyNavigation(url, this.server);
      if (decision === "allow") return;
      event.preventDefault();
      if (decision === "external") openExternal(url);
      if (decision === "browser-sign-in") this.beginBrowserSignIn(url);
    };
    contents.on("will-navigate", onNavigate);
    contents.on("will-redirect", onNavigate);
    contents.setWindowOpenHandler(({ url }) => {
      const decision = classifyWindowOpen(url, this.server);
      if (decision === "external") openExternal(url);
      if (decision !== "child" || !this.win) return { action: "deny" };
      return { action: "allow", overrideBrowserWindowOptions: childWindowOptions(this.win, this.paths.icon) };
    });
    contents.on("did-create-window", (child) => {
      this.guardChild(child.webContents);
      if (backgroundWindows) child.once("ready-to-show", () => child.showInactive());
    });
  }

  /** Child windows show console pages only; everything else they try goes to the system browser. */
  private guardChild(contents: WebContents): void {
    const onNavigate = (event: Electron.Event, url: string) => {
      if (classifyWindowOpen(url, this.server) === "child") return;
      event.preventDefault();
      if (classifyWindowOpen(url, this.server) === "external") openExternal(url);
    };
    contents.on("will-navigate", onNavigate);
    contents.on("will-redirect", onNavigate);
    contents.setWindowOpenHandler(({ url }) => {
      if (classifyWindowOpen(url, this.server) !== "deny") openExternal(url);
      return { action: "deny" };
    });
  }

  /** Google refuses sign-in inside embedded browsers. The system browser signs in instead and hands this
   *  window a one-time ticket over the `ggo://auth` link (server/src/desktop.ts). */
  private beginBrowserSignIn(url: string): void {
    const target = new URL(url);
    target.searchParams.set("desktop", "1");
    openExternal(target.href);
    this.resumeUrl = consoleUrl(this.server);
    this.supersede();
    this.show("browser-sign-in");
  }
}
