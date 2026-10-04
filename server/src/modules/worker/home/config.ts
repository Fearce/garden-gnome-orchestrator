import { randomBytes } from "node:crypto";
import { HttpError } from "../router.js";

export type Bridge = "auto" | "home-assistant" | "xiaomi-miio";
export const VACUUM_MODELS = ["xiaomi-g1", "mijia.vacuum.v2"] as const;

export interface VacuumDevice {
  id: string;
  name: string;
  platform: Bridge;
  model: string;
  host: string;
  /** The vacuum's 32-character miIO token, for local control without Home Assistant. */
  token: string;
  homeAssistantEntityId: string;
  homeAssistantDeviceId: string;
  refreshMs: number;
  location: string;
  statusNote: string;
}

export interface HomeConfig {
  homeAssistant: {
    url: string;
    /** Home Assistant's config folder; its `.storage` holds the owner login GGO reuses and the entity registry. */
    configDir: string;
  };
  /** Python with python-miio installed, for local vacuum control. */
  pythonPath: string;
  devices: VacuumDevice[];
}

export const SECRET_MASK = "********";

export function emptyHomeConfig(): HomeConfig {
  return { homeAssistant: { url: "http://127.0.0.1:8123", configDir: "" }, pythonPath: "python", devices: [] };
}

export function newDevice(): VacuumDevice {
  return normalizeDevice({ name: "Robot vacuum", platform: "auto", model: "xiaomi-g1", refreshMs: 10_000 });
}

export function normalizeDevice(raw: unknown): VacuumDevice {
  const input = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const platform = input.platform === "home-assistant" || input.platform === "xiaomi-miio" ? input.platform : "auto";
  const refresh = Math.round(Number(input.refreshMs));
  return {
    id: text(input.id, 80) || `vac-${randomBytes(5).toString("hex")}`,
    name: text(input.name, 120) || "Unnamed device",
    platform,
    model: text(input.model, 80) || "xiaomi-g1",
    host: text(input.host, 255),
    token: text(input.token, 128),
    homeAssistantEntityId: text(input.homeAssistantEntityId, 255),
    homeAssistantDeviceId: text(input.homeAssistantDeviceId, 255),
    // 0 turns automatic refresh off; otherwise no faster than every 2 s.
    refreshMs: Number.isFinite(refresh) && refresh > 0 ? Math.max(2_000, Math.min(600_000, refresh)) : 0,
    location: text(input.location, 120),
    statusNote: typeof input.statusNote === "string" ? input.statusNote.slice(0, 4000) : "",
  };
}

export function normalizeHomeConfig(raw: unknown): HomeConfig {
  const input = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const ha = (input.homeAssistant && typeof input.homeAssistant === "object" ? input.homeAssistant : {}) as Record<string, unknown>;
  const url = text(ha.url, 512) || "http://127.0.0.1:8123";
  if (!/^https?:\/\//i.test(url)) throw new HttpError(400, "The Home Assistant address must start with http:// or https://");
  return {
    homeAssistant: { url: url.replace(/\/+$/, ""), configDir: text(ha.configDir, 1024) },
    pythonPath: text(input.pythonPath, 1024) || "python",
    devices: Array.isArray(input.devices) ? input.devices.map(normalizeDevice) : [],
  };
}

/** Which bridge a device uses: an explicit choice, else local miIO when it has a token, else Home Assistant. */
export function bridgeFor(device: VacuumDevice): "home-assistant" | "xiaomi-miio" {
  if (device.platform === "home-assistant") return "home-assistant";
  if (device.platform === "xiaomi-miio") return "xiaomi-miio";
  return device.token ? "xiaomi-miio" : "home-assistant";
}

export function maskDevice(device: VacuumDevice): VacuumDevice & { tokenSet: boolean } {
  return { ...device, token: device.token ? SECRET_MASK : "", tokenSet: Boolean(device.token), statusNote: device.token ? device.statusNote.split(device.token).join(SECRET_MASK) : device.statusNote };
}

export function restoreDeviceSecrets(incoming: VacuumDevice, stored: VacuumDevice | undefined): VacuumDevice {
  const restored = { ...incoming };
  if (incoming.token === SECRET_MASK) {
    if (!stored) throw new HttpError(400, `${incoming.name}: enter the miIO token again`);
    restored.token = stored.token;
  }
  if (incoming.statusNote.includes(SECRET_MASK)) {
    const hiddenCount = stored?.token ? stored.statusNote.split(stored.token).length - 1 : 0;
    if (incoming.statusNote.split(SECRET_MASK).length - 1 !== hiddenCount) throw new HttpError(400, `${incoming.name}: enter the token in the notes in full when changing masked entries`);
    restored.statusNote = incoming.statusNote.split(SECRET_MASK).join(stored!.token);
  }
  return restored;
}

function text(value: unknown, max: number): string {
  return typeof value === "string" ? value.trim().slice(0, max) : typeof value === "number" ? String(value) : "";
}
