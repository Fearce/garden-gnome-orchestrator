import { protocol } from "electron";
import { readFile } from "node:fs/promises";
import { extname, join, normalize, sep } from "node:path";
import { APP_SCHEME } from "./navigationPolicy";

/**
 * The desktop app's own pages are served from `ggo-app://shell/…` rather than `file://` (Electron's
 * security checklist, item 18): a real origin the IPC layer can check, and a strict CSP on every response.
 * Only files inside `dist/static` exist on it.
 */

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".png": "image/png",
  ".woff2": "font/woff2",
};

const CSP = "default-src 'none'; script-src 'self'; style-src 'self'; font-src 'self'; img-src 'self'; connect-src 'none'; form-action 'none'; frame-ancestors 'none'; base-uri 'none'";

/** Must run before `app.whenReady()`. */
export function registerAppScheme(): void {
  protocol.registerSchemesAsPrivileged([{ scheme: APP_SCHEME, privileges: { standard: true, secure: true } }]);
}

export function serveAppPages(staticDir: string): void {
  const root = normalize(staticDir + sep);
  const notFound = () => new Response("Not found", { status: 404 });
  protocol.handle(APP_SCHEME, async (request) => {
    const url = new URL(request.url);
    let file: string;
    try {
      file = normalize(join(root, decodeURIComponent(url.pathname)));
    } catch {
      return notFound();
    }
    const type = TYPES[extname(file)];
    if (url.hostname !== "shell" || !file.startsWith(root) || !type) return notFound();
    const body = await readFile(file).catch(() => null);
    if (!body) return notFound();
    return new Response(body, {
      headers: { "content-type": type, "content-security-policy": CSP, "x-content-type-options": "nosniff", "cache-control": "no-store" },
    });
  });
}
