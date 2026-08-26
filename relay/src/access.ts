import { randomBytes, timingSafeEqual } from "node:crypto";

/**
 * The relay's HTTP edge: who is asking, may they keep asking, and are they still the owner.
 *
 * All three answers are decided from client-supplied bytes, so they live here as small pure units the
 * gate can drive directly — `index.ts` keeps only the wiring. Nothing in this file reads the clock or
 * the network except through an injected `now`.
 */

/** Loopback, RFC1918, CGNAT and IPv6 unique-local — the addresses a reverse proxy on the same host or
 *  docker network can have. A request from anything else reached the relay directly. */
const PRIVATE_PEER =
  /^(?:::1|127\.|10\.|192\.168\.|169\.254\.|172\.(?:1[6-9]|2\d|3[01])\.|100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.|f[cd][0-9a-f]{2}:)/i;

/** Textual IPv4/IPv6, as an `X-Forwarded-For` entry is allowed to be. Anything else is a client typing
 *  into the header, and is discarded rather than used as a rate-limit key. */
const IP_TEXT = /^[0-9a-f.:]{3,45}$/i;

/** `::ffff:1.2.3.4` and `1.2.3.4:5678` are the same client as `1.2.3.4`; bucketing them apart would hand
 *  an attacker three budgets for one address. */
export function normalizeIp(raw: string): string {
  let v = raw.trim().toLowerCase();
  if (v.startsWith("[")) v = v.slice(1, v.indexOf("]") > 0 ? v.indexOf("]") : undefined);
  if (v.startsWith("::ffff:") && v.includes(".")) v = v.slice(7);
  // A port only ever follows an IPv4 literal here — a bare IPv6 has colons of its own and no brackets.
  const colon = v.indexOf(":");
  if (colon > 0 && v.indexOf(":", colon + 1) === -1 && v.includes(".")) v = v.slice(0, colon);
  return v.slice(0, 45);
}

/**
 * The address to hold accountable for a request.
 *
 * `X-Forwarded-For` is client-supplied — a proxy that APPENDS (nginx, Cloudflare, Caddy with
 * `trusted_proxies` set) leaves whatever the caller sent in front of the real address, so reading the
 * FIRST entry lets anyone mint a fresh rate-limit bucket per request. The relay's only brute-force
 * defence must not depend on a proxy default configured in someone else's repository, so:
 *
 *   - the header is honoured only when the socket peer is itself private (i.e. the reverse proxy on the
 *     shared docker network); a direct caller is judged by the address it actually connected from, and
 *   - the entry is counted `hops` from the RIGHT, because only the trailing entries were written by a
 *     proxy we trust. With the relay's real topology (one Caddy hop) that is the true client.
 *
 * More trusted hops than the header has entries falls back to the leftmost entry, and an entry that
 * isn't IP-shaped falls back to the socket address — a bogus one would only pollute the throttle's keys.
 */
export function clientIp(socketAddr: string | undefined, forwarded: string | string[] | undefined, hops: number): string {
  const peer = normalizeIp(socketAddr ?? "") || "unknown";
  if (!PRIVATE_PEER.test(peer)) return peer;
  const header = Array.isArray(forwarded) ? forwarded.join(",") : (forwarded ?? "");
  const parts = header
    .split(",")
    .map((p) => normalizeIp(p))
    .filter(Boolean);
  if (!parts.length) return peer;
  const picked = parts[Math.max(0, parts.length - Math.max(1, hops))]!;
  return IP_TEXT.test(picked) ? picked : peer;
}

/**
 * Wrong join codes, counted per address over a rolling hour.
 *
 * The `Map` is swept on every write and hard-capped: it is the only structure in the process an
 * unauthenticated caller can grow, and pruning it lazily (only when the same key recurs) leaves an entry
 * per address forever. Eviction is a MEMORY bound, not a security one — an attacker who can source from
 * enough distinct addresses to trigger it already has more budget than the cap denies them, and the join
 * code's own entropy is what makes that irrelevant.
 */
export class JoinThrottle {
  private readonly hits = new Map<string, number[]>();

  constructor(
    private readonly perHour: number,
    private readonly maxKeys = 4096,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /** True when this address has burned through its hourly allowance of wrong join codes. */
  limited(ip: string): boolean {
    return this.recent(ip).length >= this.perHour;
  }

  record(ip: string): void {
    this.hits.set(ip, [...this.recent(ip), this.now()]);
    this.sweep();
  }

  /** Live key count — the gate asserts this stays bounded under a flood of distinct addresses. */
  size(): number {
    return this.hits.size;
  }

  private recent(ip: string): number[] {
    const cutoff = this.now() - 3600_000;
    return (this.hits.get(ip) ?? []).filter((t) => t > cutoff);
  }

  private sweep(): void {
    const cutoff = this.now() - 3600_000;
    for (const [ip, times] of this.hits) {
      const live = times.filter((t) => t > cutoff);
      if (live.length) this.hits.set(ip, live);
      else this.hits.delete(ip);
    }
    if (this.hits.size <= this.maxKeys) return;
    const coldestFirst = [...this.hits.entries()].sort((a, b) => (a[1].at(-1) ?? 0) - (b[1].at(-1) ?? 0));
    for (const [ip] of coldestFirst.slice(0, this.hits.size - this.maxKeys)) this.hits.delete(ip);
  }
}

/**
 * Short-lived owner sessions, so the admin key stops travelling in the URL.
 *
 * `/admin?key=…` is the surface the owner opens on a phone, and it is the one credential the relay hands
 * to Caddy's access log, the browser's address bar and its history on EVERY visit. Exchanging it once for
 * a cookie and redirecting to the bare path keeps that convenience while reducing the exposure to the
 * single request that carried it. Sessions live in memory on purpose: a relay restart logging the owner
 * out costs one re-open of the bookmark they already have.
 */
export class AdminSessions {
  private readonly live = new Map<string, number>();

  constructor(
    private readonly ttlMs: number,
    private readonly max = 32,
    private readonly now: () => number = () => Date.now(),
  ) {}

  mint(): string {
    this.sweep();
    const id = randomBytes(24).toString("base64url");
    this.live.set(id, this.now() + this.ttlMs);
    return id;
  }

  valid(id: string): boolean {
    if (!id) return false;
    const until = this.live.get(id);
    if (!until) return false;
    if (until <= this.now()) {
      this.live.delete(id);
      return false;
    }
    return true;
  }

  size(): number {
    this.sweep();
    return this.live.size;
  }

  private sweep(): void {
    for (const [id, until] of this.live) if (until <= this.now()) this.live.delete(id);
    if (this.live.size < this.max) return;
    const soonestFirst = [...this.live.entries()].sort((a, b) => a[1] - b[1]);
    for (const [id] of soonestFirst.slice(0, this.live.size - this.max + 1)) this.live.delete(id);
  }
}

export const ADMIN_COOKIE = "gg_office_admin";

/** One cookie's value out of a `Cookie` header, without pulling in a parser for a single read. */
export function cookieValue(header: string | undefined, name: string): string {
  for (const part of (header ?? "").split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() !== name) continue;
    return decodeURIComponent(part.slice(eq + 1).trim());
  }
  return "";
}

/** Compare two secrets without leaking their length or a prefix match through timing. */
export function secretEquals(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && x.length > 0 && timingSafeEqual(x, y);
}

/**
 * Headers every relay response carries.
 *
 * Caddy already adds most of these, but the relay must not depend on a reverse proxy configured in
 * another repository for its own hardening — the same reasoning that made `clientIp` stop trusting
 * `X-Forwarded-For`. The pages are server-rendered with one inline `<style>` and no script, no image and
 * no form, so the policy can deny literally everything else.
 */
export const SECURITY_HEADERS: Record<string, string> = {
  "content-security-policy":
    "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "referrer-policy": "no-referrer",
  "cache-control": "no-store",
};

/** Strip control characters from anything that reaches a log line or a rendered name. A newline inside
 *  an instance name would otherwise let a joining client forge entries in the container log. */
export function sanitizeName(raw: string, max = 40): string {
  return raw
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}
