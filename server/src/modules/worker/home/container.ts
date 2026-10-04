import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { HttpError } from "../router.js";

/** The Docker container that runs the owner's Home Assistant, found by the config folder it mounts. */
export interface HomeAssistantContainer {
  id: string;
  name: string;
  /** Docker's own word: running, exited, restarting, paused, created or dead. */
  state: string;
  startedAt: string | null;
  finishedAt: string | null;
}

export type DockerRunner = (args: string[], timeoutMs: number) => Promise<string>;

const LIST_TIMEOUT_MS = 15_000;
const START_TIMEOUT_MS = 75_000;
const STOP_TIMEOUT_MS = 60_000;
/**
 * One deadline for a whole start or stop: looking the container up, the docker call and the re-check after it.
 * It stays under the console proxy's 90s answer limit (RESPONSE_TIMEOUT_MS in routes.ts), so the owner gets
 * Docker's own answer, never the proxy's generic timeout.
 */
export const CONTROL_DEADLINE_MS = 80_000;
/** Less than this left is not worth starting another docker call for. */
const MIN_CALL_MS = 1_000;
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;

/** Runs the Docker CLI as a bounded child of this worker; a hung Docker Desktop costs a timeout, never the event loop. */
export const runDocker: DockerRunner = (args, timeoutMs) =>
  new Promise((done, fail) => {
    execFile("docker", args, { timeout: timeoutMs, maxBuffer: MAX_OUTPUT_BYTES, windowsHide: true }, (error, stdout, stderr) => {
      if (!error) return done(stdout);
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") return fail(new HttpError(503, "Docker is not installed on this PC, so GGO cannot start Home Assistant"));
      if ((error as { killed?: boolean }).killed) return fail(new HttpError(504, `Docker did not answer within ${Math.round(timeoutMs / 1000)}s; is Docker Desktop running?`));
      const detail = String(stderr || error.message).trim().split(/\r?\n/)[0] ?? "";
      fail(new HttpError(502, /daemon|pipe|connect/i.test(detail) ? "Docker is not running; start Docker Desktop first" : `Docker refused: ${detail}`));
    });
  });

function samePath(a: string, b: string): boolean {
  const norm = (p: string) => resolve(p).replace(/[\\/]+$/, "").replace(/\\/g, "/").toLowerCase();
  return norm(a) === norm(b);
}

interface InspectEntry {
  Id: string;
  Name?: string;
  State?: { Status?: string; StartedAt?: string; FinishedAt?: string };
  Mounts?: { Source?: string; Destination?: string }[];
}

/**
 * The container whose `/config` is Home Assistant's config folder, or null when none does (Home Assistant runs
 * some other way, or not on this PC). Only containers that already exist are considered; GGO never creates one.
 */
export async function findHomeAssistantContainer(
  configDir: string,
  docker: DockerRunner = runDocker,
  budget: (capMs: number) => number = (capMs) => capMs,
): Promise<HomeAssistantContainer | null> {
  if (!configDir) return null;
  const ids = (await docker(["ps", "-a", "--no-trunc", "--format", "{{.ID}}"], budget(LIST_TIMEOUT_MS))).split(/\s+/).filter(Boolean);
  if (!ids.length) return null;
  const entries = JSON.parse(await docker(["inspect", ...ids], budget(LIST_TIMEOUT_MS))) as InspectEntry[];
  const match = entries.find((entry) => (entry.Mounts ?? []).some((mount) => mount.Destination === "/config" && mount.Source && samePath(mount.Source, configDir)));
  if (!match) return null;
  const at = (value: string | undefined) => (value && !value.startsWith("0001-") ? value : null);
  return {
    id: match.Id,
    name: (match.Name ?? match.Id.slice(0, 12)).replace(/^\//, ""),
    state: match.State?.Status ?? "unknown",
    startedAt: at(match.State?.StartedAt),
    finishedAt: at(match.State?.FinishedAt),
  };
}

/**
 * Starts or stops that container on the owner's say-so, all within CONTROL_DEADLINE_MS. Its restart policy is
 * left exactly as he set it.
 */
export async function controlHomeAssistantContainer(
  configDir: string,
  action: "start" | "stop",
  docker: DockerRunner = runDocker,
  now: () => number = Date.now,
): Promise<HomeAssistantContainer> {
  const deadline = now() + CONTROL_DEADLINE_MS;
  const budget = (capMs: number) => {
    const left = deadline - now();
    if (left < MIN_CALL_MS) throw new HttpError(504, `Docker did not finish within ${CONTROL_DEADLINE_MS / 1000}s; is Docker Desktop running?`);
    return Math.min(capMs, left);
  };
  const container = await findHomeAssistantContainer(configDir, docker, budget);
  if (!container) throw new HttpError(404, "No Docker container mounts Home Assistant's config folder, so GGO cannot start or stop it; run Home Assistant yourself or set the config folder under Devices");
  await docker([action, container.id], budget(action === "start" ? START_TIMEOUT_MS : STOP_TIMEOUT_MS));
  // The action itself went through; a slow re-check must not turn that into an error, so it reports what was found before.
  try {
    return (await findHomeAssistantContainer(configDir, docker, budget)) ?? container;
  } catch {
    return container;
  }
}
