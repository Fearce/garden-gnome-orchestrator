import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { HttpError } from "../router.js";
import type { VacuumDevice } from "./config.js";

export interface VacuumStatus {
  state: string | null;
  battery: number | null;
  chargeState: string | null;
  fanSpeed: string | null;
  waterLevel: string | null;
  error: string | null;
  cleanArea: string | null;
  cleanTime: string | null;
  friendlyName: string | null;
}

interface RegistryEntity {
  entity_id: string;
  device_id?: string;
  platform?: string;
  original_name?: string;
  unique_id?: string;
}

export interface ScheduleTargets {
  vacuum: string;
  battery: string | null;
  /** The vacuum's own "start charge" button, which docks the G1 more reliably than return_to_base. */
  dock: string | null;
}

export interface HaAutomation {
  /** The automation's config id, which Home Assistant's config API edits it by. */
  id: string;
  entityId: string;
  name: string;
  enabled: boolean;
  lastTriggered: string | null;
  config: Record<string, unknown>;
}

interface HaState {
  entity_id: string;
  state: string;
  attributes?: Record<string, unknown>;
}

const STATES_CACHE_MS = 2_000;
/** Config reads per schedule read; one per automation, so an install with many stays gentle on Home Assistant. */
const CONFIG_READS_AT_ONCE = 6;
const SERVICES: Record<string, [string, string]> = {
  start: ["vacuum", "start"],
  pause: ["vacuum", "pause"],
  home: ["vacuum", "return_to_base"],
  find: ["vacuum", "locate"],
};

/**
 * Controls a vacuum through a local Home Assistant. GGO signs in with the owner's own refresh token from Home
 * Assistant's `.storage/auth`, so nothing new has to be issued; the token never leaves this worker.
 */
export class HomeAssistantBridge {
  private access: { token: string; expiresAt: number } | null = null;
  private states: { at: number; map: Map<string, HaState> } | null = null;

  constructor(private readonly url: string, private readonly configDir: string) {}

  async status(device: VacuumDevice): Promise<{ entityId: string; status: VacuumStatus }> {
    const entities = await this.entities();
    const entity = await this.vacuumFor(device, entities);
    const states = await this.stateMap();
    const vacuum = states.get(entity.entity_id.toLowerCase());
    if (!vacuum) throw new HttpError(502, `Home Assistant has no current state for ${entity.entity_id}`);
    const related = (domain: string, needle: string) => related_(entities, entity.device_id, domain, needle);
    const stateOf = (found: RegistryEntity | null) => readText(found ? states.get(found.entity_id.toLowerCase()) : undefined);
    const battery = Number(vacuum.attributes?.battery_level);
    const batteryEntity = related("sensor", "battery_level");
    const rawCharge = stateOf(related("sensor", "charging_state")) ?? (typeof vacuum.attributes?.status === "string" ? vacuum.attributes.status : null);
    return {
      entityId: entity.entity_id,
      status: {
        state: vacuum.state,
        battery: Number.isFinite(battery) ? battery : readNumber(batteryEntity ? states.get(batteryEntity.entity_id.toLowerCase()) : undefined),
        chargeState: chargeState(vacuum.state, rawCharge),
        fanSpeed: typeof vacuum.attributes?.fan_speed === "string" ? vacuum.attributes.fan_speed : null,
        waterLevel: stateOf(related("select", "target_water_level")),
        error: stateOf(related("sensor", "fault")),
        cleanArea: stateOf(related("sensor", "clean_area")),
        cleanTime: stateOf(related("sensor", "clean_time")),
        friendlyName: typeof vacuum.attributes?.friendly_name === "string" ? vacuum.attributes.friendly_name : entity.original_name ?? entity.entity_id,
      },
    };
  }

  async act(device: VacuumDevice, action: string): Promise<{ entityId: string }> {
    const entities = await this.entities();
    const entity = await this.vacuumFor(device, entities);
    this.states = null;
    // The G1 docks reliably only through its own "start charge" button; return_to_base is a fallback.
    const dock = action === "home" ? related_(entities, entity.device_id, "button", "start_charge") : null;
    if (dock) {
      await this.api("POST", "/api/services/button/press", { entity_id: dock.entity_id });
      return { entityId: entity.entity_id };
    }
    const service = SERVICES[action];
    if (!service) throw new HttpError(400, `Unknown vacuum action "${action}"`);
    await this.api("POST", `/api/services/${service[0]}/${service[1]}`, { entity_id: entity.entity_id });
    return { entityId: entity.entity_id };
  }

  /** The vacuum entity and the companions a schedule needs: its battery sensor and its dock button. */
  async scheduleTargets(device: VacuumDevice): Promise<ScheduleTargets> {
    const entities = await this.entities();
    const entity = await this.vacuumFor(device, entities);
    return {
      vacuum: entity.entity_id.toLowerCase(),
      battery: related_(entities, entity.device_id, "sensor", "battery_level")?.entity_id.toLowerCase() ?? null,
      dock: related_(entities, entity.device_id, "button", "start_charge")?.entity_id.toLowerCase() ?? null,
    };
  }

  /** Every automation with a config id (so it can be edited) that names `entityId` exactly, read fresh. */
  async automationsFor(entityId: string): Promise<HaAutomation[]> {
    this.states = null;
    const states = [...(await this.stateMap()).values()].filter((state) => state.entity_id.startsWith("automation.") && typeof state.attributes?.id === "string");
    const configs = await mapLimited(states, CONFIG_READS_AT_ONCE, async (state) => {
      const config = await this.api("GET", `/api/config/automation/config/${encodeURIComponent(state.attributes!.id as string)}`, undefined, { missingOk: true });
      return config && typeof config === "object" ? (config as Record<string, unknown>) : null;
    });
    const mention = new RegExp(`(^|[^a-z0-9_.])${entityId.toLowerCase().replace(/\./g, "\\.")}($|[^a-z0-9_])`);
    return states
      .map((state, i) => ({ state, config: configs[i] }))
      .filter((entry): entry is { state: HaState; config: Record<string, unknown> } => entry.config !== null && mention.test(JSON.stringify(entry.config).toLowerCase()))
      .map(({ state, config }) => ({
        id: state.attributes!.id as string,
        entityId: state.entity_id,
        name: typeof state.attributes?.friendly_name === "string" ? state.attributes.friendly_name : state.entity_id,
        enabled: state.state === "on",
        lastTriggered: typeof state.attributes?.last_triggered === "string" ? state.attributes.last_triggered : null,
        config,
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  /** Creates or replaces an automation through Home Assistant's own editor API. It answers before its reload finishes. */
  async saveAutomation(id: string, config: Record<string, unknown>, createOnly = false): Promise<void> {
    if (createOnly) {
      const existing = await this.api("GET", `/api/config/automation/config/${encodeURIComponent(id)}`, undefined, { missingOk: true });
      if (existing !== null) throw new HttpError(409, `Automation ${id} already exists with custom settings; rename it in Home Assistant before adding this schedule`);
    }
    this.states = null;
    await this.api("POST", `/api/config/automation/config/${encodeURIComponent(id)}`, config);
  }

  async setAutomationEnabled(entityId: string, enabled: boolean): Promise<void> {
    this.states = null;
    await this.api("POST", `/api/services/automation/${enabled ? "turn_on" : "turn_off"}`, { entity_id: entityId });
  }

  private async vacuumFor(device: VacuumDevice, entities: RegistryEntity[]): Promise<RegistryEntity> {
    const vacuums = entities.filter((entity) => entity.entity_id?.startsWith("vacuum."));
    if (!vacuums.length) throw new HttpError(404, "Home Assistant has no vacuum entities yet; add the vacuum's integration there first");
    const wantedEntity = device.homeAssistantEntityId.toLowerCase();
    const byEntity = wantedEntity && vacuums.find((entity) => entity.entity_id.toLowerCase() === wantedEntity);
    if (byEntity) return byEntity;
    const wantedDevice = device.homeAssistantDeviceId.toLowerCase();
    const byDevice = wantedDevice && vacuums.find((entity) => entity.device_id?.toLowerCase() === wantedDevice);
    if (byDevice) return byDevice;
    const registry = await this.storage<{ devices?: { id: string; name?: string; name_by_user?: string; model?: string }[] }>("core.device_registry");
    const name = device.name.toLowerCase();
    const model = device.model.toLowerCase();
    const matching = new Set(
      (registry?.devices ?? [])
        .filter((entry) => {
          const entryName = (entry.name ?? entry.name_by_user ?? "").toLowerCase();
          const entryModel = (entry.model ?? "").toLowerCase();
          return (name && entryName.includes(name)) || (model && entryModel.includes(model));
        })
        .map((entry) => entry.id.toLowerCase()),
    );
    const byName = vacuums.find((entity) => matching.has(entity.device_id?.toLowerCase() ?? ""));
    if (byName) return byName;
    if (vacuums.length === 1) return vacuums[0]!;
    const xiaomi = vacuums.filter((entity) => entity.platform?.toLowerCase() === "xiaomi_home");
    if (xiaomi.length === 1) return xiaomi[0]!;
    throw new HttpError(409, "Home Assistant has several vacuums; set this device's Home Assistant entity id to choose one");
  }

  private async entities(): Promise<RegistryEntity[]> {
    const registry = await this.storage<{ entities?: RegistryEntity[] }>("core.entity_registry");
    return registry?.entities ?? [];
  }

  private async stateMap(): Promise<Map<string, HaState>> {
    if (this.states && Date.now() - this.states.at < STATES_CACHE_MS) return this.states.map;
    const list = (await this.api("GET", "/api/states")) as HaState[];
    const map = new Map((Array.isArray(list) ? list : []).map((state) => [String(state.entity_id).toLowerCase(), state]));
    this.states = { at: Date.now(), map };
    return map;
  }

  private async storage<T>(name: string): Promise<T | null> {
    if (!this.configDir) throw new HttpError(400, "Set Home Assistant's config folder in the Home settings first");
    try {
      return (JSON.parse(await readFile(join(this.configDir, ".storage", name), "utf8")) as { data?: T }).data ?? null;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new HttpError(404, `Home Assistant's ${name} was not found in the config folder`);
      throw new HttpError(500, `Home Assistant's ${name} could not be read: ${(error as Error).message}`);
    }
  }

  private async accessToken(force = false): Promise<string> {
    if (!force && this.access && this.access.expiresAt > Date.now() + 15_000) return this.access.token;
    const auth = await this.storage<{ users?: { id: string; is_owner?: boolean }[]; refresh_tokens?: { token?: string; user_id?: string; token_type?: string; expire_at?: number | null; last_used_at?: string | null; client_id?: string | null }[] }>("auth");
    const owners = new Set((auth?.users ?? []).filter((user) => user.is_owner).map((user) => user.id));
    const now = Date.now() / 1000;
    const refresh = (auth?.refresh_tokens ?? [])
      .filter((t) => t.token && owners.has(t.user_id ?? "") && t.token_type === "normal" && (!t.expire_at || Number(t.expire_at) > now))
      .sort((a, b) => Date.parse(b.last_used_at ?? "0") - Date.parse(a.last_used_at ?? "0"))[0];
    if (!refresh) throw new HttpError(409, "Home Assistant has no usable owner login yet; sign in to Home Assistant once in a browser");
    const body = new URLSearchParams({ grant_type: "refresh_token", client_id: refresh.client_id || `${this.url}/`, refresh_token: refresh.token! });
    const res = await this.fetchJson("/auth/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: body.toString() }, 12_000);
    const data = res.data as { access_token?: string; expires_in?: number } | null;
    if (!res.ok || !data?.access_token) throw new HttpError(502, `Home Assistant refused GGO's sign-in (HTTP ${res.status})`);
    this.access = { token: data.access_token, expiresAt: Date.now() + Number(data.expires_in ?? 1800) * 1000 };
    return this.access.token;
  }

  private async api(method: string, path: string, body?: unknown, options: { retry?: boolean; missingOk?: boolean } = {}): Promise<unknown> {
    const token = await this.accessToken();
    const res = await this.fetchJson(path, { method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) }, 15_000);
    if ((res.status === 401 || res.status === 403) && options.retry !== false) {
      this.access = null;
      return this.api(method, path, body, { ...options, retry: false });
    }
    if (res.status === 404 && options.missingOk) return null;
    const data = res.data;
    if (!res.ok) throw new HttpError(502, (data as { message?: string } | null)?.message ?? `Home Assistant answered HTTP ${res.status}`);
    return data;
  }

  private async fetchJson(path: string, init: RequestInit, timeoutMs: number): Promise<{ ok: boolean; status: number; data: unknown }> {
    const signal = AbortSignal.timeout(timeoutMs);
    try {
      const response = await fetch(`${this.url}${path}`, { ...init, signal });
      // Consume the body under the same deadline, including rejected credentials before retrying.
      // Catching json() separately used to turn an aborted body into a successful empty status read.
      const text = await response.text();
      let data: unknown = null;
      try {
        data = text ? JSON.parse(text) : null;
      } catch {
        if (response.ok) throw new HttpError(502, "Home Assistant returned an invalid JSON response");
      }
      return { ok: response.ok, status: response.status, data };
    } catch (error) {
      if (error instanceof HttpError) throw error;
      if (signal.aborted || (error as Error).name === "TimeoutError") throw new HttpError(504, `Home Assistant did not answer within ${timeoutMs / 1000}s`, { haDown: true });
      throw new HttpError(503, `Home Assistant is not running at ${this.url}`, { haDown: true });
    }
  }
}

function related_(entities: RegistryEntity[], deviceId: string | undefined, domain: string, needle: string): RegistryEntity | null {
  if (!deviceId) return null;
  return (
    entities.find(
      (entity) =>
        entity.device_id?.toLowerCase() === deviceId.toLowerCase() &&
        entity.entity_id.startsWith(`${domain}.`) &&
        [entity.entity_id, entity.original_name, entity.unique_id].join(" ").toLowerCase().includes(needle),
    ) ?? null
  );
}

function readText(state: HaState | undefined): string | null {
  const value = state?.state?.trim();
  return value ? value : null;
}

function readNumber(state: HaState | undefined): number | null {
  const value = Number(state?.state);
  return state && Number.isFinite(value) ? value : null;
}

/** The G1 reports "not charging" while docked and "charging" while cleaning; correct those two. */
function chargeState(vacuumState: string, raw: string | null): string | null {
  if (!raw) return null;
  const state = vacuumState.toLowerCase();
  const charge = raw.toLowerCase();
  if (["docked", "returning", "charging"].includes(state) && charge === "not charging") return "Charging";
  if (["cleaning", "sweeping", "mopping"].includes(state) && charge === "charging") return "Not charging";
  return raw;
}

async function mapLimited<T, R>(items: T[], limit: number, run: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await run(items[i]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}
