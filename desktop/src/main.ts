import { app, ipcMain, Menu, session, type IpcMainInvokeEvent, type Session } from "electron";
import { dirname, join, resolve } from "node:path";
import { registerAppScheme, serveAppPages } from "./appProtocol";
import type { ConnectChannel, ConsoleChannel } from "./contract";
import { DesktopController } from "./controller";
import { deepLinkFromArgv, PROTOCOL } from "./deepLink";
import { handleDownloads } from "./downloads";
import { buildMenu } from "./menu";
import { isAppPage, permissionAllowed } from "./navigationPolicy";
import { isServerPage } from "./serverUrl";
import { staticPath } from "./window";

// GGO_DESKTOP_USER_DATA gives a run its own profile (the desktop lab uses it). Such a run leaves the
// ggo:// registration alone, so a test never points the owner's links at a throwaway copy.
const isolatedProfile = process.env.GGO_DESKTOP_USER_DATA;
if (isolatedProfile) app.setPath("userData", resolve(isolatedProfile));

registerAppScheme();
// The same id the installer gives its shortcuts (package.json build.appId), so Windows attributes the
// app's notifications and taskbar button to it.
if (process.platform === "win32") app.setAppUserModelId("io.github.ggorchestrator.desktop");

if (!app.requestSingleInstanceLock()) {
  // The running instance receives this launch's arguments (a ggo:// link) through `second-instance`.
  app.quit();
} else {
  boot();
}

function boot(): void {
  let controller: DesktopController | null = null;
  let pendingLink = deepLinkFromArgv(process.argv);

  // macOS delivers links through open-url, which must be registered before `ready`.
  app.on("open-url", (event, url) => {
    event.preventDefault();
    if (controller) controller.handleDeepLink(url);
    else pendingLink = url;
  });
  app.on("second-instance", (_event, argv) => {
    const link = deepLinkFromArgv(argv);
    if (!controller) return;
    if (link) controller.handleDeepLink(link);
    else controller.focus();
  });
  app.on("web-contents-created", (_event, contents) => {
    contents.on("will-attach-webview", (event) => event.preventDefault());
  });
  if (!isolatedProfile) registerProtocolClient();

  void app.whenReady().then(() => {
    serveAppPages(staticPath(__dirname));
    controller = new DesktopController(
      {
        userData: app.getPath("userData"),
        preload: join(__dirname, "preload.js"),
        icon: staticPath(__dirname, "icon.png"),
        checkoutSearch: [app.getAppPath(), dirname(process.execPath)],
      },
      app.getVersion(),
    );
    const owner = controller;
    installSessionPolicy(session.defaultSession, () => owner.server, app.getVersion());
    handleDownloads(session.defaultSession, () => owner.window);
    registerIpc(owner);
    Menu.setApplicationMenu(buildMenu());
    owner.open(pendingLink);
    pendingLink = null;
  });

  app.on("activate", () => controller?.focus());
  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });
  app.on("before-quit", () => controller?.dispose());
}

/** From source, Windows needs the script path too, or the link would launch a bare Electron. */
function registerProtocolClient(): void {
  if (process.defaultApp) {
    const script = process.argv[1];
    if (script) app.setAsDefaultProtocolClient(PROTOCOL, process.execPath, [resolve(script)]);
  } else {
    app.setAsDefaultProtocolClient(PROTOCOL);
  }
}

/** The server recognises this app by its user agent (server/src/desktop.ts), and only the console's own
 *  origin gets the few browser permissions it uses. */
function installSessionPolicy(ses: Session, server: () => string, version: string): void {
  ses.setUserAgent(`${ses.getUserAgent()} GGODesktop/${version}`);
  ses.setPermissionRequestHandler((_contents, permission, callback, details) => {
    callback(permissionAllowed(permission, details.requestingUrl, server()));
  });
  ses.setPermissionCheckHandler((_contents, permission, requestingOrigin) => permissionAllowed(permission, requestingOrigin, server()));
}

function registerIpc(controller: DesktopController): void {
  const fromConnectPage = (event: IpcMainInvokeEvent) => controller.isMainFrame(event.senderFrame) && isAppPage(event.senderFrame?.url ?? "");
  const fromConsole = (event: IpcMainInvokeEvent) => controller.isMainFrame(event.senderFrame) && isServerPage(event.senderFrame?.url ?? "", controller.server);

  const connect = (channel: ConnectChannel, handler: (...args: unknown[]) => unknown) =>
    ipcMain.handle(channel, (event, ...args) => (fromConnectPage(event) ? handler(...args) : undefined));
  const consolePage = (channel: ConsoleChannel, handler: (...args: unknown[]) => unknown) =>
    ipcMain.handle(channel, (event, ...args) => (fromConsole(event) ? handler(...args) : undefined));

  connect("connect:state", () => controller.viewSnapshot());
  connect("connect:retry", () => controller.retry());
  connect("connect:start-server", () => controller.startServer());
  connect("connect:set-server", (url) => controller.setServer(url));
  connect("connect:choose-checkout", () => controller.chooseCheckout());
  connect("connect:open-log", () => controller.openLog());
  connect("connect:back", () => controller.back());
  consolePage("console:open-in-browser", (threadId, ticket) => controller.openInBrowser(threadId, ticket));
  consolePage("console:title-bar", (style) => controller.setTitleBarStyle(style));
}
