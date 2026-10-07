import { readFile, realpath, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

const SHA = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i;

async function text(file: string, maxBytes = 4096): Promise<string | undefined> {
  try {
    if ((await stat(file)).size > maxBytes) return undefined;
    return (await readFile(file, "utf8")).trim();
  } catch { return undefined; }
}

/** A dispatch baseline should not wait on process creation. Read standard Git metadata without
 * caching HEAD; an unknown layout or reference falls back to Git instead of inventing a baseline. */
export async function headFromFiles(workspace: string): Promise<string | undefined> {
  // Git environment overrides can change which repository a CLI read observes.
  if (!workspace || process.env.GIT_DIR || process.env.GIT_WORK_TREE || process.env.GIT_COMMON_DIR
    || process.env.GIT_CEILING_DIRECTORIES || process.env.GIT_DISCOVERY_ACROSS_FILESYSTEM
    || process.env.GIT_NAMESPACE) return undefined;
  let directory: string;
  let device: number;
  try {
    directory = await realpath(workspace);
    const metadata = await stat(directory);
    if (!metadata.isDirectory()) return undefined;
    device = metadata.dev;
  } catch { return undefined; }
  let gitDir: string | undefined;
  for (;;) {
    const marker = join(directory, ".git");
    try {
      const metadata = await stat(marker);
      if (metadata.isDirectory()) gitDir = marker;
      else {
        const link = await text(marker);
        if (link?.startsWith("gitdir: ")) gitDir = resolve(directory, link.slice(8));
      }
      break;
    } catch {
      const parent = dirname(directory);
      if (parent === directory) return undefined;
      try { if ((await stat(parent)).dev !== device) return undefined; }
      catch { return undefined; }
      directory = parent;
    }
  }
  if (!gitDir) return undefined;
  const common = await text(join(gitDir, "commondir"));
  const commonDir = common ? resolve(gitDir, common) : gitDir;
  let value = await text(join(gitDir, "HEAD"));
  for (let depth = 0; depth < 8; depth++) {
    if (value && SHA.test(value)) return value;
    const reference = value?.match(/^ref: (refs\/[A-Za-z0-9._/+\-]+)$/)?.[1];
    if (!reference || reference.split("/").some(part => !part || part === "." || part === "..")) return undefined;
    value = await text(join(gitDir, reference)) ?? await text(join(commonDir, reference));
    if (value != null) continue;
    const packed = await text(join(commonDir, "packed-refs"), 8 * 1024 * 1024);
    value = packed?.split(/\r?\n/).find(line => line.endsWith(` ${reference}`))?.split(" ")[0];
  }
  return undefined;
}
