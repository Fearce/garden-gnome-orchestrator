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

## Surfaces

| Route | Auth | What it is |
| --- | --- | --- |
| `GET /` | public | Status page: how many instances/agents/shared repos, and how to join. Deliberately names **no** repos, tasks or people. |
| `GET /api/health` | public | The same counts as JSON — what a monitor polls. |
| `POST /api/join` | join code | One-time code → device token. Rate-limited per address. |
| `GET /ws` | device token | The WebSocket. `Authorization: Bearer …`, never a query parameter (Caddy logs request lines). |
| `GET /admin?key=…` | admin token | Who is connected, every joined instance, which rooms have traffic. |
| `GET /api/members`, `DELETE /api/members/:id` | admin token | List / revoke devices. |

## Deploying

`./deploy.sh` copies the source to the host, builds the image there and restarts the container. It
creates `.env` from `.env.example` on first run and never overwrites it afterwards.

On the Sprogbroen box the relay runs as its own compose project at `/opt/gg-office-relay`, attached to
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
