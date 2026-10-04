import http from "node:http";
import type { Camera } from "./config.js";

interface ReolinkReply {
  code?: number;
  value?: Record<string, unknown> & { Token?: { name?: string; leaseTime?: number } };
  error?: { detail?: string; rspCode?: number };
}

export interface PrivacyResult {
  push: { ok: boolean; detail: string | null };
  email: { ok: boolean; detail: string | null };
}

class RetryableError extends Error {}

export function isReolink(camera: Pick<Camera, "vendor" | "modelPreset">): boolean {
  return /reolink/i.test(camera.vendor) || /reolink/i.test(camera.modelPreset);
}

/**
 * Reolink's CGI JSON API, used for "privacy mode": turning the camera's push and e-mail alerts off while
 * someone is home. Logins are cached for their lease; a busy camera's 502s are retried with backoff.
 */
export class ReolinkClient {
  private readonly tokens = new Map<string, { token: string; expiresAt: number }>();

  async setPrivacy(camera: Camera, enabled: boolean): Promise<PrivacyResult> {
    const wanted = enabled ? 0 : 1;
    return {
      push: await this.toggle(camera, "GetPushV20", "SetPushV20", "Push", wanted),
      email: await this.toggle(camera, "GetEmailV20", "SetEmailV20", "Email", wanted),
    };
  }

  private async toggle(camera: Camera, getCmd: string, setCmd: string, field: string, wanted: number): Promise<{ ok: boolean; detail: string | null }> {
    try {
      const current = await this.command(camera, getCmd, { channel: 0 });
      const settings = current?.code === 0 ? (current.value?.[field] as Record<string, unknown> | undefined) : undefined;
      if (!settings) return { ok: false, detail: current?.error?.detail ?? `no ${field} settings returned` };
      if (Number(settings.enable) === wanted) return { ok: true, detail: "already in the wanted state" };
      const reply = await this.command(camera, setCmd, { [field]: { ...settings, enable: wanted } });
      return { ok: reply?.code === 0, detail: reply?.error?.detail ?? null };
    } catch (error) {
      return { ok: false, detail: (error as Error).message };
    }
  }

  private async command(camera: Camera, cmd: string, param: Record<string, unknown>): Promise<ReolinkReply | undefined> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const token = await this.login(camera);
      const reply = (await this.callWithRetry(camera, `cmd=${cmd}&token=${token}`, [{ cmd, action: 0, param }]))[0];
      const expired = reply?.error?.rspCode === -6 || (reply?.code === 1 && /login/i.test(reply?.error?.detail ?? ""));
      if (expired && attempt === 0) {
        this.tokens.delete(tokenKey(camera));
        continue;
      }
      return reply;
    }
    throw new Error(`${cmd} kept failing to log in`);
  }

  private async login(camera: Camera): Promise<string> {
    const cached = this.tokens.get(tokenKey(camera));
    if (cached && cached.expiresAt > Date.now() + 60_000) return cached.token;
    const reply = (await this.callWithRetry(camera, "cmd=Login", [
      { cmd: "Login", param: { User: { Version: "0", userName: camera.username || "admin", password: camera.password } } },
    ]))[0];
    if (!reply || reply.code !== 0) throw new Error(`the camera refused the login: ${reply?.error?.detail ?? "unknown reason"}`);
    const token = reply.value?.Token?.name;
    if (!token) throw new Error("the camera's login returned no token");
    this.tokens.set(tokenKey(camera), { token, expiresAt: Date.now() + Number(reply.value?.Token?.leaseTime ?? 3600) * 1000 });
    return token;
  }

  private async callWithRetry(camera: Camera, query: string, body: unknown, attempts = 4): Promise<ReolinkReply[]> {
    let last: Error = new Error("no attempt made");
    for (let i = 0; i < attempts; i += 1) {
      try {
        return await post(camera, query, body);
      } catch (error) {
        last = error as Error;
        if (!(error instanceof RetryableError) || i === attempts - 1) break;
        await new Promise((resolve) => setTimeout(resolve, 1_200 * (i + 1)));
      }
    }
    throw last;
  }
}

function tokenKey(camera: Camera): string {
  return `${camera.host}:${camera.port}`;
}

function post(camera: Camera, query: string, body: unknown): Promise<ReolinkReply[]> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const request = http.request(
      { host: camera.host, port: camera.port || 80, method: "POST", path: `/cgi-bin/api.cgi?${query}`, headers: { "content-type": "application/json", "content-length": Buffer.byteLength(payload) }, timeout: 12_000 },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () => {
          const status = response.statusCode ?? 0;
          if (status === 502 || status === 503 || status === 504) return reject(new RetryableError(`the camera answered HTTP ${status}`));
          try {
            const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
            resolve(Array.isArray(parsed) ? (parsed as ReolinkReply[]) : []);
          } catch {
            reject(new Error("the camera's reply was not JSON"));
          }
        });
      },
    );
    request.on("error", (error) => reject(new RetryableError(error.message)));
    request.on("timeout", () => request.destroy(new RetryableError("the camera did not answer within 12s")));
    request.end(payload);
  });
}
