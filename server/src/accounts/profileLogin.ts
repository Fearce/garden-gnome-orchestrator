// A GGO-owned Claude sign-in per subscription, so its `user:profile` token renews itself.
//
// A pasted `claudeAiOauth.accessToken` dies within hours: Claude Code refreshes its own login and the
// provider revokes the copy. This runs the same manual-code PKCE flow `claude auth login` uses, but as
// a SEPARATE login session whose refresh token only GGO holds — refreshing it rotates nothing the
// owner's CLI depends on. Endpoints and client id match Claude Code 2.1.x.

import { createHash, randomBytes } from "node:crypto";

const CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const AUTHORIZE_URL = "https://claude.com/cai/oauth/authorize";
const TOKEN_URL = "https://platform.claude.com/v1/oauth/token";
const REDIRECT_URI = "https://platform.claude.com/oauth/code/callback";
/** Claude Code's claude.ai scope set. `user:profile` reads usage/credits; `user:sessions:claude_code`
 *  lets the same login create the cloud sessions that spend those credits. */
const SCOPES = ["org:create_api_key", "user:profile", "user:inference", "user:sessions:claude_code", "user:mcp_servers", "user:file_upload"];
const PENDING_TTL_MS = 15 * 60_000;

export interface ProfileLogin {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
}

export interface ProfileLoginPersistence {
  load(accountId: string): ProfileLogin | null;
  /** Called on sign-in, on every renewal (the refresh token may rotate) and with null when dropped. */
  save(accountId: string, login: ProfileLogin | null): void;
}

export function parseStoredProfileLogin(raw: string | null | undefined): ProfileLogin | null {
  try {
    const v = JSON.parse(raw ?? "null") as Partial<ProfileLogin> | null;
    return typeof v?.accessToken === "string" && typeof v.refreshToken === "string" && typeof v.expiresAt === "number"
      ? { accessToken: v.accessToken, refreshToken: v.refreshToken, expiresAt: v.expiresAt }
      : null;
  } catch { return null; }
}

export interface PendingProfileLogin {
  verifier: string;
  state: string;
  url: string;
  createdAt: number;
}

export type ProfileLoginExchange =
  | { ok: true; login: ProfileLogin; organizationId: string | null }
  /** `rejected`: the provider refused the grant, so retrying it cannot help. */
  | { ok: false; message: string; rejected: boolean };

export function beginProfileLogin(now = Date.now()): PendingProfileLogin {
  const verifier = randomBytes(32).toString("base64url");
  const state = randomBytes(32).toString("base64url");
  const url = new URL(AUTHORIZE_URL);
  url.searchParams.append("code", "true");
  url.searchParams.append("client_id", CLIENT_ID);
  url.searchParams.append("response_type", "code");
  url.searchParams.append("redirect_uri", REDIRECT_URI);
  url.searchParams.append("scope", SCOPES.join(" "));
  url.searchParams.append("code_challenge", createHash("sha256").update(verifier).digest("base64url"));
  url.searchParams.append("code_challenge_method", "S256");
  url.searchParams.append("state", state);
  return { verifier, state, url: url.toString(), createdAt: now };
}

export function pendingLoginLive(pending: PendingProfileLogin | undefined, now = Date.now()): pending is PendingProfileLogin {
  return !!pending && now - pending.createdAt < PENDING_TTL_MS;
}

/** The callback page shows `code#state`; accept that, the whole callback URL, or a bare code. */
export function parsePastedCode(pasted: string): { code: string; state: string | null } | null {
  const text = pasted.trim();
  if (!text) return null;
  if (/^https?:\/\//i.test(text)) {
    try {
      const url = new URL(text);
      const code = url.searchParams.get("code");
      return code ? { code, state: url.searchParams.get("state") } : null;
    } catch { return null; }
  }
  const [code, state] = text.split("#", 2);
  return code ? { code, state: state || null } : null;
}

export async function exchangeProfileLoginCode(pending: PendingProfileLogin, pasted: string): Promise<ProfileLoginExchange> {
  const parsed = parsePastedCode(pasted);
  if (!parsed) return { ok: false, message: "Paste the code Claude showed after you approved the sign-in.", rejected: true };
  if (parsed.state && parsed.state !== pending.state) return { ok: false, message: "That code belongs to a different sign-in attempt. Open the newest sign-in link and paste its code.", rejected: true };
  return tokenRequest({
    grant_type: "authorization_code", code: parsed.code, redirect_uri: REDIRECT_URI,
    client_id: CLIENT_ID, code_verifier: pending.verifier, state: pending.state,
  }, "Claude did not accept that code. Codes are single-use and expire quickly; sign in again.");
}

export async function refreshProfileLogin(refreshToken: string): Promise<ProfileLoginExchange> {
  return tokenRequest({ grant_type: "refresh_token", refresh_token: refreshToken, client_id: CLIENT_ID, scope: SCOPES.join(" ") },
    "Claude ended this sign-in. Sign in again in Settings > Subscriptions.");
}

async function tokenRequest(body: Record<string, string>, rejected: string): Promise<ProfileLoginExchange> {
  let res: Response;
  try {
    res = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", "user-agent": "claude-cli/2.0.0" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
  } catch {
    return { ok: false, message: "Could not reach Claude's sign-in service. Try again shortly.", rejected: false };
  }
  if (res.status === 400 || res.status === 401 || res.status === 403) return { ok: false, message: rejected, rejected: true };
  if (!res.ok) return { ok: false, message: `Claude's sign-in service answered HTTP ${res.status}. Try again shortly.`, rejected: false };
  const data = await res.json().catch(() => null) as {
    access_token?: unknown; refresh_token?: unknown; expires_in?: unknown; scope?: unknown; organization?: { uuid?: unknown };
  } | null;
  if (typeof data?.access_token !== "string" || typeof data.expires_in !== "number" || !Number.isFinite(data.expires_in)) {
    return { ok: false, message: "Claude's sign-in service returned an unreadable answer.", rejected: false };
  }
  if (typeof data.scope === "string" && !data.scope.split(" ").includes("user:profile")) {
    return { ok: false, message: "Claude granted this sign-in without the user:profile scope, so it cannot read credits.", rejected: true };
  }
  // Refresh responses may omit a rotated token; the current one then stays valid.
  const refreshToken = typeof data.refresh_token === "string" ? data.refresh_token : body.refresh_token;
  if (!refreshToken) return { ok: false, message: "Claude's sign-in service returned no refresh token.", rejected: true };
  const org = data.organization?.uuid;
  return {
    ok: true,
    login: { accessToken: data.access_token, refreshToken, expiresAt: Date.now() + data.expires_in * 1000 },
    organizationId: typeof org === "string" && org.trim() ? org.trim() : null,
  };
}
