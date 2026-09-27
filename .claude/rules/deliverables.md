---
paths:
  - "web/src/threadDeliverables.ts"
  - "web/src/components/Deliverables.tsx"
  - "web/src/components/DeliverableModal.tsx"
  - "server/src/orchestrator/deliverableCheck.ts"
  - "server/src/bus/busServer.ts"
  - "server/src/index.ts"
  - "server/scripts/*deliverables*.cjs"
---

# Deliverables (the owner-facing file cards): the traps, not the tour

Read before touching `web/src/threadDeliverables.ts`, the `threadDeliverables` slice in
`web/src/store.ts`, `web/src/components/Deliverables.tsx`, the `/api/deliverable/:id` route in
`server/src/index.ts`, `server/src/orchestrator/deliverableCheck.ts`, or the `post_deliverable` tool in
`server/src/bus/busServer.ts`. `docs/agent-reference/CLAUDE-full.md` § "Deliverables" has the shape; this is what bites.
Related: `add-a-message-kind.md` (the feed retention this surface must NOT inherit),
`office-bridge.md` (the CLI `DELIVERABLE:` marker), `qa-fixes-mode.md` (the QA backstop).

## The one thing to keep true
**A deliverable is durable task DATA, not a transcript row.** Every other feed item is disposable
scrollback; a deliverable carries an owner-addressable View/Download/Copy-path action, and the owner
comes back for it days later. That single difference is the source of both classes of bug below.

## Console side
- **Keep the strip OUT of the panel's scrollport, and check WHERE it lands, not just that it rendered.**
  The 2026-09-18 "I still cannot see deliverables" report, third of its kind. `73d2bd5` moved the strip
  from a pinned row into `.detail-body` to stop pinned chrome starving the transcript; `.detail-body`
  sticks to the newest message, so from that commit on the panel OPENED with the strip parked above the
  viewport. Measured on task 6cf6f87c in the live console: `.deliverables` present, `display: flex`,
  expanded, one chip, `y = -13347px`. Every data-layer test stayed green through all of it, because
  none of them can see geometry. That is the generalization worth more than the fix: **a durable
  owner-facing surface is only surfaced if it is REACHABLE, and reachability is a browser assertion.**
  The strip is now a pinned sibling between `.detail-head` and `.detail-body`, and it pays for that
  placement rather than repeating 73d2bd5's bug: `flex: 0 1 auto; min-height: 0` makes it yield like
  the header, `max-height: 22vh` caps it however many cards a task has, and `overflow-y: auto` means
  the cap hides nothing. Gate: `npm run panel-scroll-lab --prefix server`, which now asserts the strip
  is inside the panel and outside the scroller, with its chips, at five viewports x both header states,
  both on open and after scrolling to the end.
- **The popover is `position: fixed` and positioned from JS (`popoverPosition`), not `absolute`.** Once
  the strip clips its own overflow, a 244px card cannot be laid out inside a 47px bar, and `.detail`
  (`overflow: hidden`) plus `.detail-body` were already clipping it in the narrow bands, which is why
  the touch layer had a bottom-sheet override. Coordinates are re-measured on the same `mouseenter` /
  `focus` the stylesheet reveals it on; a never-hovered chip's popover parks at `top: -9999px` so the
  first hover cannot flash it in the window's corner. The no-hover case still returns null and leaves
  the bottom-sheet rule alone. Verify with `npm run deliverables-lab --prefix server`, which drives
  View / Download / Copy-path for real.
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
**Since 2026-09-26 (`3fcfa1c`) emission is fenced by the route's own check.** `post_deliverable` and the
CLI `DELIVERABLE:` bridge both call `resolveDeliverable` in `server/src/orchestrator/deliverablePath.ts`,
the same function `GET /api/deliverable/:id` uses. A path that would 403/404/413 gets no card: the MCP
tool returns the reason with the fix, and the CLI bridge posts a warning finding instead. Change the
fence in that ONE module, never beside it. Cards born broken before that date still sit in the store.
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
npm run smoke:deliverables --prefix server        # "can I see my deliverables?" BOTH halves, one verdict
npm run smoke:deliverables --prefix server -- --task 6cf6f87c   # one task, by id prefix or title
npm run test:deliverables --prefix server         # the store index: merge, cap-independence, cleanup
npm run test:deliverables-probe --prefix server   # the probe's classifier and its red/amber policy
npm run probe:deliverables --prefix server        # read-only census of the LIVE store: which cards are dead
npm run panel-scroll-lab --prefix server          # the PLACEMENT gate: is the strip actually on screen
```
**Reach for `smoke:deliverables` first on any "I cannot see deliverables" report.** It exists because
that sentence has two independent halves and each round of this bug was a different one: the DATA half
(are there rows, would the route serve them) and the PLACEMENT half (does the console put the strip
where a human can see it). A probe for either is blind to the other, which is exactly how 2026-09-14's
fix could be correct and complete and leave the owner reporting the same sentence a month later. It
composes the two rather than restating them: the classifier and the whole red/amber policy come from
`probe-deliverables.cjs`, the geometry comes from `panel-scroll-lab.cjs`. Keep it that way. Deciding
"is this card broken" a second time locally is how a check goes permanently red over years of history
and stops being read.
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
