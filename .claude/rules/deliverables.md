# Deliverables (the owner-facing file cards): the traps, not the tour

Read before touching `web/src/threadDeliverables.ts`, the `threadDeliverables` slice in
`web/src/store.ts`, `web/src/components/Deliverables.tsx`, the `/api/deliverable/:id` route in
`server/src/index.ts`, `server/src/orchestrator/deliverableCheck.ts`, or the `post_deliverable` tool in
`server/src/bus/busServer.ts`. CLAUDE.md § "Deliverables" has the shape; this is what bites.
Related: `add-a-message-kind.md` (the feed retention this surface must NOT inherit),
`office-bridge.md` (the CLI `DELIVERABLE:` marker), `qa-fixes-mode.md` (the QA backstop).

## The one thing to keep true
**A deliverable is durable task DATA, not a transcript row.** Every other feed item is disposable
scrollback; a deliverable carries an owner-addressable View/Download/Copy-path action, and the owner
comes back for it days later. That single difference is the source of both classes of bug below.

## Console side
- **Never derive the cards from the feed.** That was the 2026-09-14 "deliverables are missing" report
  (`44a479e`): `ThreadDetail` read them out of the activity feed, which `capFeed`/`PER_RUN_CAP` trims
  per run, so a long task silently evicted its OWN older deliverable cards while the DB row, the WS
  serialization and the route were all perfectly healthy. The generalization is worth more than the
  fix: **any durable owner-facing surface computed from the capped feed inherits the cap**, and the
  symptom is always "it worked, then it vanished on a long task" with nothing broken server-side.
  `threadDeliverables` is a separate, deliberately UNCAPPED per-thread index for exactly this reason.
- **Merge by finding id across all three arrival paths, never replace.** A card reaches the store from
  `hello` (a BOUNDED board snapshot), from `thread.history` (paginated), and live from `finding`. A
  reconnect's `hello` lands while the open task's history reply is still in flight, so assigning rather
  than merging wipes the full index back down to the snapshot. Same hazard in reverse: a history reply
  can race a just-streamed card and must not erase it.
- **A new per-thread slice owes both `drop()` cleanups** (`thread.removed`, `thread.reset`) and an
  entry in the initial state, exactly like the feed slices next to it.

## Emission side (where cards are born broken)
The route re-derives the path from `findings.path` plus the owning task's workspace on EVERY click, so
a card that renders proves nothing about whether it serves. Three ways agents get this wrong, all three
measured in the live store on 2026-09-14 (32 of 268 cards already dead):
- **Pass an ABSOLUTE path inside the workspace.** A relative path resolves against the task WORKSPACE,
  which here is routinely the PARENT of the git checkout, so a file saved into the repo 404s.
- **The agent's own scratch area is outside every workspace by construction.** Surfacing a screenshot
  straight out of `…\Temp\claude\…\scratchpad\` produces a card that 403s from the instant it is
  posted, and it was the single largest class found. Copy the file into the workspace first.
- **The serving cap is 25 MB.** A build zip over it renders a card whose download 413s.

## The security boundary is not negotiable
`/api/deliverable/:id` is auth-gated, resolves symlinks on BOTH sides before comparing, rejects any
`..`/absolute/cross-drive escape, serves files only, and caps at 25 MB. The path is agent-supplied and
the server is LAN-reachable, so a change that relaxes any of those is a vulnerability, not a fix. If a
legitimate file is refused, move the file, never the fence.

## Verify
```
npm run test:deliverables --prefix server         # the store index: merge, cap-independence, cleanup
npm run test:deliverables-probe --prefix server   # the probe's classifier and its red/amber policy
npm run probe:deliverables --prefix server        # read-only census of the LIVE store: which cards are dead
```
`probe:deliverables` mirrors the route check for check, so its class IS the HTTP status the owner would
get; keep the two in step when either moves. It is red only for a card that was born broken (no path,
no task row, or a workspace escape inside the last 7 days) and amber for a file that has since gone
away, because the owner deleting an old screenshot is housekeeping and a permanently red probe stops
being read.

Browser proof of View/Download/Copy-path is `npm run deliverables-lab --prefix server` (add
`-- --shots <dir>` to keep the pictures). It boots its OWN throwaway instance, seeds a task with real
files on disk, and for each card hovers the chip, opens the preview, diffs the downloaded bytes against
the file, GETs the route directly, and checks the copied path. Never drive prod for this: the real
detail panel is usually live-streaming, and its sticky-to-bottom autoscroll fights hover and click
timing, which is what made two agents hand-roll a seeded instance before this lab existed.

One trap the lab had to design around, which is app behaviour rather than a bug: the popover shows on
`:hover` OR `:focus-within`, so clicking one card's Download leaves that popover open on focus, and it
can then overlap a neighbour's. Finish one card's whole round before moving to the next.
