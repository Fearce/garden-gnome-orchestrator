/**
 * Unit gate — BANKED RESETS (the "you have 1 reset available" surface).
 *
 * The whole feature is two provider payloads folded into one shape, so the parsers ARE the feature.
 * Both fixtures below are verbatim from a live read on this installation (codex-cli 0.155.0's
 * `account/rateLimits/read`, and the `cedar_ember` block whose field names come out of the shipped
 * Claude Code bundle 2.1.278) — not invented, because a hand-written fixture would only ever prove
 * the parser agrees with whatever I assumed the wire looked like.
 *
 * What these assertions are actually defending:
 *  - ABSENT vs. ZERO. `null` means "we could not read"; `available: 0` means "none banked". Collapsing
 *    the two turns an unconfigured account into a confident claim that the owner has nothing — which
 *    is exactly the thing this feature exists to stop them believing.
 *  - A granted-but-unusable reset never inflates `available`. Telling the owner they have a reset they
 *    cannot spend is worse than telling them nothing.
 *  - The two providers' time formats really are different (Codex epoch SECONDS, Claude ISO-8601), and
 *    neither may silently produce a 1970 expiry, which renders as long-expired and hides a live credit.
 *
 * Run:  npm run test:reset-credits   (from server/) — free, no network, no quota.
 */

import { parseClaudeResetCredits, parseCodexResetCredits, noResetCredits } from "../accounts/resetCredits.js";

let passed = 0;
let failed = 0;
const failures: string[] = [];
function check(label: string, cond: boolean, detail?: string): void {
  if (cond) {
    passed++;
    console.log(`  ✅ ${label}`);
  } else {
    failed++;
    failures.push(label + (detail ? ` — ${detail}` : ""));
    console.log(`  ❌ ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

const READ_AT = 1_790_400_000_000;

// ---- Codex ------------------------------------------------------------------------------------------
console.log("\n=== banked resets — OpenAI Codex (rateLimitResetCredits) ===\n");

/** Verbatim from `account/rateLimits/read` on 2026-09-22 — the reading that prompted this feature. */
const CODEX_LIVE = {
  availableCount: 1,
  credits: [
    {
      id: "RateLimitResetCredit_9741ffd4dbac8191ae3ed4a39665085d",
      resetType: "codexRateLimits",
      status: "available",
      grantedAt: 1790109235,
      expiresAt: 1792701235,
      title: "Full reset",
      description: "Thanks for using Codex! You've been granted one free rate limit reset.",
    },
  ],
};

{
  const c = parseCodexResetCredits(CODEX_LIVE, READ_AT);
  check("the live payload reports the owner's one banked reset", c?.available === 1, JSON.stringify(c));
  check("nothing is left pending", c?.pending === 0, String(c?.pending));
  check("the expiry converts from epoch SECONDS to ms", c?.expiresAt === 1792701235000, String(c?.expiresAt));
  check("the provider's own title is carried, not invented", c?.title === "Full reset", String(c?.title));
  check("the reading is stamped with when it was taken", c?.readAt === READ_AT, String(c?.readAt));
}
{
  const c = parseCodexResetCredits({ availableCount: 0, credits: [] }, READ_AT);
  check("an empty grant list is a successful read of ZERO, not a failure", c !== null && c.available === 0, JSON.stringify(c));
  check("…and it claims no expiry it was never told", c?.expiresAt === null && c?.title === null, JSON.stringify(c));
}
check("an absent field is UNREADABLE (null), never zero", parseCodexResetCredits(undefined, READ_AT) === null);
check("so is a null or non-object one", parseCodexResetCredits(null, READ_AT) === null && parseCodexResetCredits(7, READ_AT) === null);
{
  // A spent credit stays in the array; only `status: "available"` counts.
  const c = parseCodexResetCredits(
    {
      availableCount: 1,
      credits: [
        { status: "used", expiresAt: 1700000000, title: "Spent one" },
        { status: "available", expiresAt: 1792701235, title: "Full reset" },
      ],
    },
    READ_AT,
  );
  check("a spent credit is not counted and does not donate its expiry", c?.available === 1 && c?.expiresAt === 1792701235000, JSON.stringify(c));
  check("the title comes from the USABLE credit", c?.title === "Full reset", String(c?.title));
}
{
  // Two usable credits: the soonest expiry is the one that matters to the owner.
  const c = parseCodexResetCredits(
    {
      availableCount: 2,
      credits: [
        { status: "available", expiresAt: 1792701235, title: "Full reset" },
        { status: "available", expiresAt: 1791000000, title: "Full reset" },
      ],
    },
    READ_AT,
  );
  check("the SOONEST expiry is reported when several are banked", c?.expiresAt === 1791000000000, String(c?.expiresAt));
}
{
  // An older CLI that sends only the count must still report it rather than falling back to the list.
  const c = parseCodexResetCredits({ availableCount: 3 }, READ_AT);
  check("a count with no list is trusted for the count", c?.available === 3, JSON.stringify(c));
}
{
  // An unfamiliar status must never SUBTRACT from the provider's own count — under-reporting a usable
  // reset is the failure that matters here, so the extras land in `pending` instead.
  const c = parseCodexResetCredits(
    { availableCount: 1, credits: [{ status: "available" }, { status: "some_future_state" }] },
    READ_AT,
  );
  check("an unknown status does not reduce the reported count", c?.available === 1, JSON.stringify(c));
  check("…and is surfaced as pending rather than dropped", c?.pending === 1, String(c?.pending));
}
check("a zero/NaN expiry is rejected rather than rendered as 1970", parseCodexResetCredits({ availableCount: 1, credits: [{ status: "available", expiresAt: 0 }] }, READ_AT)?.expiresAt === null);

// ---- Claude -----------------------------------------------------------------------------------------
console.log("\n=== banked resets — Anthropic Claude (cedar_ember) ===\n");

const CLAUDE_GRANTED = {
  eligible: true,
  at_limit: false,
  grants: [
    {
      id: "01JQ8ZC2Q9",
      label: "Full reset",
      resets_total: 1,
      resets_left: 1,
      starts_at: "2026-09-01T00:00:00Z",
      ends_at: "2026-10-22T00:00:00Z",
      clears: ["five_hour", "seven_day"],
      paused: false,
      usable_now: true,
      use_requires_limit: true,
      percent_used: {},
      blocking: [],
    },
  ],
  next_grant_id: "01JQ8ZC2Q9",
  weekly_resets_at: "2026-09-28T00:00:00Z",
  cooldown_until: null,
};

{
  const c = parseClaudeResetCredits(CLAUDE_GRANTED, READ_AT);
  check("a grant with one reset left reports one banked", c?.available === 1, JSON.stringify(c));
  check("the ISO expiry parses (Claude sends a string, Codex sends epoch seconds)", c?.expiresAt === Date.parse("2026-10-22T00:00:00Z"), String(c?.expiresAt));
  check("the grant's own label is carried through", c?.title === "Full reset", String(c?.title));
}
check(
  "`use_requires_limit` does NOT hide a banked reset — needing a limit to spend it is not the same as not having it",
  parseClaudeResetCredits({ eligible: true, grants: [{ resets_left: 1, use_requires_limit: true, usable_now: true }] }, READ_AT)?.available === 1,
);
{
  const paused = parseClaudeResetCredits({ eligible: true, grants: [{ resets_left: 2, paused: true }] }, READ_AT);
  check("a PAUSED grant is pending, never available", paused?.available === 0 && paused?.pending === 2, JSON.stringify(paused));
}
{
  const notYet = parseClaudeResetCredits({ eligible: true, grants: [{ resets_left: 1, usable_now: false }] }, READ_AT);
  check("`usable_now: false` is pending too", notYet?.available === 0 && notYet?.pending === 1, JSON.stringify(notYet));
  check("…and a pending-only grant claims no expiry", notYet?.expiresAt === null, String(notYet?.expiresAt));
}
{
  const ineligible = parseClaudeResetCredits({ eligible: false }, READ_AT);
  check("an ineligible account is a successful read of ZERO, not an unknown", ineligible?.available === 0 && ineligible?.pending === 0, JSON.stringify(ineligible));
}
check("an absent block is UNREADABLE (null), never zero", parseClaudeResetCredits(undefined, READ_AT) === null);
check("a spent grant (resets_left 0) contributes nothing", parseClaudeResetCredits({ eligible: true, grants: [{ resets_left: 0 }] }, READ_AT)?.available === 0);
{
  const many = parseClaudeResetCredits(
    {
      eligible: true,
      grants: [
        { resets_left: 1, usable_now: true, ends_at: "2026-10-22T00:00:00Z", label: "Full reset" },
        { resets_left: 2, usable_now: true, ends_at: "2026-10-01T00:00:00Z", label: "Bonus" },
      ],
    },
    READ_AT,
  );
  check("several usable grants sum, and report the soonest expiry", many?.available === 3 && many?.expiresAt === Date.parse("2026-10-01T00:00:00Z"), JSON.stringify(many));
}
check(
  "an unparseable ends_at is dropped rather than becoming an expired date",
  parseClaudeResetCredits({ eligible: true, grants: [{ resets_left: 1, usable_now: true, ends_at: "whenever" }] }, READ_AT)?.expiresAt === null,
);

// ---- the shared shape -------------------------------------------------------------------------------
console.log("\n=== banked resets — the shared zero ===\n");
{
  const none = noResetCredits(READ_AT);
  check("the explicit zero is a real reading, fully populated", none.available === 0 && none.pending === 0 && none.expiresAt === null && none.readAt === READ_AT, JSON.stringify(none));
}

// ---- redeeming ---------------------------------------------------------------------------------------
console.log("\n=== banked resets — what a redeem spends, and the Claude claim itself ===\n");

check("Codex names the available credit a redeem should spend", parseCodexResetCredits(CODEX_LIVE, READ_AT)?.redeemId === "RateLimitResetCredit_9741ffd4dbac8191ae3ed4a39665085d");
check("Claude names the grant the provider lists next", parseClaudeResetCredits(CLAUDE_GRANTED, READ_AT)?.redeemId === "01JQ8ZC2Q9");
{
  const c = parseClaudeResetCredits(
    { eligible: true, next_grant_id: "g_second", grants: [{ id: "g_first", resets_left: 1, usable_now: true }, { id: "g_second", resets_left: 1, usable_now: true }] },
    READ_AT,
  );
  check("`next_grant_id` wins over list order — the claim refuses any other grant", c?.redeemId === "g_second", JSON.stringify(c));
}
{
  const c = parseClaudeResetCredits({ eligible: true, next_grant_id: "g_paused", grants: [{ id: "g_paused", resets_left: 1, paused: true }, { id: "g_ok", resets_left: 1, usable_now: true }] }, READ_AT);
  check("a paused next grant is not spent; a usable one is", c?.redeemId === "g_ok", JSON.stringify(c));
}
check("nothing available means nothing to spend", parseClaudeResetCredits({ eligible: true, grants: [{ id: "g", resets_left: 0 }] }, READ_AT)?.redeemId === null);
check("an id that is not a plain token is never sent back to the provider", parseCodexResetCredits({ availableCount: 1, credits: [{ id: "../x?y", status: "available" }] }, READ_AT)?.redeemId === null);

{
  // The real request and response handling, against a local stand-in for Claude's claim endpoint. The
  // override is read at import, so it is set before `profileUsage` loads.
  const { createServer } = await import("node:http");
  const seen: Array<{ url: string; auth: string; body: Record<string, unknown> }> = [];
  let answer: { status: number; body: unknown } = { status: 200, body: { result: "reset", resets_left: 0 } };
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      seen.push({ url: req.url ?? "", auth: String(req.headers.authorization), body: JSON.parse(raw || "{}") });
      // No keep-alive: a pooled fetch socket still open at `process.exit` trips a libuv assertion on Windows.
      res.writeHead(answer.status, { "content-type": "application/json", connection: "close" });
      res.end(JSON.stringify(answer.body));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  process.env.PROFILE_CLAIM_BASE_URL = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const { claimClaudeReset } = await import("../accounts/profileUsage.js");
  const ORG = "0b7f3c1e-5a2d-4e8f-9c61-2d4b8a9e7f10";

  const ok = await claimClaudeReset("tok-1", ORG, "01JQ8ZC2Q9");
  check("a `reset` answer is a success", ok.ok && /Limits refilled/.test(ok.message), JSON.stringify(ok));
  check("the claim goes to the organization's reset endpoint", seen[0]?.url === `/api/organizations/${ORG}/reset_rate_limits`, seen[0]?.url);
  check("with the profile token", seen[0]?.auth === "Bearer tok-1", seen[0]?.auth);
  check(
    "naming the programme, the grant, and a fresh request id",
    seen[0]?.body.program === "cedar_ember" && seen[0]?.body.grant_id === "01JQ8ZC2Q9" && /^[0-9a-f-]{36}$/.test(String(seen[0]?.body.request_id)),
    JSON.stringify(seen[0]?.body),
  );
  await claimClaudeReset("tok-1", ORG, "01JQ8ZC2Q9");
  check("a second click is a second attempt, not a replay of the first", seen[1]?.body.request_id !== seen[0]?.body.request_id);

  answer = { status: 200, body: { result: "not_limited", reason: "not_limited" } };
  const early = await claimClaudeReset("tok-1", ORG, "01JQ8ZC2Q9");
  check("`not_limited` is a refusal that says the reset is still banked", !early.ok && /hit a limit/.test(early.message) && /still banked/.test(early.message), JSON.stringify(early));
  answer = { status: 403, body: { error: "forbidden" } };
  const denied = await claimClaudeReset("tok-1", ORG, "01JQ8ZC2Q9");
  check("a rejected token says to replace it", !denied.ok && /profile token/.test(denied.message), JSON.stringify(denied));
  const before = seen.length;
  const noOrg = await claimClaudeReset("tok-1", "not-an-org", "01JQ8ZC2Q9");
  check("an unknown organization sends nothing at all", !noOrg.ok && seen.length === before, JSON.stringify(noOrg));
  await new Promise<void>((r) => server.close(() => r()));
}

console.log(`\n${failed ? "❌" : "✅"} ${passed} passed, ${failed} failed`);
if (failed) console.log(failures.map((f) => `  - ${f}`).join("\n"));
// exitCode, not exit(): a forced exit while the claim's fetch is still tearing down its handles aborts
// Node on Windows with a libuv assertion, which turns a green run into a crash.
process.exitCode = failed ? 1 : 0;
