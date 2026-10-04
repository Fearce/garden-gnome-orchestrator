import { contextBridge, ipcRenderer } from "electron";
import type { ConnectChannel, ConnectionView, ConsoleChannel, PushChannel, SetServerResult, TitleBarStyle } from "./contract";

// One preload serves both pages the window can show, and each page gets only its own API. The main
// process re-checks the sending frame on every call, so this split is a convenience, not the boundary.

const invoke = <T>(channel: ConnectChannel | ConsoleChannel, ...args: unknown[]): Promise<T> =>
  ipcRenderer.invoke(channel, ...args) as Promise<T>;

function subscribe<T>(channel: PushChannel, callback: (value: T) => void): () => void {
  const listener = (_event: unknown, value: T) => callback(value);
  ipcRenderer.on(channel, listener);
  return () => {
    ipcRenderer.removeListener(channel, listener);
  };
}

const version = process.argv.find((arg) => arg.startsWith("--ggo-desktop-version="))?.split("=")[1] ?? "";
const linksRegistered = !process.argv.includes("--ggo-desktop-links=0");

if (location.protocol === "ggo-app:") {
  contextBridge.exposeInMainWorld("ggoConnect", {
    state: () => invoke<ConnectionView>("connect:state"),
    onView: (callback: (view: ConnectionView) => void) => subscribe("connect:view", callback),
    retry: () => invoke<void>("connect:retry"),
    startServer: () => invoke<void>("connect:start-server"),
    setServer: (url: string) => invoke<SetServerResult>("connect:set-server", String(url)),
    chooseCheckout: () => invoke<void>("connect:choose-checkout"),
    openLog: () => invoke<void>("connect:open-log"),
    back: () => invoke<void>("connect:back"),
  });
} else {
  contextBridge.exposeInMainWorld("ggoDesktop", {
    version,
    platform: process.platform,
    linksRegistered,
    openInBrowser: (threadId: string | null, ticket: string | null) => invoke<void>("console:open-in-browser", threadId, ticket),
    onOpenThread: (callback: (threadId: string) => void) => subscribe("console:open-thread", callback),
    setTitleBarStyle: (style: TitleBarStyle) => invoke<void>("console:title-bar", style),
  });
}
