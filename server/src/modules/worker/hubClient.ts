import { HttpError } from "./router.js";

/** A call to the Script Hub service (the process supervisor that keeps running outside GGO). */
export async function hubJson<T>(hubUrl: string, path: string, init: RequestInit & { timeoutMs?: number } = {}): Promise<T> {
  const res = await hubFetch(hubUrl, path, init);
  const text = await res.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    throw new HttpError(502, `Script Hub answered ${path} with something other than JSON`);
  }
  if (!res.ok) {
    const message = (body as { error?: string } | null)?.error || `Script Hub answered ${res.status}`;
    throw new HttpError(res.status >= 500 ? 502 : res.status, message);
  }
  return body as T;
}

export async function hubFetch(hubUrl: string, path: string, init: RequestInit & { timeoutMs?: number } = {}): Promise<Response> {
  const { timeoutMs = 15_000, ...rest } = init;
  try {
    return await fetch(`${hubUrl}${path}`, {
      ...rest,
      headers: rest.body ? { "content-type": "application/json", ...(rest.headers as Record<string, string> | undefined) } : rest.headers,
      signal: rest.signal ?? AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    const name = (error as Error).name;
    if (name === "TimeoutError") throw new HttpError(504, `Script Hub did not answer within ${Math.round(timeoutMs / 1000)}s`, { hubDown: true });
    if (name === "AbortError") throw error;
    throw new HttpError(503, "Script Hub is not running, so this panel cannot reach it", { hubDown: true, ...(wasRefused(error) ? { hubAbsent: true } : {}) });
  }
}

/** Nothing listens at the hub's address (as opposed to a hub that is slow or failing). */
function wasRefused(error: unknown): boolean {
  const cause = (error as { cause?: { code?: unknown; errors?: { code?: unknown }[] } }).cause;
  if (cause?.code === "ECONNREFUSED") return true;
  return Array.isArray(cause?.errors) && cause.errors.length > 0 && cause.errors.every((inner) => inner.code === "ECONNREFUSED");
}

/** One section of the hub's own settings file, where the Dashboard Deck kept these modules' config. Null
 *  when the section is empty; throws when the hub cannot be reached. */
export async function readHubSettings<T>(hubUrl: string, section: string): Promise<T | null> {
  try {
    const body = await hubJson<{ value?: T }>(hubUrl, `/api/settings/${encodeURIComponent(section)}`, { timeoutMs: 8_000 });
    return body?.value ?? null;
  } catch (error) {
    if (error instanceof HttpError && error.status === 404) return null;
    throw error;
  }
}
