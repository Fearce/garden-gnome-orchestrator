import { createHash } from "node:crypto";
import { open, readFile, stat, unlink } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { writeAtomic } from "../configStore.js";
import { hubJson } from "../hubClient.js";
import { HttpError } from "../router.js";

type Entry = Record<string, unknown> & { id: string };
type Registry = Record<string, unknown> & { scripts: Entry[] };
const LOCK_STALE_MS = 30_000;
const revisionOf =(entry: Entry) => createHash("sha256").update(JSON.stringify(entry)).digest("hex");

/** Discover the shared file through the hub's own entry; no client-supplied file paths. */
export async function registryPath(hubUrl: string): Promise<string> {
  if (!["localhost", "127.0.0.1", "[::1]"].includes(new URL(hubUrl).hostname)) throw new HttpError(409, "Entry editing requires a local Script Hub.");
  const registry = await hubJson<{ scripts: { id: string; start?: { workingDir?: string } }[] }>(hubUrl, "/api/scripts");
  const root = registry.scripts.find((entry) => entry.id === "script-hub")?.start?.workingDir;
  if (!root || !isAbsolute(root)) throw new HttpError(409, "Script Hub's registry location is unavailable.");
  return join(root, "registry", "scripts.json");
}

async function readRegistry(path: string): Promise<Registry> {
  let registry: Registry;
  try { registry = JSON.parse(await readFile(path, "utf8")); }
  catch { throw new HttpError(409, "Script Hub's registry could not be read. No changes were saved."); }
  if (!registry || !Array.isArray(registry.scripts) || registry.scripts.some((entry) => !entry || typeof entry.id !== "string")) throw new HttpError(409, "Script Hub's registry is invalid.");
  return registry;
}

function entryOf(registry: Registry, id: string): Entry {
  const entries = registry.scripts.filter((entry) => entry.id === id);
  if (entries.length !== 1) throw new HttpError(entries.length ? 409 : 404, entries.length ? "Duplicate script ids must be repaired before editing." : "Script not found.");
  return entries[0]!;
}

export async function readEntry(path: string, id: string) {
  const entry = entryOf(await readRegistry(path), id);
  return { entry, revision: revisionOf(entry) };
}

function validateEntry(raw: unknown, current: Entry): Entry {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new HttpError(400, "Entry must be a JSON object.");
  const entry = raw as Entry;
  if (entry.id !== current.id) throw new HttpError(400, "The script id cannot be changed.");
  if (entry.keepAlive !== current.keepAlive || entry.keepAlivePolicy !== current.keepAlivePolicy) throw new HttpError(400, "Use the Keep Alive control to change supervision.");
  if (JSON.stringify(entry.tags) !== JSON.stringify(current.tags) || entry.agentManaged !== current.agentManaged) throw new HttpError(400, "Use Organize to change tags or management.");
  for (const key of ["displayName", "description", "owner"]) {
    if (entry[key] !== undefined && typeof entry[key] !== "string") throw new HttpError(400, `${key} must be text.`);
  }
  for (const key of ["aliases", "tags"]) {
    if (entry[key] !== undefined && (!Array.isArray(entry[key]) || !(entry[key] as unknown[]).every((value) => typeof value === "string"))) throw new HttpError(400, `${key} must be a list of strings.`);
  }
  if (entry.notes !== undefined && typeof entry.notes !== "string" && (!Array.isArray(entry.notes) || !entry.notes.every((value) => typeof value === "string"))) throw new HttpError(400, "Notes must be text or a list of strings.");
  if (entry.agentManaged !== undefined && typeof entry.agentManaged !== "boolean") throw new HttpError(400, "agentManaged must be true or false.");
  if (entry.start !== undefined) {
    if (!entry.start || typeof entry.start !== "object" || Array.isArray(entry.start)) throw new HttpError(400, "Start settings must be an object.");
    const start = entry.start as Record<string, unknown>;
    for (const key of ["type", "executable", "workingDir", "taskName", "windowStyle"]) {
      if (start[key] !== undefined && typeof start[key] !== "string") throw new HttpError(400, `start.${key} must be text.`);
    }
    if (start.args !== undefined && (!Array.isArray(start.args) || !start.args.every((arg) => typeof arg === "string"))) throw new HttpError(400, "Launch arguments must be a JSON array of strings.");
    if (start.startHidden !== undefined && typeof start.startHidden !== "boolean") throw new HttpError(400, "startHidden must be true or false.");
  }
  if (entry.status !== undefined) {
    if (!entry.status || typeof entry.status !== "object" || Array.isArray(entry.status)) throw new HttpError(400, "Status settings must be an object.");
    const status = entry.status as Record<string, unknown>;
    for (const key of ["processMatchers", "taskNames"]) {
      if (status[key] !== undefined && (!Array.isArray(status[key]) || !(status[key] as unknown[]).every((value) => typeof value === "string"))) throw new HttpError(400, `${key} must be a list of strings.`);
    }
    if (status.portMatchers !== undefined && (!Array.isArray(status.portMatchers) || !status.portMatchers.every((value) => Number.isInteger(value) && value > 0 && value <= 65535))) throw new HttpError(400, "Port matchers must be valid port numbers.");
    const oldMatchers = (current.status as { processMatchers?: string[] } | undefined)?.processMatchers ?? [];
    for (const matcher of (status.processMatchers as string[] | undefined) ?? []) {
      if (oldMatchers.includes(matcher)) continue;
      try { new RegExp(matcher, "i"); } catch { throw new HttpError(400, "Process matcher is not a valid regular expression."); }
    }
  }
  if (JSON.stringify(entry).length > 100_000) throw new HttpError(400, "Entry is too large.");
  return entry;
}

/** Cooperates with Script Hub's agent upsert helper, which uses scripts.json.lock. */
export async function editEntry(path: string, id: string, body: unknown) {
  const request = body as { revision?: unknown; entry?: unknown } | null;
  if (!request || typeof request.revision !== "string") throw new HttpError(400, "The entry revision is required.");
  const lockPath = `${path}.lock`;
  let lock;
  const deadline = Date.now() + 5_000;
  while (!lock) {
    try { lock = await open(lockPath, "wx"); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      // Same rule as Script Hub's upsert_script.py: a lock older than 30s belongs to a crashed holder.
      const age = await stat(lockPath).then((info) => Date.now() - info.mtimeMs, () => 0);
      if (age > LOCK_STALE_MS) { await unlink(lockPath).catch(() => undefined); continue; }
      if (Date.now() >= deadline) throw new HttpError(409, "Another agent is updating Script Hub. Try saving again.");
      await delay(100);
    }
  }
  try {
    const registry = await readRegistry(path);
    const current = entryOf(registry, id);
    if (request.revision !== revisionOf(current)) throw new HttpError(409, "This entry changed since you opened it. Close and reopen the editor before saving.");
    const entry = validateEntry(request.entry, current);
    registry.scripts[registry.scripts.indexOf(current)] = entry;
    await writeAtomic(path, `${JSON.stringify(registry, null, 2)}\n`);
    return { entry, revision: revisionOf(entry) };
  } finally {
    await lock.close();
    await unlink(lockPath).catch(() => undefined);
  }
}
