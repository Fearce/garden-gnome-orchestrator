import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { HttpError } from "../router.js";
import type { VacuumDevice } from "./config.js";
import type { VacuumStatus } from "./homeAssistant.js";

// The same relative path works from this file in src and from its compiled copy in dist; the script ships in src.
const BRIDGE = fileURLToPath(new URL("../../../../src/modules/worker/home/xiaomi-vacuum.py", import.meta.url));
const TIMEOUT_MS = 30_000;
const MAX_OUTPUT = 64 * 1024;

interface BridgeAnswer {
  ok: boolean;
  error?: string;
  status?: {
    state?: string | null;
    error?: string | null;
    battery?: number | null;
    chargeState?: string | null;
    fanSpeed?: string | null;
    waterLevel?: string | null;
    cleanArea?: number | null;
    cleanTimeSeconds?: number | null;
  };
}

/** One request at a time per vacuum: the device answers a single miIO session, and a second would time out. */
const queues = new Map<string, Promise<unknown>>();

/** Local control over miIO, through python-miio in a short-lived Python process. */
export async function miioRequest(pythonPath: string, device: VacuumDevice, action: string): Promise<VacuumStatus | null> {
  if (!device.host) throw new HttpError(400, `${device.name} has no host or IP address`);
  if (!device.token) throw new HttpError(400, `${device.name} has no miIO token`);
  const previous = queues.get(device.id) ?? Promise.resolve();
  const run = previous.catch(() => undefined).then(() => runBridge(pythonPath, { action, host: device.host, token: device.token, model: device.model }));
  queues.set(device.id, run);
  try {
    const answer = await run;
    return answer.status ? toStatus(answer.status) : null;
  } finally {
    if (queues.get(device.id) === run) queues.delete(device.id);
  }
}

function runBridge(pythonPath: string, request: Record<string, string>): Promise<BridgeAnswer> {
  return new Promise((resolve, reject) => {
    const child = spawn(pythonPath, [BRIDGE], { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new HttpError(504, `The vacuum did not answer within ${TIMEOUT_MS / 1000}s`));
    }, TIMEOUT_MS);
    child.stdout.on("data", (chunk: Buffer) => { if (stdout.length < MAX_OUTPUT) stdout += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk: Buffer) => { if (stderr.length < MAX_OUTPUT) stderr += chunk.toString("utf8"); });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(new HttpError(503, `Python could not be started (${pythonPath}): ${error.message}`));
    });
    child.on("close", () => {
      clearTimeout(timer);
      const answer = parseAnswer(stdout);
      if (answer?.ok) return resolve(answer);
      const reason = answer?.error || lastLine(stderr) || "the miIO bridge failed without a message";
      reject(new HttpError(502, reason));
    });
    child.stdin.end(JSON.stringify(request));
  });
}

function parseAnswer(stdout: string): BridgeAnswer | null {
  const line = stdout.trim().split(/\r?\n/).pop();
  if (!line) return null;
  try {
    return JSON.parse(line) as BridgeAnswer;
  } catch {
    return null;
  }
}

function lastLine(text: string): string {
  return text.trim().split(/\r?\n/).pop()?.slice(0, 400) ?? "";
}

function toStatus(raw: NonNullable<BridgeAnswer["status"]>): VacuumStatus {
  const minutes = typeof raw.cleanTimeSeconds === "number" ? Math.round(raw.cleanTimeSeconds / 60) : null;
  return {
    state: raw.state ?? null,
    battery: typeof raw.battery === "number" ? raw.battery : null,
    chargeState: raw.chargeState ?? null,
    fanSpeed: raw.fanSpeed ?? null,
    waterLevel: raw.waterLevel ?? null,
    error: raw.error && raw.error !== "NoError" ? raw.error : null,
    cleanArea: typeof raw.cleanArea === "number" ? `${raw.cleanArea} m²` : null,
    cleanTime: minutes === null ? null : `${minutes} min`,
    friendlyName: null,
  };
}
