import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

/**
 * One module's settings file. The worker is its only writer, writes go through a temp file and a rename so
 * a crash mid-write cannot leave half a camera list, and every write is serialised behind the last.
 */
export class JsonFile<T> {
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly path: string) {}

  async read(): Promise<T | null> {
    try {
      return JSON.parse(await readFile(this.path, "utf8")) as T;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw new Error(`${basename(this.path)} could not be read: ${(error as Error).message}`);
    }
  }

  write(value: T): Promise<void> {
    const next = this.queue.then(() => writeAtomic(this.path, `${JSON.stringify(value, null, 2)}\n`));
    this.queue = next.catch(() => undefined);
    return next;
  }
}

export async function writeAtomic(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temp = join(dirname(path), `.${basename(path)}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`);
  try {
    await writeFile(temp, text, { encoding: "utf8", flag: "wx" });
    await rename(temp, path);
  } finally {
    await rm(temp, { force: true });
  }
}
