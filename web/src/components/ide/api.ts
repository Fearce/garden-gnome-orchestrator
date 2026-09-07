import { apiUrl } from "../../lib/base.js";
import { RequestCache } from "./cache.js";
export interface Workspace { id: string; path: string; name: string; tasks: { id: string; title: string }[] }
export interface FileData { path: string; text: string; version: string }
export interface Entry { path: string; name: string; directory: boolean }
export interface SearchHit { path: string; line?: number; preview?: string }
export class ApiError extends Error { constructor(message: string, public status: number) { super(message); } }
const cache = new RequestCache();
const keyOf = (route: string, params: Record<string, string>) => `${route}?${new URLSearchParams(Object.entries(params).sort(([a], [b]) => a.localeCompare(b)))}`;
export const cachedIde = <T,>(route: string, params: Record<string, string>): T | undefined => cache.peek<T>(keyOf(route, params));
export const invalidateIde = (workspace?: string) => cache.invalidate(key => !workspace || new URLSearchParams(key.split("?")[1]).get("workspace") === workspace);

// Git mutations can alter files, directory structure, search results and both sides of a diff.
window.addEventListener("ggo:repo-changed", () => invalidateIde());
window.addEventListener("ggo:auth-lost", () => invalidateIde());

export async function ideApi<T>(route: string, params: Record<string, string> = {}, body?: unknown, signal?: AbortSignal, fresh = false): Promise<T> {
  signal?.throwIfAborted();
  const load = async (): Promise<T> => {
  const result = await fetch(apiUrl(`/api/ide/${route}`) + (Object.keys(params).length ? `?${new URLSearchParams(params)}` : ""), {
    credentials: "same-origin",
    ...(body === undefined ? {} : { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
  });
  const data = await result.json();
  if (!result.ok) {
    if ([401, 403].includes(result.status)) invalidateIde();
    throw new ApiError(data.error ?? `Request failed (${result.status}).`, result.status);
  }
  return data as T;
  };
  // Requests are shared. A component leaving cancels its consumption, not other readers.
  const data = body === undefined ? await cache.read(keyOf(route, params), load, route === "repo" ? 60_000 : 30_000, fresh) : await load();
  if (body !== undefined) invalidateIde();
  signal?.throwIfAborted();
  return data;
}
