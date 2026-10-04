import { extname, join } from "node:path";

/** Characters Windows refuses in a file name, plus control characters. */
const UNSAFE = /[<>:"/\\|?*\u0000-\u001f]/g;
const FALLBACK = "download";

/**
 * Where a download lands: the suggested name made safe, in `dir`, numbered like a browser does
 * (`report (1).md`) rather than overwriting a file already there.
 */
export function downloadPath(dir: string, suggested: string, exists: (path: string) => boolean): string {
  // Split by hand: `basename` reads "a:b" as a drive on Windows and keeps only "b".
  const last = suggested.split(/[/\\]/).pop() ?? "";
  const name = last.replace(UNSAFE, "_").replace(/^[.\s]+|[.\s]+$/g, "") || FALLBACK;
  const ext = extname(name);
  const stem = name.slice(0, name.length - ext.length) || FALLBACK;
  let candidate = join(dir, `${stem}${ext}`);
  for (let n = 1; exists(candidate); n++) candidate = join(dir, `${stem} (${n})${ext}`);
  return candidate;
}
