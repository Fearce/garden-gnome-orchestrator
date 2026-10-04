// The optional local-service tabs talk to their worker processes through GGO's authenticated
// /api/modules proxy. Nothing here caches personal data: camera addresses, tokens and paths stay on the
// server, and the server masks passwords before they reach this page.

import { apiUrl } from "../../lib/base.js";
import type { ModuleView } from "../../types.js";

export type ServiceState = "stopped" | "starting" | "running" | "unresponsive";

export interface ServiceStatus {
  module: ModuleView;
  state: ServiceState;
  pid: number | null;
  startedAt: number | null;
  stale: boolean;
  busy: string | null;
  armed: string | null;
  rssBytes: number | null;
  lastError: string | null;
}

export class ModuleRequestError extends Error {
  constructor(message: string, public readonly status: number, public readonly body: Record<string, unknown>) {
    super(message);
  }

  /** The service behind the module (Script Hub, Home Assistant) is down, not the module itself. */
  get upstreamDown(): boolean {
    return this.body.hubDown === true || this.body.haDown === true;
  }
}

async function readJson<T>(res: Response): Promise<T> {
  const text = await res.text();
  let body: Record<string, unknown> = {};
  try {
    body = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch {
    body = { error: text.slice(0, 300) || `HTTP ${res.status}` };
  }
  if (!res.ok) throw new ModuleRequestError(typeof body.error === "string" ? body.error : `HTTP ${res.status}`, res.status, body);
  return body as T;
}

/** A call into a module's own API. JSON bodies only; the worker answers JSON or an image. */
export async function moduleJson<T>(id: ModuleView, path: string, init: { method?: string; body?: unknown; signal?: AbortSignal } = {}): Promise<T> {
  const res = await fetch(apiUrl(`/api/modules/${id}/api${path}`), {
    method: init.method ?? "GET",
    headers: init.body === undefined ? undefined : { "content-type": "application/json" },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
    signal: init.signal,
    credentials: "same-origin",
  });
  return readJson<T>(res);
}

export function moduleUrl(id: ModuleView, path: string): string {
  return apiUrl(`/api/modules/${id}/api${path}`);
}

export async function fetchServiceStatus(id: ModuleView, signal?: AbortSignal): Promise<ServiceStatus> {
  return readJson<ServiceStatus>(await fetch(apiUrl(`/api/modules/${id}/service`), { signal, credentials: "same-origin" }));
}

export async function serviceAction(id: ModuleView, action: "start" | "stop" | "restart", force = false): Promise<ServiceStatus> {
  const res = await fetch(apiUrl(`/api/modules/${id}/service/${action}`), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ force }),
    credentials: "same-origin",
  });
  return readJson<ServiceStatus>(res);
}

/** A one-time pass for the module's WebSocket; a cookie alone does not open one. */
export async function streamUrl(id: ModuleView): Promise<string> {
  const res = await fetch(apiUrl(`/api/modules/${id}/ticket`), { method: "POST", headers: { "content-type": "application/json" }, body: "{}", credentials: "same-origin" });
  const { ticket } = await readJson<{ ticket: string }>(res);
  const base = new URL(apiUrl(`/api/modules/${id}/stream`), location.href);
  base.protocol = location.protocol === "https:" ? "wss:" : "ws:";
  base.searchParams.set("ticket", ticket);
  return base.toString();
}

export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function formatBytes(bytes: number | null): string {
  if (bytes == null) return "—";
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  if (bytes < 1024 ** 3) return `${Math.round(bytes / (1024 * 1024))} MB`;
  const gb = bytes / 1024 ** 3;
  return `${gb < 10 ? gb.toFixed(1) : Math.round(gb)} GB`;
}

export function formatAgo(at: number | string | null, now = Date.now()): string {
  if (at == null) return "never";
  const ms = now - (typeof at === "string" ? Date.parse(at) : at);
  if (!Number.isFinite(ms)) return "unknown";
  if (ms < 5_000) return "just now";
  if (ms < 60_000) return `${Math.round(ms / 1000)}s ago`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)} min ago`;
  return `${Math.round(ms / 3_600_000)} h ago`;
}
