import { app, Notification, shell, type BrowserWindow, type DownloadItem, type Session } from "electron";
import { existsSync } from "node:fs";
import { downloadPath } from "./downloadPath";

/**
 * Downloads (a deliverable's Download button) go straight to the Downloads folder, as in a browser,
 * with progress on the taskbar button and a notification that opens the folder. Without this Electron
 * stops on a Save As dialog for every file.
 */
export function handleDownloads(ses: Session, mainWindow: () => BrowserWindow | null): void {
  ses.on("will-download", (_event, item) => {
    const target = downloadPath(app.getPath("downloads"), item.getFilename(), existsSync);
    item.setSavePath(target);
    item.on("updated", () => showProgress(mainWindow(), item));
    item.once("done", (_done, state) => {
      mainWindow()?.setProgressBar(-1);
      if (state === "completed") announce(target);
      else if (state === "interrupted") announceFailure(item.getFilename());
    });
  });
}

function showProgress(win: BrowserWindow | null, item: DownloadItem): void {
  if (!win || win.isDestroyed()) return;
  const total = item.getTotalBytes();
  // Unknown size: Windows shows an indeterminate bar for any value above 1.
  win.setProgressBar(total > 0 ? item.getReceivedBytes() / total : 2);
}

function announce(file: string): void {
  if (!Notification.isSupported()) return;
  const note = new Notification({ title: "Download complete", body: `${file}\nClick to show it in its folder.`, silent: true });
  note.on("click", () => shell.showItemInFolder(file));
  note.show();
}

function announceFailure(name: string): void {
  if (!Notification.isSupported()) return;
  new Notification({ title: "Download failed", body: `${name} didn't finish downloading.`, silent: true }).show();
}
