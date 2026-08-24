# The Online Office (coordination across machines)

The local office groups agents by `normalizeWorkspace(thread.workspace)` — a filesystem path. The
ONLINE office groups them by **repository identity**, because two people's checkouts of the same
repo have different paths and the same remote. Read this before touching anything under
`server/src/office/` or `relay/`. (For the LOCAL gating fan-out see `office-coordination.md`; for
the CLI text bridge see `office-bridge.md`.)

## The pieces
- `relay/` — a standalone one-dependency (`ws`) service, deployed to the Sprogbroen Hetzner box as its
  own compose project. `relay/src/core.ts` is transport-free routing (gate `test:relay-core`);
  `relay/src/index.ts` is the HTTP + WebSocket shell; `relay/README.md` has the surfaces and the deploy.
- `server/src/office/repoIdentity.ts` — `normalizeRemote` collapses every URL form of one remote to
  `host/owner/repo`. No remote ⇒ `name:<folder>`. **This is the hinge**: get it wrong and nobody groups.
- `server/src/office/onlineOffice.ts` — one authenticated socket. Standalone over `(Db, EventHub)` +
  three callbacks; NEVER imports ThreadManager (same rule as `notes.ts`/`scheduler.ts`).
- ThreadManager touches five places only: `repoPeers` (remote agents are peers), `officeRoster`,
  `chatPost` (fans out), `receiveRemoteChat`, `remoteTeammatesJoined`.

## Rules that bite
- **`server/src/office/onlineProtocol.ts` is a byte-for-byte copy of `relay/src/protocol.ts`.** Change
  one, change the other, and bump `RELAY_PROTOCOL` for anything not backward-compatible — both ends
  refuse a mismatch at the handshake rather than dropping frames silently.
- **`repoIdentity` is async (it shells out to git); the office gate is sync.** `remotePeers` therefore
  answers from a cache and warms a miss in the background. That is deliberate: a git read must never
  block `officeNote`. The self-healing part is that a presence change re-fires `onRemoteJoin`, so a
  teammate discovered a tick late still wakes the live implementor.
- **A remote peer is NOT a working-tree peer.** Their edits never appear in `git status`; the collision
  is at the remote. `officeNote`, `remoteChatPush` and `remoteJoinPush` all say so explicitly — don't
  "simplify" them into the local "commit only your own hunks" wording.
- **Dedup remote chat on the relay's message id, and keep that guard DURABLE** (`remoteChatSeen`, mirrored
  into kv). A room's backlog is replayed on every entry — and the first connect after a bounce is an entry,
  when an in-memory-only set is empty. It shipped as a plain `Set` and re-persisted up to `ROOM_HISTORY`
  lines per shared room on every deploy, re-pushing them at the auto-resumed implementors as fresh traffic
  (`cac3a89`). Same lesson as `ensureGroup`'s `chatThreadInRoom` — a "notify once" guard outlives a restart.
- **Never `ws.close()` a socket that isn't OPEN, and never strip its listeners without leaving an
  `error` sink.** `ws` emits on a close during the handshake, and an unhandled `error` kills the
  process — a revoked device token crashed the whole orchestrator until `closeSocket` handled both.
- **The device token is never broadcast.** `OnlineOfficeDTO` carries `joined`, not the token; the join
  code is used once in the hub handler and dropped.

## Deploying / operating
`relay/deploy.sh` ships the source and rebuilds on the box (`~/gg-office-relay`; the `deploy` user has
no sudo, hence not `/opt`). The Caddy site block for `office.sprogbroen.dk` lives in the **Sprogbroen**
repo's `infra/Caddyfile` — that file is git-tracked and their deploy does `git checkout <sha>`, so
editing it on the server breaks their next deploy. The join code + admin key are in
`server/data/online-office-credentials.txt` (gitignored).

## Verify
`npm run test:online-office --prefix server` (client ↔ a fake relay, real git repos, real ThreadManager)
and `npm run test:relay-core --prefix server` (routing with fake peers). Both free. For the Settings
surface, `npm run office-lab --prefix server` drives Join → roster → Leave headlessly against its own
throwaway instance and its own throwaway relay — never prod.
