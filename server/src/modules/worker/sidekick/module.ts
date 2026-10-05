import { spawn } from "node:child_process";
import { open, readFile, stat } from "node:fs/promises";
import { Socket } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ModuleFactory } from "../context.js";
import { hubJson } from "../hubClient.js";
import { HttpError, Router } from "../router.js";
import { mutateRules } from "./rules.js";
import { buildSidekickState, type SidekickIo, type SidekickPaths } from "./state.js";

/** The tray app's id in Script Hub's registry, which knows where its exe lives and starts or stops it. */
const SIDEKICK_SCRIPT_ID = "sidekick";
const LOG_TAIL_BYTES = 128 * 1024;
const PROCESS_TABLE_MAX_AGE_MS = 3_000;
const REGISTRY_MAX_AGE_MS = 60_000;

interface RegistryScript {
  id: string;
  displayName?: string;
  start?: { executable?: string };
}

/** Sidekick's own settings file stays its single source of truth; this module reads and edits it in place. */
export const createSidekickModule: ModuleFactory = async (ctx) => {
  const router = new Router();
  const processes = new ProcessTable();
  let registry: { at: number; scripts: RegistryScript[] } | null = null;

  async function hubScripts(): Promise<RegistryScript[]> {
    if (registry && Date.now() - registry.at < REGISTRY_MAX_AGE_MS) return registry.scripts;
    try {
      const body = await hubJson<{ scripts?: RegistryScript[] }>(ctx.hubUrl, "/api/scripts", { timeoutMs: 15_000 });
      registry = { at: Date.now(), scripts: Array.isArray(body.scripts) ? body.scripts : [] };
    } catch (error) {
      if (!registry) throw error;
    }
    return registry!.scripts;
  }

  async function paths(scripts: RegistryScript[] | null): Promise<SidekickPaths> {
    const appData = process.env.APPDATA || join(homedir(), "AppData", "Roaming");
    const localAppData = process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local");
    return {
      exe: scripts?.find((script) => script.id === SIDEKICK_SCRIPT_ID)?.start?.executable ?? null,
      settings: join(appData, "Sidekick", "settings.json"),
      log: join(localAppData, "Sidekick", "sidekick.log"),
      startupShortcut: join(appData, "Microsoft", "Windows", "Start Menu", "Programs", "Startup", "Sidekick.lnk"),
      logLines: 60,
    };
  }

  const io: SidekickIo = {
    readText: (path) => readFile(path, "utf8").catch(() => null),
    readTail,
    exists: (path) => stat(path).then(() => true, () => false),
    mtime: (path) => stat(path).then((s) => s.mtime, () => null),
    runningImageNames: () => processes.names(),
    portIsListening,
  };

  router.get("/state", async () => {
    let scripts: RegistryScript[] | null = null;
    let hubError: string | null = null;
    try {
      scripts = await hubScripts();
    } catch (error) {
      hubError = (error as Error).message;
    }
    const state = await buildSidekickState(await paths(scripts), io);
    return {
      ...state,
      hubError,
      hubScripts: (scripts ?? [])
        .filter((script) => script.id !== SIDEKICK_SCRIPT_ID)
        .map((script) => ({ id: script.id, name: script.displayName || script.id }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    };
  });

  router.post("/rules", async ({ body }) => {
    const result = await mutateRules((await paths(null)).settings, { type: "create" }, body);
    ctx.log(`sidekick task ${result.ruleId} created`);
    return { ok: true, ...result };
  });

  router.put("/rules/:id", async ({ params, body }) => {
    const result = await mutateRules((await paths(null)).settings, { type: "update", id: params.id! }, body);
    ctx.log(`sidekick task ${result.ruleId} updated`);
    return { ok: true, ...result };
  });

  router.delete("/rules/:id", async ({ params, query }) => {
    // DELETE carries no body here; the revision travels in the query string.
    const revision = query.has("revision") ? (query.get("revision") || null) : undefined;
    const result = await mutateRules((await paths(null)).settings, { type: "delete", id: params.id! }, revision === undefined ? {} : { revision });
    ctx.log(`sidekick task ${result.ruleId} deleted`);
    return { ok: true, ...result };
  });

  router.post("/power/:action", async ({ params }) => {
    const action = params.action;
    if (action !== "start" && action !== "stop") throw new HttpError(404, `unknown action ${action}`);
    const result = await hubJson(ctx.hubUrl, `/api/${action}`, { method: "POST", body: JSON.stringify({ id: SIDEKICK_SCRIPT_ID }), timeoutMs: 60_000 });
    processes.invalidate();
    ctx.log(`sidekick ${action} requested through Script Hub`);
    return result;
  });

  return { router, busy: () => null, shutdown: async () => undefined };
};

async function readTail(path: string): Promise<string | null> {
  let handle;
  try {
    handle = await open(path, "r");
  } catch {
    return null;
  }
  try {
    const { size } = await handle.stat();
    const length = Math.min(size, LOG_TAIL_BYTES);
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, size - length);
    const text = buffer.toString("utf8");
    // Drop the partial first line a mid-file start lands in.
    return size > length ? text.slice(text.indexOf("\n") + 1) : text;
  } finally {
    await handle.close();
  }
}

/** The tray app's own probe for a companion that declares a port: a short loopback TCP connect. */
function portIsListening(port: number, timeoutMs = 400): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new Socket();
    const finish = (value: boolean) => {
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
    socket.connect(port, "127.0.0.1");
  });
}

/**
 * Running image names from `tasklist`, shared by every rule and companion in one state build. A failed read
 * keeps the last good table: "nothing is running" is a claim, and a table that could not be taken is not
 * evidence for it.
 */
class ProcessTable {
  private last: { at: number; names: string[] } | null = null;
  private pending: Promise<string[]> | null = null;

  invalidate(): void {
    this.last = null;
  }

  names(): Promise<string[]> {
    if (this.last && Date.now() - this.last.at < PROCESS_TABLE_MAX_AGE_MS) return Promise.resolve(this.last.names);
    this.pending ??= this.read().finally(() => (this.pending = null));
    return this.pending;
  }

  private async read(): Promise<string[]> {
    try {
      const names = process.platform === "win32" ? await tasklistNames() : [];
      this.last = { at: Date.now(), names };
      return names;
    } catch (error) {
      if (this.last) return this.last.names;
      throw error;
    }
  }
}

function tasklistNames(): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const child = spawn("tasklist", ["/FO", "CSV", "/NH"], { windowsHide: true, stdio: ["ignore", "pipe", "ignore"] });
    let out = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("tasklist took longer than 15s"));
    }, 15_000);
    child.stdout.on("data", (chunk: Buffer) => (out += chunk.toString("utf8")));
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(`tasklist exited ${code}`));
      resolve(out.split(/\r?\n/).map((line) => /^"([^"]+)"/.exec(line)?.[1]).filter((name): name is string => Boolean(name)));
    });
  });
}
