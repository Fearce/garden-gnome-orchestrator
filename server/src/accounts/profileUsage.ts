// Reading a Claude subscription's BANKED RESETS, which the agent tokens cannot see.
//
// Every other account number GGO shows comes from the `/v1/messages` rate-limit headers (`usagePing.ts`),
// because a setup-token is accepted there. Banked resets are not in those headers at all — they live
// behind `/api/oauth/usage`, which requires the `user:profile` scope, and Claude Code's own bundle says
// outright that "env-var and setup-token sessions default to user:inference only". Verified against both
// of this installation's subscriptions: HTTP 403, `oauth_scope_insufficient`, required scope `user:profile`.
//
// So this read needs a SECOND, profile-scoped token per subscription — the `claudeAiOauth.accessToken`
// from a machine where `claude login` has run. It is optional by design: without one the account simply
// reports `unconfigured` and the console says so, rather than showing a confident zero. Nothing about
// dispatch, routing or capacity depends on it.
//
// It is never used to run a model. Keeping it strictly to this one GET is what makes adding a
// broader-scoped token to the configuration a small, auditable decision.

import { randomUUID } from "node:crypto";
import { parseClaudeResetCredits, type RedeemOutcome, type ResetCreditsDTO } from "./resetCredits.js";

/** `skip_spend=1` keeps the response to the usage/grant blocks — we want neither the spend figures nor
 *  the cost of computing them. `cedar_ember=1` is what asks for the grant block at all.
 *
 * `PROFILE_USAGE_URL` overrides it. That exists because this is the one reading in the whole app that
 * cannot be exercised without a credential the machine may not have: the agent tokens are scoped
 * `user:inference`, so a lab or a gate has no way to reach this code path at all otherwise. Pointing it
 * at a local fixture lets the REAL fetch, classification and parse run end to end. Env-only, never
 * settable over the wire — the same trust level as the `ANTHROPIC_BASE_URL` swap the z.ai backend uses. */
const USAGE_URL = process.env.PROFILE_USAGE_URL?.trim() || "https://api.anthropic.com/api/oauth/usage?cedar_ember=1&skip_spend=1";

/**
 * Why a profile read produced no answer — the same "say WHICH failure" discipline `PingFailReason`
 * follows, because these are acted on very differently:
 *  - `unconfigured`: no profile token for this subscription. The normal state, not an error.
 *  - `scope`: the token was accepted but lacks `user:profile` — almost always a setup-token pasted
 *             into the field by mistake, which is worth saying plainly instead of "auth failed".
 *  - `auth`:    rejected outright (401/403 that is not a scope complaint) — expired or wrong account.
 *  - `network`/`timeout`: kept apart for the reason `usagePing.ts` documents — on this box a timeout
 *             usually means the local event loop was starved, not that the API is unreachable.
 *  - `unreadable`: HTTP 200 whose body carried no `cedar_ember` block we could parse.
 */
export type ProfileFailReason = "unconfigured" | "scope" | "auth" | "network" | "timeout" | "unreadable";

export type ProfileUsageResult =
  | { ok: true; credits: ResetCreditsDTO; organizationId: string | null }
  | { ok: false; reason: ProfileFailReason };

interface UsageBody {
  cedar_ember?: unknown;
  organization?: { uuid?: unknown } | null;
}

/**
 * Fetch one subscription's banked-reset standing.
 *
 * Returns the parsed grants plus the organization uuid the token belongs to. That uuid is the whole
 * reason this returns more than a number: the `/v1/messages` ping already reports each account's
 * `anthropic-organization-id`, so a caller can PROVE a profile token belongs to the subscription it was
 * filed under before showing its credits there. Attributing one subscription's banked reset to another
 * is the one failure that would make this feature actively misleading.
 */
export async function fetchProfileUsage(token: string, timeoutMs = 12_000): Promise<ProfileUsageResult> {
  if (!token.trim()) return { ok: false, reason: "unconfigured" };
  let res: Response;
  try {
    res = await fetch(USAGE_URL, {
      headers: {
        Authorization: `Bearer ${token.trim()}`,
        "anthropic-beta": "oauth-2025-04-20",
        "user-agent": "claude-cli/2.0.0",
      },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    return { ok: false, reason: timedOut(err) ? "timeout" : "network" };
  }
  const text = await res.text().catch(() => "");
  if (!res.ok) return { ok: false, reason: classifyRejection(res.status, text) };
  let body: UsageBody;
  try {
    body = JSON.parse(text) as UsageBody;
  } catch {
    return { ok: false, reason: "unreadable" };
  }
  const credits = parseClaudeResetCredits(body.cedar_ember, Date.now());
  if (!credits) return { ok: false, reason: "unreadable" };
  const uuid = body.organization?.uuid;
  return { ok: true, credits, organizationId: typeof uuid === "string" && uuid.trim() ? uuid.trim() : null };
}

/** A scope complaint is a 403 naming `user:profile`; anything else in the 401/403 family is a plain
 *  auth failure. Matched on the documented `error_code` first and the required-scope list second, so a
 *  reworded message cannot silently demote a scope problem into "expired token, log in again". */
function classifyRejection(status: number, body: string): ProfileFailReason {
  if (status !== 401 && status !== 403) return "auth";
  if (/oauth_scope_insufficient/.test(body) || /user:profile/.test(body)) return "scope";
  return "auth";
}

/** `AbortSignal.timeout` rejects with a DOMException named TimeoutError; a genuine connection failure
 *  arrives as a TypeError. Mirrors `usagePing.timedOut` — keep the two in step. */
function timedOut(err: unknown): boolean {
  return err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
}

// ---- spending one ---------------------------------------------------------------------------------

/** Where a claim goes. Env-overridable for the same reason as `USAGE_URL`: a lab has no other way to
 *  drive the real request and response handling without spending the owner's reset. */
const CLAIM_BASE = process.env.PROFILE_CLAIM_BASE_URL?.trim() || "https://api.anthropic.com";

/** The claim response, as Claude Code's own `/limit-reset` validates it (bundle 2.1.280). */
interface ClaimBody {
  result?: unknown;
  reason?: unknown;
  resets_left?: unknown;
}

/**
 * Spend one banked Claude reset: `POST /api/organizations/{org}/reset_rate_limits`, exactly the call
 * Claude Code's `/limit-reset` makes. `grantId` must be the grant the usage read named next; the
 * backend refuses any other. `request_id` is fresh per attempt, which is what makes a retried click a
 * second attempt rather than a replay.
 */
export async function claimClaudeReset(token: string, organizationId: string, grantId: string, timeoutMs = 25_000): Promise<RedeemOutcome> {
  if (!/^[0-9a-fA-F-]{36}$/.test(organizationId)) return { ok: false, message: "The subscription's organization is not known yet, so there is nothing to claim against. Try again after the next usage read." };
  let res: Response;
  try {
    res = await fetch(`${CLAIM_BASE}/api/organizations/${organizationId}/reset_rate_limits`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token.trim()}`,
        "anthropic-beta": "oauth-2025-04-20",
        "user-agent": "claude-cli/2.0.0",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ program: "cedar_ember", grant_id: grantId, request_id: randomUUID() }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    return { ok: false, message: timedOut(err) ? "Claude did not answer in time. The reset may or may not have been used; the count updates on the next read." : "Could not reach Claude to claim the reset." };
  }
  const text = await res.text().catch(() => "");
  if (res.status === 429) return { ok: false, message: "Claude is rate-limiting claims right now. Try again in a minute." };
  if (res.status === 401 || res.status === 403) return { ok: false, message: "Claude refused the profile token for this subscription. Paste a fresh one in Settings > Subscriptions." };
  if (!res.ok) return { ok: false, message: `Claude answered HTTP ${res.status}; the reset was not used.` };
  let body: ClaimBody;
  try {
    body = JSON.parse(text) as ClaimBody;
  } catch {
    return { ok: false, message: "Claude sent a reply that could not be read. Check the count after the next read." };
  }
  return claimOutcome(body);
}

/** Claude's claim verdicts in owner words. The reason codes are the ones the bundle enumerates. */
function claimOutcome(body: ClaimBody): RedeemOutcome {
  const left = typeof body.resets_left === "number" ? ` ${body.resets_left} left.` : "";
  switch (body.result) {
    case "reset":
      return { ok: true, message: `Limits refilled.${left}` };
    case "already_used":
      return { ok: false, message: "That reset was already used." };
    case "not_limited":
      return { ok: false, message: "Claude only lets you use this reset once you have hit a limit. It is still banked." };
    case "cooldown":
      return { ok: false, message: "A reset was used recently; Claude has a cooldown before the next one. It is still banked." };
    case "ineligible":
      return { ok: false, message: `This subscription is not eligible to use the reset${typeof body.reason === "string" ? ` (${body.reason})` : ""}.` };
    default:
      return { ok: false, message: `Claude could not use the reset right now${typeof body.reason === "string" ? ` (${body.reason})` : ""}. It is still banked.` };
  }
}
