import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { JsonFile } from "../configStore.js";
import type { ModuleFactory, WorkerContext } from "../context.js";
import { hubJson } from "../hubClient.js";
import { loadOrImport, withValue, type StoredConfig } from "../legacyImport.js";
import { HttpError, Router } from "../router.js";
import { bridgeFor, emptyHomeConfig, maskDevice, newDevice, normalizeDevice, normalizeHomeConfig, restoreDeviceSecrets, type HomeConfig, type VacuumDevice } from "./config.js";
import { HomeAssistantBridge, type VacuumStatus } from "./homeAssistant.js";
import { miioRequest } from "./miio.js";

const ACTIONS = new Set(["start", "pause", "home", "find"]);

/** Robot-vacuum control through Home Assistant or local miIO. Nothing polls here: the open tab asks. */
export const createHomeModule: ModuleFactory = async (ctx) => {
  const file = new JsonFile<StoredConfig<HomeConfig>>(ctx.configPath);
  let stored = await loadConfig(ctx, file);
  let homeAssistant = new HomeAssistantBridge(stored.value.homeAssistant.url, stored.value.homeAssistant.configDir);
  const router = new Router();

  router.get("/config", () => view());

  router.put("/config", async ({ body }) => {
    const incoming = normalizeHomeConfig(body);
    const before = new Map(stored.value.devices.map((device) => [device.id, device]));
    incoming.devices = incoming.devices.map((device) => restoreDeviceSecrets(device, before.get(device.id)));
    stored = withValue(stored, incoming);
    await file.write(stored);
    homeAssistant = new HomeAssistantBridge(incoming.homeAssistant.url, incoming.homeAssistant.configDir);
    return view();
  });

  router.get("/devices/new", () => ({ device: maskDevice(newDevice()) }));

  router.get("/devices/:id/status", async ({ params }) => {
    const device = findDevice(params.id!);
    const bridge = bridgeFor(device);
    if (bridge === "home-assistant") {
      const result = await homeAssistant.status(device);
      return statusView(device, bridge, result.status, result.entityId);
    }
    return statusView(device, bridge, await miioRequest(stored.value.pythonPath, device, "status"), null);
  });

  router.post("/devices/:id/actions/:action", async ({ params }) => {
    const device = findDevice(params.id!);
    const action = params.action!;
    if (!ACTIONS.has(action)) throw new HttpError(400, `Unknown vacuum action "${action}"`);
    const bridge = bridgeFor(device);
    if (bridge === "home-assistant") await homeAssistant.act(device, action);
    else await miioRequest(stored.value.pythonPath, device, action);
    ctx.log(`${device.name}: ${action} sent through ${bridge}`);
    return { ok: true, action, bridge, at: Date.now() };
  });

  /** Whether Home Assistant answers at all; it replies 401 to an unauthenticated probe when it is up. */
  router.get("/home-assistant", async () => {
    const url = stored.value.homeAssistant.url;
    try {
      const res = await fetch(`${url}/api/`, { signal: AbortSignal.timeout(4_000) });
      return { url, reachable: true, status: res.status, configDirFound: configDirFound() };
    } catch {
      return { url, reachable: false, status: null, configDirFound: configDirFound() };
    }
  });

  function configDirFound(): boolean {
    const dir = stored.value.homeAssistant.configDir;
    return Boolean(dir) && existsSync(join(dir, ".storage", "auth"));
  }

  function findDevice(id: string): VacuumDevice {
    const device = stored.value.devices.find((d) => d.id === id);
    if (!device) throw new HttpError(404, "That device is no longer configured");
    return device;
  }

  function view() {
    return { origin: stored.origin, importedAt: stored.importedAt, homeAssistant: stored.value.homeAssistant, pythonPath: stored.value.pythonPath, devices: stored.value.devices.map(maskDevice) };
  }

  return { router, busy: () => null, shutdown: async () => undefined };
};

function statusView(device: VacuumDevice, bridge: string, status: VacuumStatus | null, entityId: string | null) {
  return { id: device.id, bridge, entityId, status, at: Date.now() };
}

async function loadConfig(ctx: WorkerContext, file: JsonFile<StoredConfig<HomeConfig>>): Promise<StoredConfig<HomeConfig>> {
  const homeAssistantDir = (await file.read()) ? "" : await deckHomeAssistantDir(ctx.hubUrl);
  const stored = await loadOrImport({
    file,
    hubUrl: ctx.hubUrl,
    sections: ["home-control"],
    fromDeck: (sections) => fromDeckSection(sections["home-control"], homeAssistantDir),
    empty: () => ({ ...emptyHomeConfig(), homeAssistant: { url: "http://127.0.0.1:8123", configDir: homeAssistantDir } }),
    log: ctx.log,
  });
  return { ...stored, value: normalizeHomeConfig(stored.value) };
}

/** The Deck's "home-control" section: its device list. Home Assistant's address was fixed in the Deck. */
function fromDeckSection(section: unknown, homeAssistantDir: string): HomeConfig | null {
  const devices = (section as { devices?: unknown } | null)?.devices;
  if (!Array.isArray(devices) || !devices.length) return null;
  return { ...emptyHomeConfig(), homeAssistant: { url: "http://127.0.0.1:8123", configDir: homeAssistantDir }, devices: devices.map(normalizeDevice) };
}

/** The Deck read Home Assistant's `.storage` from a `home-assistant-xiaomi/config` folder beside Script Hub. */
async function deckHomeAssistantDir(hubUrl: string): Promise<string> {
  try {
    const status = await hubJson<{ scripts?: { id: string; start?: { workingDir?: string } }[] }>(hubUrl, "/api/status", { timeoutMs: 20_000 });
    const hubDir = status.scripts?.find((script) => script.id === "script-hub")?.start?.workingDir;
    if (!hubDir) return "";
    const candidate = join(dirname(hubDir), "home-assistant-xiaomi", "config");
    return existsSync(join(candidate, ".storage")) ? candidate : "";
  } catch {
    return "";
  }
}
