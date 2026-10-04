import { useEffect, useState } from "react";
import { useStore } from "../store.js";
import { IOS_PHONE } from "../lib/iosPhone.js";
import { desktopAvailable, desktopBridge, mintDesktopTicket } from "../lib/desktop.js";

/** How long the page waits to lose focus to the desktop app before saying it didn't seem to open. */
const LAUNCH_GRACE_MS = 4_000;

/**
 * Hand the console to its other half on this task: "Open in web" inside the desktop app, and "Open in
 * desktop" in a browser on a machine where the app has run. Each side carries a one-time ticket, so
 * the other lands signed in.
 */
export function DesktopSwitch() {
  return desktopBridge ? <OpenInWeb /> : <OpenInDesktop />;
}

function OpenInWeb() {
  const [busy, setBusy] = useState(false);
  const open = async () => {
    if (busy || !desktopBridge) return;
    setBusy(true);
    const ticket = await mintDesktopTicket();
    await desktopBridge.openInBrowser(useStore.getState().selectedThreadId, ticket).catch(() => undefined);
    setBusy(false);
  };
  return (
    <button className="shell-switch" title="Open this console in your browser" aria-label="Open in web" disabled={busy} onClick={() => void open()}>
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <circle cx="12" cy="12" r="9" />
        <path d="M3 12h18" />
        <path d="M12 3a14 14 0 0 1 0 18a14 14 0 0 1 0-18" />
      </svg>
      <span>Open in web</span>
    </button>
  );
}

function OpenInDesktop() {
  const available = useDesktopAvailable();
  const [busy, setBusy] = useState(false);
  if (!available) return null;
  const open = async () => {
    if (busy) return;
    setBusy(true);
    const ticket = await mintDesktopTicket();
    setBusy(false);
    if (!ticket) {
      useStore.setState({ notice: { level: "warn", title: "Desktop app not opened", message: "The console couldn't get a sign-in link for it. Try again in a moment." } });
      return;
    }
    const link = new URL("ggo://open");
    link.searchParams.set("ticket", ticket);
    const thread = useStore.getState().selectedThreadId;
    if (thread) link.searchParams.set("thread", thread);
    watchForLaunch();
    location.href = link.href;
  };
  return (
    <button className="shell-switch" title="Open this console in the GG Orchestrator desktop app" aria-label="Open in desktop" disabled={busy} onClick={() => void open()}>
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <rect x="3" y="4" width="18" height="12" rx="2" />
        <path d="M8 20h8" />
        <path d="M12 16v4" />
      </svg>
      <span>Open in desktop</span>
    </button>
  );
}

/** Offered only where it can work: a pointer-driven screen on a machine where the app registered. */
function useDesktopAvailable(): boolean {
  const [available, setAvailable] = useState(false);
  useEffect(() => {
    if (IOS_PHONE || !matchMedia("(pointer: fine)").matches) return;
    const controller = new AbortController();
    void desktopAvailable(controller.signal).then(setAvailable);
    return () => controller.abort();
  }, []);
  return available;
}

/** A browser gives no answer to an external-protocol launch; the app taking focus is the only sign. */
function watchForLaunch(): void {
  let launched = false;
  const onBlur = () => {
    launched = true;
  };
  window.addEventListener("blur", onBlur, { once: true });
  window.setTimeout(() => {
    window.removeEventListener("blur", onBlur);
    if (launched || !document.hasFocus()) return;
    useStore.setState({
      notice: {
        level: "info",
        title: "Desktop app didn't open",
        message: "If your browser asked whether to open GG Orchestrator, allow it. Otherwise start the desktop app once, so it registers its link again.",
      },
    });
  }, LAUNCH_GRACE_MS);
}
