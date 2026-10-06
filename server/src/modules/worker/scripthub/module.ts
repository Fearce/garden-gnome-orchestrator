import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { JsonFile } from "../configStore.js";
import type { ModuleFactory } from "../context.js";
import { hubFetch, hubJson } from "../hubClient.js";
import { loadOrImport, withValue, type StoredConfig } from "../legacyImport.js";
import { HttpError, Router, STREAMED } from "../router.js";
import { organizationOf, readOrganization, type Organization } from "./organization.js";
import { editEntry, readEntry, registryPath } from "./registry.js";

interface ScriptHubConfig {
  /** Script ids the owner hid from the list; revealed again with "Show hidden". */
  hiddenScripts: string[];
  organization?: Record<string, Organization>;
}

const ACTIONS = new Set(["start", "stop", "restart"]);
const SCRIPT_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/** Script Hub stays the process supervisor; this module is its control panel inside GGO. */
export const createScriptHubModule: ModuleFactory = async (ctx) => {
  const file = new JsonFile<StoredConfig<ScriptHubConfig>>(ctx.configPath);
  let config = await loadConfig();
  const router = new Router();
  const streams = new Set<AbortController>();

  async function loadConfig(): Promise<StoredConfig<ScriptHubConfig>> {
    return loadOrImport({
      file,
      hubUrl: ctx.hubUrl,
      sections: ["hiddenScripts"],
      fromDeck: (sections) => {
        const hidden = sections.hiddenScripts;
        return Array.isArray(hidden) ? { hiddenScripts: hidden.filter((id): id is string => typeof id === "string") } : null;
      },
      empty: () => ({ hiddenScripts: [] }),
      log: ctx.log,
    });
  }

  // Serialize read-modify-write operations, and publish a new config only after durable storage succeeds.
  let writes: Promise<unknown> = Promise.resolve();
  function save(change: (value: ScriptHubConfig) => ScriptHubConfig): Promise<void> {
    const next = writes.then(async () => {
      const updated = withValue(config, change(config.value));
      await file.write(updated);
      config = updated;
    });
    writes = next.catch(() => undefined);
    return next;
  }

  let details: { revision: string; scripts: Record<string, ScriptDetails> } = { revision: "", scripts: {} };

  // The hub's status is ~700 KB, four fifths of it descriptions and notes that rarely change. The poll gets
  // the live part; the text is served once from /details and refetched only when its revision moves.
  router.get("/status", async () => {
    // A config that could not be imported while the hub was down gets another try once it answers.
    if (config.origin === "deck-unreachable" && !(await file.read())) config = await loadConfig();
    const status = await hubJson<{ generatedAt: string; scripts: HubScript[] }>(ctx.hubUrl, "/api/status", { timeoutMs: 20_000 });
    const scripts = Array.isArray(status.scripts) ? status.scripts : [];
    details = detailsOf(scripts, details);
    return { generatedAt: status.generatedAt, hiddenScripts: config.value.hiddenScripts, detailsRevision: details.revision, scripts: scripts.map((script) => slimScript(script, config.value.organization?.[script.id])) };
  });

  router.get("/details", () => details);

  router.get("/scripts/:id/entry", async ({ params }) => readEntry(await registryPath(ctx.hubUrl), scriptId(params.id)));
  router.put("/scripts/:id/entry", async ({ params, body }) => {
    const id = scriptId(params.id);
    const result = await editEntry(await registryPath(ctx.hubUrl), id, body);
    ctx.log(`scripthub entry ${id} updated; running processes unchanged`);
    return result;
  });

  // Before the generic action route, which would otherwise take "keepalive" for an action name.
  router.post("/scripts/:id/keepalive", async ({ params, body }) => {
    const id = scriptId(params.id);
    const enabled = (body as { enabled?: unknown }).enabled;
    if (typeof enabled !== "boolean") throw new HttpError(400, "enabled must be true or false");
    return hubJson(ctx.hubUrl, `/api/keepalive/${enabled ? "enable" : "disable"}`, { method: "POST", body: JSON.stringify({ id }), timeoutMs: 30_000 });
  });

  router.post("/scripts/:id/:action", async ({ params }) => {
    const id = scriptId(params.id);
    if (!ACTIONS.has(params.action!)) throw new HttpError(404, `unknown action ${params.action}`);
    return hubJson(ctx.hubUrl, `/api/${params.action}`, { method: "POST", body: JSON.stringify({ id }), timeoutMs: 60_000 });
  });

  router.put("/hidden", async ({ body }) => {
    const ids = (body as { hiddenScripts?: unknown }).hiddenScripts;
    if (!Array.isArray(ids) || !ids.every((id) => typeof id === "string" && SCRIPT_ID.test(id))) throw new HttpError(400, "hiddenScripts must be a list of script ids");
    await save((value) => ({ ...value, hiddenScripts: [...new Set(ids as string[])] }));
    return { hiddenScripts: config.value.hiddenScripts };
  });

  async function saveOrganization(updates: Record<string, Organization>) {
    const registry = await hubJson<{ scripts: HubScript[] }>(ctx.hubUrl, "/api/scripts");
    const ids = new Set(registry.scripts?.map((script) => script.id));
    if (Object.keys(updates).some((id) => !ids.has(id))) throw new HttpError(404, "script not found");
    await save((value) => ({ ...value, organization: { ...value.organization, ...updates } }));
  }

  router.put("/scripts/:id/organization", async ({ params, body }) => {
    const id = scriptId(params.id);
    const organization = readOrganization(body);
    await saveOrganization({ [id]: organization });
    return organization;
  });

  // Apply a reviewed registry audit atomically; rejected entries leave the entire saved list intact.
  router.put("/organization", async ({ body }) => {
    const scripts = (body as { scripts?: unknown })?.scripts;
    if (!scripts || typeof scripts !== "object" || Array.isArray(scripts) || Object.keys(scripts).length > 2000) throw new HttpError(400, "scripts must be an object with up to 2000 entries");
    const updates = Object.fromEntries(Object.entries(scripts).map(([id, value]) => [scriptId(id), readOrganization(value)]));
    await saveOrganization(updates);
    return { saved: Object.keys(updates).length };
  });

  // The hub's log tail is Server-Sent Events; relay it unchanged and drop the upstream when the viewer leaves.
  router.get("/scripts/:id/logs", async ({ params, raw, res }) => {
    const id = scriptId(params.id);
    const abort = new AbortController();
    streams.add(abort);
    raw.once("close", () => abort.abort());
    try {
      const upstream = await hubFetch(ctx.hubUrl, `/api/logs/${encodeURIComponent(id)}`, { signal: abort.signal });
      if (!upstream.ok || !upstream.body) throw new HttpError(upstream.status === 404 ? 404 : 502, `Script Hub has no log for ${id}`);
      res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store", connection: "keep-alive" });
      const body = Readable.fromWeb(upstream.body as never);
      body.on("error", () => res.end());
      body.pipe(res);
      await new Promise<void>((resolve) => res.once("close", () => resolve()));
      return STREAMED;
    } finally {
      abort.abort();
      streams.delete(abort);
    }
  });

  return {
    router,
    busy: () => null,
    shutdown: async () => {
      for (const stream of streams) stream.abort();
    },
  };
};

interface HubScript {
  id: string;
  owner?: string;
  agentManaged?: boolean;
  tags?: string[];
  displayName?: string;
  category?: string;
  description?: string;
  aliases?: string[];
  notes?: string[] | string;
  keepAlive?: boolean;
  start?: { type?: string; taskName?: string; executable?: string; args?: string[] };
  status?: {
    state?: string;
    processes?: { processId: number; name: string; commandLine?: string }[];
    tasks?: { taskName: string; state: string }[];
    processEnumeration?: unknown;
  };
}

interface ScriptDetails {
  description: string;
  notes: string[];
  aliases: string[];
}

const COMMAND_LINE_MAX = 320;
const PROCESSES_SHOWN = 3;

function notesOf(script: HubScript): string[] {
  if (Array.isArray(script.notes)) return script.notes.map(String);
  return script.notes ? [String(script.notes)] : [];
}

function slimScript(script: HubScript, saved?: Organization) {
  const start = script.start ?? {};
  const command = start.type === "task" ? String(start.taskName ?? "") : [start.executable, ...(start.args ?? [])].filter(Boolean).join(" ");
  const processes = script.status?.processes ?? [];
  return {
    id: script.id,
    owner: script.owner ?? null,
    displayName: script.displayName || script.id,
    ...organizationOf(script, saved),
    keepAlive: script.keepAlive === true,
    command: command.slice(0, 600),
    // A scaffold folded into its venue runner has no process of its own; the registry marks it in a note.
    consolidated: notesOf(script).some((note) => note.includes("Consolidated under")),
    status: {
      state: script.status?.state ?? "unknown",
      processCount: processes.length,
      processes: processes.slice(0, PROCESSES_SHOWN).map((p) => ({ processId: p.processId, name: p.name, commandLine: String(p.commandLine ?? "").slice(0, COMMAND_LINE_MAX) })),
      tasks: script.status?.tasks ?? [],
      processEnumeration: script.status?.processEnumeration ?? null,
    },
  };
}

function detailsOf(scripts: HubScript[], previous: { revision: string; scripts: Record<string, ScriptDetails> }) {
  const next: Record<string, ScriptDetails> = {};
  for (const script of scripts) next[script.id] = { description: script.description ?? "", notes: notesOf(script), aliases: script.aliases ?? [] };
  const revision = createHash("sha1").update(JSON.stringify(next)).digest("hex").slice(0, 16);
  return revision === previous.revision ? previous : { revision, scripts: next };
}

function scriptId(value: string | undefined): string {
  if (!value || !SCRIPT_ID.test(value)) throw new HttpError(400, "invalid script id");
  return value;
}
