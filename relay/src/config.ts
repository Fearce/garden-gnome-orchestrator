import { resolve } from "node:path";

const num = (v: string | undefined, fallback: number): number => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

/**
 * Everything the relay is configured with, resolved once at boot. `JOIN_CODE` has no default on
 * purpose: a relay that started with a guessable code would be an open office, so an unset one is a
 * hard boot failure rather than a warning nobody reads.
 */
export const config = {
  port: num(process.env.PORT, 8787),
  dataDir: resolve(process.env.DATA_DIR ?? "/data"),
  joinCode: (process.env.JOIN_CODE ?? "").trim(),
  adminToken: (process.env.ADMIN_TOKEN ?? "").trim(),
  officeName: (process.env.OFFICE_NAME ?? "GG Online Office").trim(),
  /** How long an unused device token stays valid. Every connect slides it forward, so this is the
   *  "gone quiet for half a year" cut-off, not a re-login interval. */
  tokenTtlMs: num(process.env.TOKEN_TTL_DAYS, 180) * 24 * 60 * 60 * 1000,
  /** Wrong join codes tolerated from one address per hour before it is refused outright. */
  joinAttemptsPerHour: num(process.env.JOIN_ATTEMPTS_PER_HOUR, 10),
  /** How long an owner session cookie lasts before `/admin?key=…` has to be opened again. */
  adminSessionMs: num(process.env.ADMIN_SESSION_HOURS, 12) * 60 * 60 * 1000,
  /** Reverse-proxy hops in front of the relay that append to `X-Forwarded-For`. Exactly one in the
   *  documented deployment (Caddy). It is a count, not a list, because it is the only thing the address
   *  resolver needs: everything to the LEFT of that many entries was written by a caller, not a proxy. */
  trustedProxyHops: num(process.env.TRUSTED_PROXY_HOPS, 1),
};

/** Codes shipped in `.env.example` or typed as a stand-in. `deploy.sh` seeds `.env` from the example on a
 *  fresh host, so without this a first deploy would start a fully working office whose join code is a
 *  literal string in a public repository — and the length check alone waves the placeholder through. */
const PLACEHOLDER = /change[-_ ]?me|^(?:changeme|placeholder|example|password|secret|test|todo|xxx+)$/i;

const MIN_SECRET_LENGTH = 20;

function assertSecret(name: string, value: string, required: boolean): void {
  if (!value && !required) return;
  if (value.length < MIN_SECRET_LENGTH) {
    throw new Error(`${name} must be at least ${MIN_SECRET_LENGTH} characters — use a random value, not a hand-typed password.`);
  }
  if (PLACEHOLDER.test(value)) {
    throw new Error(`${name} is still a placeholder — set it to ${MIN_SECRET_LENGTH}+ random characters before starting the relay.`);
  }
}

export function assertConfigured(): void {
  assertSecret("JOIN_CODE", config.joinCode, true);
  assertSecret("ADMIN_TOKEN", config.adminToken, false);
}
