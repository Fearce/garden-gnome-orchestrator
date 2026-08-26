# Is `office.sprogbroen.dk` safe to leave fully public?

**Verdict: yes — the public part was already the right shape, but the deploy path around it was not.**
Anonymous callers get three integers and nothing else, and every surface that names a person, a
repository or a message is behind a 190-bit admin key or a 256-bit device token. What the review found
was one genuinely serious defect (a fresh deploy would start an office whose password is published in
this repository) and four hardening gaps, all fixed here. Reviewed 2026-08-26 against the live relay and
`relay/` at `53c259f`.

## What "public" actually means here

`GET /` and `GET /api/health` answer anyone. Both expose the same three counts — instances online,
agents working, shared repos — plus the office's display name, and the page carries `noindex`. No member
names, repository names, task titles, message bodies, or restart uptime are public. That is a deliberate
design, stated in `status.ts`'s own comment, and the code matches the comment.

Everything else is gated:

| Surface | What holds it shut | Strength |
|---|---|---|
| `GET /ws` (presence + chat) | per-device bearer token, stored only as SHA-256 | 256 bits |
| `POST /api/join` | the join code, constant-time compared, throttled per address | 24 chars ≈ 140 bits |
| `/admin`, `/api/members` | the admin key, constant-time compared, **disabled entirely when unset** | 32 chars ≈ 190 bits |

Brute force is not a realistic path against any of those, and I confirmed the live relay refuses
`/api/members` and `/admin` without a key. TLS, HSTS and `Referrer-Policy: no-referrer` come from Caddy.
The container runs as `node`, publishes no host port, and has one runtime dependency.

So the honest answer to "is it safe at all?" is that being reachable was never the risk. The risks are
(a) who holds the join code, and (b) what happens the next time someone deploys this.

## The one that mattered

**A first deploy to a new host started a fully working relay whose join code is a literal string in a
public GitHub repository.** `deploy.sh` seeded `.env` from `.env.example` when none existed and then ran
`docker compose up -d` regardless. The example shipped
`JOIN_CODE=change-me-to-something-long-and-random` — 38 characters, so it sailed past the one guard
`config.ts` documents as existing precisely so that "a relay that started with a guessable code" cannot
happen. The only warning was an `echo` in the deploy scrollback.

Kevin's live relay is **not** affected: its `.env` was written by hand on 2026-08-24 with a random
24-character code. This was the fresh-host path — and the path anyone cloning this public repo to run
their own office would take.

Fixed three ways, because any one of them alone is a warning nobody reads: `.env.example` now ships an
empty `JOIN_CODE`, `assertConfigured()` rejects placeholder-shaped codes outright, and `deploy.sh` seeds
`.env` and then **stops without starting anything**, printing what to set.

## The other four

**1. The only brute-force defence trusted a client-controlled header.** `clientIp()` read the *first*
`X-Forwarded-For` entry. Under any proxy with append semantics — nginx, Cloudflare, or Caddy itself once
`trusted_proxies` is configured — that entry is whatever the caller typed, so every request could mint a
fresh rate-limit bucket and the join throttle would silently become a no-op.

I tested this against the live relay before changing anything: twelve join attempts with a spoofed
address were all attributed to my real one (ten `401`s, then `429`), so **today's Caddy replaces the
header and it is not exploitable right now**. But the relay's only such defence was resting on a proxy
default configured in a *different repository*, and its failure mode is invisible. It now honours the
header only from a private socket peer and counts `TRUSTED_PROXY_HOPS` entries from the right, which is
correct under both append and replace semantics.

**2. The join-attempt map was unbounded.** It was pruned only when the same address recurred, so every
address that ever failed left an entry forever — the one structure an unauthenticated caller could grow.
Now swept on every write and hard-capped.

**3. The admin key travelled in the URL on every visit.** `bearer()`'s own comment says a URL-borne
credential is a logged credential, and then `isAdmin` accepted `?key=`. Caddy logs the query string, and
the browser keeps it in history. `/admin?key=…` now trades the key **once** for a 12-hour
`HttpOnly; Secure; SameSite=Strict` session cookie and redirects to the bare `/admin`. The cookie
authorises reads only — revoking a device still needs an explicit header — so the session added no CSRF
surface. That URL form is accepted only on `/admin`; every API read or mutation requires an explicit
admin header (or, for reads, the session cookie). `curl` with `x-admin-token` is answered directly, as
documented.

**4. No CSP, and Node's default timeouts.** The pages are server-rendered with one inline `<style>` and
no script, image or form, so the policy can deny everything else; `frame-ancestors 'none'` also makes the
office un-framable. The relay now sets its own headers rather than depending on Caddy for them, refuses
an over-cap request body by destroying it instead of draining it, and holds an anonymous connection for
15 seconds rather than five minutes. Instance names are stripped of control characters before they reach
a log line (a newline in a joining instance's name could forge container-log entries).

## What is deliberately still true

- **The join code is the whole boundary.** A member may name *any* repo room and receive its presence and
  chat; rooms separate strangers, not members. That is the right trade for a small invited office, but it
  means "Mikkel is in the office" and "Mikkel could read any room he names" are the same statement. The
  owner view today lists rooms for `votaorg/vota-ios` and `Fearce/bobfish` alongside the shared ones, so
  the rooms carry coordination chatter about private work, not only about the repo everyone shares.
  Rotating the code locks out new joins without disturbing anyone already in; revoking a device is
  `DELETE /api/members/<id>`. If that separation ever needs to be real rather than social, the change is
  to prove a checkout rather than accept a named room — which forks make genuinely hard, and which
  nothing today needs.
- **A joined device token lasts 180 days of silence** and slides forward on every connect, so a machine in
  regular use never re-authenticates. If a joined laptop is lost, revoke it — expiry will not do it for you.
- **Chat bodies sit in a docker volume** on the Sprogbroen box. Root on that host can read them.
- **The counts are an activity oracle.** Anyone polling `/api/health` learns when agents are running. That
  is the same information the status page exists to give, so it stays; only the number of *joined devices*
  moved behind the admin key, to match what the page already promised.

## Verify

`npm run test:relay-access --prefix server` — free, registered in the gate suite. Pure units for address
attribution, the throttle's budget and memory bound, and owner sessions; then it **boots the real
`src/index.ts`** on a loopback port and drives it, because which guard sits on which route is wiring that
pure units cannot see. It also holds a real WebSocket open past the new 15-second `requestTimeout`, which
is the one way this change could have broken the live office. Each of the three headline fixes was
revert-checked: removed, watched fail with an assertion naming the defect, restored byte-identically.

Confirmed against the deployed relay after shipping: the security headers are present, anonymous
`/api/health` no longer carries the member count while the owner's does, `/admin` without a key still
degrades to the public page, eleven wrong join codes with a different spoofed address each still land in
one bucket and throttle at the eleventh, and a session cookie is refused for `DELETE /api/members/:id`.
The `?key=` → cookie → bare `/admin` flow was driven in a real browser from a clean profile, because
`SameSite=Strict` failing on a direct navigation would have looked exactly like being logged straight
back out on the phone; it holds, and the cookie is not readable from script.

One cosmetic artifact: `Referrer-Policy` and `X-Content-Type-Options` now appear **twice** on responses,
because Caddy adds its own copies of headers the relay also sets. Both are identical values and both
parse correctly (the first token wins for `nosniff`, the last valid one for `Referrer-Policy`), and
dropping them here would leave a relay deployed behind anything other than this Caddy without them.
