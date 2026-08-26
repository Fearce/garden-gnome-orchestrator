# The Online Office relay

The internet-side half of the [Online Office](../CLAUDE.md#the-online-office-cross-machine-coordination):
a small WebSocket server that lets orchestrator instances on **different machines** see each other's
agents and coordinate per repository. Two people working `card-marker` from two houses get one shared
project room; two people working unrelated repos never hear from each other.

It moves **presence and short coordination messages only** — no repository contents, no credentials, no
task output.

## Why it is a separate package

The orchestrator server carries the Agent SDK and a native SQLite build; this has one runtime dependency
(`ws`), no database and no native code, so it builds on a 4 GB VPS in seconds. The wire contract lives in
`src/protocol.ts` and is **mirrored byte-for-byte** in `server/src/office/onlineProtocol.ts` — the same
copy-don't-import convention the repo already uses between `server/src/types.ts` and `web/src/types.ts`.

## Authentication — one code, then never again

1. The owner sets `JOIN_CODE` in the host's `.env`.
2. Each person pastes the relay URL + that code once, in **Settings → Online office**.
3. `POST /api/join` exchanges the code for a per-instance **device token** (32 random bytes; only its
   SHA-256 is stored). The console keeps it and connects with it from then on.
4. Every successful connect **slides the token's expiry forward** by `TOKEN_TTL_DAYS` (default 180), so
   an instance in regular use never re-authenticates. One that goes quiet that long has to be re-invited.

Revoking a device is `DELETE /api/members/<id>` with the admin key (or the list on `/admin?key=…`).
Rotating the join code locks out *new* joins without disturbing anyone already in.

Opening `/admin?key=…` trades the key **once** for a 12-hour `HttpOnly; Secure; SameSite=Strict` session
cookie and redirects to the bare `/admin`, so the credential stops appearing in the address bar, the
browser's history and every subsequent proxy log line. That cookie authorises **reads only** — revoking a
device still needs an explicit `x-admin-token` header, so the session introduced no CSRF surface.

## Surfaces

| Route | Auth | What it is |
| --- | --- | --- |
| `GET /` | public | Status page: how many instances/agents/shared repos, and how to join. Deliberately names **no** repos, tasks or people. |
| `GET /api/health` | public | The same three counts as JSON — what a monitor polls. The number of *joined* devices is added only for the owner. |
| `POST /api/join` | join code | One-time code → device token. Rate-limited per address. |
| `GET /ws` | device token | The WebSocket. `Authorization: Bearer …`, never a query parameter (Caddy logs request lines). |
| `GET /admin`, `GET /admin?key=…` | admin token or session cookie | Who is connected, every joined instance, which rooms have traffic. |
| `GET /api/members` | admin token header or session cookie | List devices. |
| `DELETE /api/members/:id` | admin token **header only** | Revoke a device. |

## What being public actually exposes

The hostname is guessable and everything above is reachable from the open internet, so the boundary is
worth stating rather than assuming:

- **Anonymous callers get three integers** — instances online, agents working, shared repos — plus the
  office's display name. No member names, no repo names, no task titles, no message bodies, `noindex`.
- **The join code is the whole boundary.** Anyone holding it can join, and a member may name **any** repo
  room and receive its presence and chat. Rooms are compartments *between strangers*, not between
  members: they keep unrelated repos from hearing each other, they do not stop a member who wants to
  listen. Share the code the way you'd share a password, and revoke a device rather than assuming a room
  is private from someone already in the office.
- **`X-Forwarded-For` is not trusted as sent.** It is honoured only from a private socket peer (the
  reverse proxy on the shared docker network) and read `TRUSTED_PROXY_HOPS` entries from the *right*,
  because anything further left was written by the caller. Reading the leftmost entry would let anyone
  mint a fresh rate-limit bucket per request and brute-force the join code without limit — the relay must
  not depend on a proxy default configured in another repository for its only such defence.
- **The relay sets its own security headers** (`Content-Security-Policy: default-src 'none'`,
  `frame-ancestors 'none'`, `nosniff`, `no-referrer`, `no-store`) for the same reason.

## Deploying

`./deploy.sh` copies the source to the host, builds the image there and restarts the container. It never
overwrites an existing `.env`.

On a host that has **no** `.env` yet it seeds one from `.env.example` and then **stops without starting
anything**: the example ships an empty `JOIN_CODE`, and the relay refuses to boot without one or with a
placeholder-shaped one. Set the code (`openssl rand -base64 24 | tr -d /+=`) and run the script again.
Starting an office whose code came out of a public repository is the one mistake that cannot be undone
by fixing it afterwards.

On the Sprogbroen box the relay runs as its own compose project at `~deploy/gg-office-relay`, attached to
the **existing** `sprogbroen-prod_default` network and publishing no host port — Caddy, which owns
80/443 there, proxies `office.sprogbroen.dk` to `gg-office-relay:8787`. That Caddy site block lives in
the Sprogbroen repository's `infra/Caddyfile` (it is git-tracked and its deploy does `git checkout
<sha>`, so editing it on the box would break Sprogbroen's next deploy). Nothing else about Sprogbroen is
touched, and a Sprogbroen deploy never restarts the relay.

## Tests

`npm test` (or, free and registered as a gate, `npm run test:relay-core --prefix server`) drives
`RelayCore` with fake peers: who a message reaches, backlog replay on entering a room, presence
de-duplication, room-key validation, and that a repo counts as "shared" only when two *different*
instances are in it.

`npm run test:relay-access --prefix server` covers the HTTP edge — address attribution under a spoofed
`X-Forwarded-For`, the join throttle's budget and its memory bound, owner sessions, and the refusal to
boot on a placeholder join code. Its second half **boots the real `src/index.ts`** on a loopback port and
talks to it, because which guard sits on which route is wiring that pure units cannot see: it is what
proves `/admin` degrades to the public page, that a session cookie cannot revoke a device, and that
varying only the caller-written half of `X-Forwarded-For` does not buy a fresh rate-limit budget.

The gate runs through the server's `tsx`, which type-STRIPS rather than type-checks, so the root
`npm run typecheck` covers this package too — otherwise a type error here would first surface inside
`docker build`, on the box, mid-deploy. That needs `npm install --prefix relay` once (the root
`npm run install:all` does it).
