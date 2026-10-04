import { HttpError } from "./router.js";

/** A call to the Script Hub service (the process supervisor that keeps running outside GGO). */
export async function hubJson<T>(hubUrl: string, path: string, init: RequestInit & { timeoutMs?: number } = {}): Promise<T> {
  const timeoutMs = init.timeoutMs ?? 15_000;
  const signal = init.signal ?? AbortSignal.timeout(timeoutMs);
  const res = await hubFetch(hubUrl, path, { ...init, signal });
  let text: string;
  try {
    // Headers alone are not an answer: consume the body under the same deadline, and report a
    // stalled or broken read as upstream unavailability rather than an internal module error.
    text = await res.text();
  } catch (error) {
    throw hubReadError(error, timeoutMs, signal);
  }
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
  const signal = rest.signal ?? AbortSignal.timeout(timeoutMs);
  try {
    return await fetch(`${hubUrl}${path}`, {
      ...rest,
      headers: rest.body ? { "content-type": "application/json", ...(rest.headers as Record<string, string> | undefined) } : rest.headers,
      signal,
    });
  } catch (error) {
    throw hubReadError(error, timeoutMs, signal);
  }
}

function hubReadError(error: unknown, timeoutMs: number, signal: AbortSignal): unknown {
  const name = (error as Error).name;
  if (name === "TimeoutError" || (signal.aborted && signal.reason?.name === "TimeoutError")) {
    return new HttpError(504, `Script Hub did not answer within ${Math.round(timeoutMs / 1000)}s`, { hubDown: true });
  }
  // A viewer leaving a stream is a cancellation, not evidence that the shared service failed.
  if (signal.aborted || name === "AbortError") return error;
  return new HttpError(503, "Script Hub stopped answering, so this panel cannot reach it", { hubDown: true, ...(wasRefused(error) ? { hubAbsent: true } : {}) });
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
