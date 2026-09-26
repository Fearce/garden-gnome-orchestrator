// "Banked resets" — a limit reset a provider has GRANTED but not yet spent.
//
// Both subscriptions hand these out (Anthropic calls the programme cedar-ember and spends one with
// `/limit-reset`; OpenAI calls them rate-limit reset credits), and until now the only way to notice
// one was to open the native Claude Code or ChatGPT app. A banked reset is the difference between a
// capped account being stuck for six hours and being usable right now, so it belongs beside the
// meters GGO already shows.
//
// The two providers report it in completely different shapes, so this module owns the one shape the
// console reads and each provider's parser converts INTO it. That keeps the wire quirks (epoch
// seconds vs. milliseconds, a count vs. a list of grants, a grant that is granted-but-not-yet-usable)
// in one place instead of spread across two runners and a React component.

/** One subscription's banked-reset standing, as the console renders it. */
export interface ResetCreditsDTO {
  /** Resets available to spend RIGHT NOW. This is the number the owner asked to see. */
  available: number;
  /** Granted but not spendable yet — paused, or not the next grant in line. Shown as context, never
   *  added to `available`: telling the owner they have a reset they cannot use is worse than silence. */
  pending: number;
  /** Epoch ms the soonest AVAILABLE credit expires, or null when the provider did not say. */
  expiresAt: number | null;
  /** The provider's own name for it ("Full reset"), for the hover text. Never invented here. */
  title: string | null;
  /** Epoch ms this reading was taken, so a consumer can judge staleness the way it does for meters. */
  readAt: number;
  /** The provider's id for the credit a redeem spends next: Claude's grant id (required by its claim
   *  call), Codex's credit id (optional there, the backend picks the next one without it). Null when
   *  nothing is available or the provider did not name one. */
  redeemId: string | null;
}

/** Nothing banked — distinct from "we could not read", which is `null` at every call site. */
export function noResetCredits(readAt: number): ResetCreditsDTO {
  return { available: 0, pending: 0, expiresAt: null, title: null, readAt, redeemId: null };
}

/** Both providers' ids are short opaque tokens; anything else is not sent back to them. */
const REDEEM_ID = /^[A-Za-z0-9_-]{1,80}$/;
function redeemIdOf(value: unknown): string | null {
  return typeof value === "string" && REDEEM_ID.test(value) ? value : null;
}

function positiveInt(value: unknown): number {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : 0;
}

/** Epoch SECONDS as both providers send them, to epoch ms. Rejects 0/NaN/negative rather than
 *  producing 1970, which would render as an expiry long past and hide a live credit. */
function epochSecondsToMs(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return null;
  return Math.round(value * 1000);
}

function trimmedTitle(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, 80) : null;
}

// ---- OpenAI Codex ----------------------------------------------------------------------------------

/** `account/rateLimits/read` → `rateLimitResetCredits`, verified live on codex-cli 0.155.0:
 *  `{ availableCount: 1, credits: [{ id, resetType, status: "available", grantedAt, expiresAt,
 *    title: "Full reset", description }] }` — `expiresAt`/`grantedAt` are epoch SECONDS. */
interface CodexResetCreditsWire {
  availableCount?: unknown;
  credits?: unknown;
}

/**
 * Read Codex's banked resets.
 *
 * `availableCount` is the provider's own answer and is trusted for the COUNT, but the expiry and the
 * title only exist per credit, so the list is still walked — filtered to `status: "available"`, since
 * a spent or expired credit stays in the array. When the list disagrees with the count (an unfamiliar
 * status, an older CLI that sends only the count) the count wins and the extras land in `pending`,
 * because under-reporting a usable reset is the failure that matters here.
 */
export function parseCodexResetCredits(raw: unknown, readAt: number): ResetCreditsDTO | null {
  if (raw === undefined || raw === null || typeof raw !== "object") return null;
  const wire = raw as CodexResetCreditsWire;
  const credits = Array.isArray(wire.credits) ? (wire.credits as Record<string, unknown>[]) : [];
  const usable = credits.filter((credit) => credit && typeof credit === "object" && credit.status === "available");
  const available = positiveInt(wire.availableCount) || usable.length;
  const expiries = usable.map((credit) => epochSecondsToMs(credit.expiresAt)).filter((ms): ms is number => ms !== null);
  return {
    available,
    pending: Math.max(0, credits.length - Math.max(available, usable.length)),
    expiresAt: expiries.length ? Math.min(...expiries) : null,
    title: trimmedTitle(usable[0]?.title),
    readAt,
    redeemId: redeemIdOf(usable[0]?.id),
  };
}

// ---- Anthropic Claude ------------------------------------------------------------------------------

/** `/api/oauth/usage?cedar_ember=1&skip_spend=1` → the `cedar_ember` block. Field names read out of
 *  the shipped Claude Code bundle (2.1.278), which validates exactly these:
 *  `{ eligible, grants: [{ id, label, resets_total, resets_left, ends_at, paused, usable_now,
 *     use_requires_limit }], next_grant_id, ... }`. */
interface ClaudeGrantWire {
  id?: unknown;
  label?: unknown;
  resets_left?: unknown;
  ends_at?: unknown;
  paused?: unknown;
  usable_now?: unknown;
}
interface ClaudeCedarEmberWire {
  eligible?: unknown;
  grants?: unknown;
  next_grant_id?: unknown;
}

/** `ends_at` is an ISO-8601 string here, not an epoch — the two providers genuinely differ. */
function isoToMs(value: unknown): number | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Read Claude's banked resets out of the `cedar_ember` block.
 *
 * A grant carries `resets_left` rather than one row per reset, and `use_requires_limit` is deliberately
 * NOT consulted: needing to be at a limit before spending it does not make the reset any less banked,
 * and hiding it would defeat the whole point of surfacing it early. What DOES move a grant to `pending`
 * is the provider saying it cannot be used at all right now — `paused`, or `usable_now: false`.
 *
 * An ineligible account (`eligible: false`, the usual answer on a plan with no programme) is a
 * successful read of zero, never a failure: the chip must be able to say "none banked" rather than
 * sitting in a permanent unknown.
 */
export function parseClaudeResetCredits(raw: unknown, readAt: number): ResetCreditsDTO | null {
  if (raw === undefined || raw === null || typeof raw !== "object") return null;
  const wire = raw as ClaudeCedarEmberWire;
  if (wire.eligible === false) return noResetCredits(readAt);
  const grants = Array.isArray(wire.grants) ? (wire.grants as ClaudeGrantWire[]) : [];
  let available = 0;
  let pending = 0;
  const expiries: number[] = [];
  let title: string | null = null;
  const usableIds: string[] = [];
  for (const grant of grants) {
    if (!grant || typeof grant !== "object") continue;
    const left = positiveInt(grant.resets_left);
    if (!left) continue;
    if (grant.paused === true || grant.usable_now === false) {
      pending += left;
      continue;
    }
    available += left;
    const endsAt = isoToMs(grant.ends_at);
    if (endsAt !== null) expiries.push(endsAt);
    title ??= trimmedTitle(grant.label);
    const id = redeemIdOf(grant.id);
    if (id) usableIds.push(id);
  }
  // The claim call refuses any grant but the provider's `next_grant_id` ("not_next_grant"), so that one
  // is spent when it is among the usable grants; the first usable grant is only the fallback.
  const next = redeemIdOf(wire.next_grant_id);
  const redeemId = next && usableIds.includes(next) ? next : (usableIds[0] ?? null);
  return { available, pending, expiresAt: expiries.length ? Math.min(...expiries) : null, title, readAt, redeemId };
}

// ---- redeeming --------------------------------------------------------------------------------------

/** What a redeem attempt came to, in words the owner can act on. `ok` only when a reset was actually
 *  spent (or the provider confirms this same attempt already spent one). */
export interface RedeemOutcome {
  ok: boolean;
  message: string;
}
