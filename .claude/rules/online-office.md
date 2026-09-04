# The Online Office (coordination across machines)

The local office groups agents by workspace PATH; the ONLINE office groups them by **repository
identity** — two checkouts of one repo share a remote, never a path. Read this before touching
`server/src/office/` or `relay/`. (Local gating: `office-coordination.md`; CLI bridge: `office-bridge.md`.)

## The pieces
- `relay/` — a standalone one-dependency (`ws`) service, deployed to the Sprogbroen Hetzner box as its
  own compose project. `relay/src/core.ts` is transport-free routing (gate `test:relay-core`);
  `relay/src/index.ts` is the HTTP + WebSocket shell; `relay/README.md` has the surfaces and the deploy.
- `server/src/office/repoIdentity.ts` — `normalizeRemote` collapses every URL form of one remote to
  `host/owner/repo`. No remote ⇒ `name:<folder>`. **This is the hinge**: get it wrong and nobody groups.
  An identity is a `key` (from `origin`) **plus `aliases`** — every OTHER remote of that checkout. Two
  identities are one repo when the sets INTERSECT (`identitiesMatch`), never when the keys are equal.
- `server/src/office/onlineOffice.ts` — one authenticated socket. Standalone over `(Db, EventHub)` + three
  callbacks; NEVER imports ThreadManager (same rule as `notes.ts`/`scheduler.ts`).
- ThreadManager touches five places: `repoPeers`, `officeRoster`, `chatPost`, `receiveRemoteChat`, `remoteTeammatesJoined`.

## Rules that bite
- **Nothing an instance sent may come back to it — presence, live chat AND replayed history.** Only live
  chat was guarded, so `roster()` handed each instance its own agents and the replay its own lines. Not
  cosmetic: `repoPeers` is the office ON-switch, so a solo agent had a teammate (itself), joins announced
  its own workers, and the top bar drew the owner's machine as foreign. Relay: `rosterFor` + `othersOnly`.
  The receiver refuses self-stamped frames too (`isSelf`) — the relay is shared, on someone else's deploy
  cadence. Gates: `test:relay-core`, `test:online-office`.
- **A cross-machine room has NO local participant until your own agent replies.** Chatroom surfaces gate on
  `isCollaborationRoom` (`types.ts` + web mirror), never `threadIds.length >= 2` — a project room exists
  here only for a repo this machine works, so one remote machine in it IS the collaboration. It counts
  `chat_messages.remote_instance` (per MACHINE, backfilled from `sender_name` for older rows — skipping
  this instance's OWN name, else the self-echo above becomes a phantom teammate in the data).
- **A FORK is one repository under two keys, and `origin` alone splits it in two.** 2026-08-26: one
  checkout on the upstream repo and another on a fork — three agents, one codebase, two
  rooms, blind to each other, under a clean `probe:office` ✓ (it only inspects rooms that FORMED). Fix:
  `repoAliases` on presence + `rooms[]` on chat; the side holding the other's remote joins BOTH rooms and
  the relay delivers once per peer, stamped with the room THAT peer knows — an older client matches a room
  against its own key exactly. **Inert until someone runs `git remote add`**; a same-named pair is only
  SUGGESTED, via `online_office_unlinked` kv → `probe:office`, because two similarly named repos on
  different accounts can be unrelated.
  **2026-08-27: that split no longer exists on the original operator's machine.** Every checkout there now has a single
  remote, `origin` → `Fearce/garden-gnome-orchestrator`, so both machines key on the real repo directly
  and the alias path is no longer what joins them. The aliasing code stays (it is what makes any future
  contributor's fork group correctly), but do not read the war story above as a live description of the
  setup: the old personal fork is retired. A stale fork-style remote pointing at it
  still MATCHES as an alias string (nothing dials it), so it degrades quietly rather than breaking a room.
- **The directors' room is opt-in ON THE WIRE, and that is a containment, not a nicety.** A peer joins
  `DIRECTORS_ROOM` only after declaring `director` on a presence frame, because an older console files an
  unrecognised room into its own GENERAL office as agent chatter (`receiveRemoteChat` with no workspace).
  Same reason both new fields are OPTIONAL: `RELAY_PROTOCOL` must not bump for this. Locally the lines are
  `scope='directors'`, which is what keeps them out of `listProjectRooms`, `chat_read` (whose input type
  excludes the scope) and the console's `upsertRoom` — and `receiveDirectorChat` pushes into NO agent
  session. A room for people that can steer agents is not the feature.
- **`server/src/office/onlineProtocol.ts` is a byte-for-byte copy of `relay/src/protocol.ts`.** Change one,
  change the other; bump `RELAY_PROTOCOL` only for a change that is NOT backward-compatible (an additive
  optional field is). Both ends refuse a mismatch at the handshake — for the office, a bump is an outage
  until every machine redeploys, which is why the fork fix above added optional fields instead.
- **`repoIdentity` is async (it shells out to git); the office gate is sync.** `remotePeers` answers from a
  cache and warms a miss in the background — a git read must never block `officeNote`. A presence change
  re-fires `onRemoteJoin`, so a teammate found a tick late still wakes the live implementor.
- **A remote peer is NOT a working-tree peer.** Their edits never reach `git status`; the collision is at
  the remote, and `officeNote`/`remoteChatPush`/`remoteJoinPush` say so — don't "simplify" that into the
  local "commit only your own hunks" wording.
- **Dedup remote chat on the relay's message id, and keep that guard DURABLE** (`remoteChatSeen`, mirrored
  into kv). A room's backlog is replayed on every entry — and the first connect after a bounce is an entry,
  when an in-memory-only set is empty. It shipped as a plain `Set` and re-persisted up to `ROOM_HISTORY`
  lines per shared room on every deploy, re-pushing them at auto-resumed implementors as fresh traffic
  (`cac3a89`). Same lesson as `ensureGroup`'s `chatThreadInRoom` — "notify once" must outlive a restart.
- **Never `ws.close()` a socket that isn't OPEN, and never strip its listeners without leaving an `error`
  sink.** `ws` emits on a close during the handshake, and an unhandled `error` kills the process — a
  revoked device token crashed the whole orchestrator until `closeSocket` handled both.
- **The device token is never broadcast.** `OnlineOfficeDTO` carries `joined`; the join code is used once.

## Deploying / operating
`relay/deploy.sh` ships the WORKING TREE's `src/` and rebuilds on the box (`~/gg-office-relay`; the
`deploy` user has no sudo, hence not `/opt`). Several agents share this checkout, so deploy from a clean
export or you ship their WIP: `git archive HEAD relay | tar -x -C /tmp/x` and run it from there. The Caddy
block for `office.sprogbroen.dk` lives in the **Sprogbroen** repo's git-tracked `infra/Caddyfile`, deployed
by `git checkout <sha>` — editing it on the server breaks their next deploy. Join code + admin key:
`server/data/online-office-credentials.txt` (gitignored).

## Verify
`npm run test:online-office --prefix server` (client ↔ fake relay, real git repos, real ThreadManager) and
`test:relay-core` (routing, fake peers) — both free. `npm run office-lab --prefix server` drives Join →
roster → cross-machine room → the directors' room (a real relay round trip, both directions) → Leave
headlessly, against its OWN throwaway console and relay, never prod. A relay change also needs
`relay/deploy.sh` run from a clean `git archive` export — the console half alone changes nothing.
