import { createHmac, timingSafeEqual } from "node:crypto";
import { config } from "./config.js";

export const AUTH_COOKIE = "orch_auth"; // legacy shared-token mode
export const SESSION_COOKIE = "orch_session"; // google mode (signed email session)
export const OAUTH_STATE_COOKIE = "orch_oauth"; // short-lived per-browser CSRF nonce

export type AuthMode = "none" | "token" | "google";

export function authMode(): AuthMode {
  if (config.googleClientId && config.googleClientSecret) return "google";
  if (config.authToken) return "token";
  return "none";
}

export function cookieValue(cookieHeader: string | undefined, name: string): string | undefined {
  if (!cookieHeader) return undefined;
  for (const part of cookieHeader.split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    if (part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return undefined;
}

function sign(data: string): string {
  return createHmac("sha256", config.sessionSecret).update(data).digest("base64url");
}
function safeEq(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

/** Mint a signed session cookie value for an allowed email. Payload is `email|exp`;
 *  email addresses never contain "|", so lastIndexOf("|") splits it back unambiguously. */
export function makeSession(email: string, ttlMs = 30 * 24 * 3600 * 1000): string {
  const payload = `${email}|${Date.now() + ttlMs}`;
  return `${Buffer.from(payload).toString("base64url")}.${sign(payload)}`;
}
function sessionEmail(cookie: string | undefined): string | null {
  if (!cookie) return null;
  const dot = cookie.lastIndexOf(".");
  if (dot < 0) return null;
  const b64 = cookie.slice(0, dot);
  const sig = cookie.slice(dot + 1);
  const payload = Buffer.from(b64, "base64url").toString();
  if (!safeEq(sign(payload), sig)) return null;
  const bar = payload.lastIndexOf("|");
  if (bar < 0) return null;
  const email = payload.slice(0, bar);
  const exp = Number(payload.slice(bar + 1));
  if (!email || !Number.isFinite(exp) || Date.now() > exp) return null;
  return email;
}

/** True when auth is disabled, or the request carries valid credentials for the active mode. */
export function isAuthed(cookieHeader: string | undefined): boolean {
  const mode = authMode();
  if (mode === "none") return true;
  if (mode === "token") {
    const v = cookieValue(cookieHeader, AUTH_COOKIE);
    return !!v && !!config.authToken && safeEq(v, config.authToken);
  }
  const email = sessionEmail(cookieValue(cookieHeader, SESSION_COOKIE));
  return !!email && email.toLowerCase() === config.allowedEmail;
}

// ---- Google OAuth (OIDC code flow) ----

export function googleAuthUrl(redirectUri: string, state: string, prompt?: string): string {
  const p = new URLSearchParams({
    client_id: config.googleClientId ?? "",
    redirect_uri: redirectUri,
    response_type: "code",
    scope: "openid email",
    state,
    access_type: "online",
  });
  // prompt omitted → Google skips the consent screen when already signed in + granted
  // (the "skip-if-logged-in" path). "select_account" forces the account picker.
  if (prompt) p.set("prompt", prompt);
  return `https://accounts.google.com/o/oauth2/v2/auth?${p.toString()}`;
}

export function signState(nonce: string): string {
  return `${nonce}.${sign(nonce)}`;
}
export function verifyState(state: string | undefined): boolean {
  if (!state) return false;
  const dot = state.lastIndexOf(".");
  if (dot < 0) return false;
  return safeEq(sign(state.slice(0, dot)), state.slice(dot + 1));
}

/** Verify the state's signature AND that its nonce matches the per-browser cookie (CSRF binding). */
export function checkState(state: string | undefined, cookieNonce: string | undefined): boolean {
  if (!state || !cookieNonce || !verifyState(state)) return false;
  return safeEq(state.slice(0, state.lastIndexOf(".")), cookieNonce);
}

/** Exchange an auth code for the user's verified email (decodes the trusted id_token). */
export async function exchangeCodeForEmail(code: string, redirectUri: string): Promise<string | null> {
  try {
    const res = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: config.googleClientId ?? "",
        client_secret: config.googleClientSecret ?? "",
        redirect_uri: redirectUri,
        grant_type: "authorization_code",
      }),
    });
    if (!res.ok) return null;
    const j = (await res.json()) as { id_token?: string };
    if (!j.id_token) return null;
    // Trust derives from this direct server→Google TLS exchange (client_secret proves the RP),
    // so we decode the id_token without re-verifying its RS256 signature (Google sanctions this
    // for the code-exchange path). Do NOT reuse this decode for a browser-supplied token.
    const payloadB64 = j.id_token.split(".")[1];
    if (!payloadB64) return null;
    const claims = JSON.parse(Buffer.from(payloadB64, "base64url").toString()) as {
      email?: string;
      email_verified?: boolean;
      aud?: string;
    };
    if (claims.aud !== config.googleClientId) return null; // token minted for our client
    if (!claims.email || claims.email_verified === false) return null;
    return claims.email;
  } catch {
    return null;
  }
}
