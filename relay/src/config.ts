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
};

export function assertConfigured(): void {
  if (config.joinCode.length < 8) {
    throw new Error("JOIN_CODE must be set to at least 8 characters — refusing to run an office anyone can walk into.");
  }
}
