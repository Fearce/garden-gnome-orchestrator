---
paths:
  - "web/src/components/BetaWorkshop.tsx"
  - "web/src/components/BetaGnome.tsx"
  - "web/src/lib/workshopStage.ts"
  - "web/src/lib/workshopMotion.ts"
  - "web/src/lib/betaGnomes.ts"
  - "web/src/beta-gnomes.css"
  - "web/src/old-gnomes.css"
  - "web/scripts/*gnome*"
  - "web/scripts/*workshop*"
---

# The beta workshop header (depth stage + stop-motion clock)

The header gnome strip under Beta gnomes (and Old gnomes beta, which reuses `BetaWorkshop` with the classic
art). Read this before changing how gnomes are chosen, placed, walked or animated.

## The depth stage — `web/src/lib/workshopStage.ts` (pure, unit-gated)
- **Own gnomes are never hidden.** `stageCast` takes every own gnome (director + local workers + frozen
  workers last), then visitors only while `stageCapacity(...).comfortable` has room. There is no "+N"
  overflow badge on the beta stage; a dense crowd stands closer and smaller (`CROWD_SLOT` → `CROWD_MIN_SLOT`)
  instead. Never reintroduce a cap on own gnomes to make room for visitors.
- **Three lanes** (`STAGE_DEPTHS`): 0 is the labelled front, 1 and 2 stand higher on the floor, smaller and
  dimmer (`.beta-actor[data-depth]` filter). Front capacity shrinks as the crowd grows, so labels never
  sit over a gnome.
- **Lanes follow recency** (`assignDepths`, keyed on `lastSpoken` over office chat): quiet `FRONT_IDLE_MS`
  (3 min) steps back a lane, `MID_IDLE_MS` (15 min) joins the back row, a full lane pushes its stalest
  member back. A move made for age or freed room waits out `DEPTH_DWELL_MS` (25 s) so nobody jitters; a new
  message and a full front never wait. A visitor paired with a local teammate stands in that teammate's
  lane. `assignDepths` is pure: feed it the previous call's memory, never mutate it.
- **Speaking walks to the front** with the bubble shown on arrival; speech bubbles sit above every lane.
  Gate: `npm run test:workshop-stage --prefix server` (`web/scripts/workshop-stage.test.ts`).

## Motion — transforms only, never a React render per frame
- A lane change is a CSS transition on `.beta-actor` (`--walk-ms` from `walkDuration`), plus a WAAPI stride
  (`workshopMotion.ts`, composite "add") and `bridgeJourney` so the 12 s rendezvous loop doesn't jump.
  Reduced motion and paused/hidden workshops switch transitions off (`fadeIn` instead of a walk).
- Lanes 1–2 drop their bench motion (`.beta-actor:not([data-depth="0"]) svg * { animation: none }`):
  too small to read, and each moving part costs.

## The stop-motion clock — `betaGnomes.ts` `observeGnomeMotion`
- Every root it observes gets `data-motion-clock`, whose CSS pauses all loop animations under it; one
  shared `setInterval` (`GNOME_MOTION_FPS` = 5) seeks each root's `CSSAnimation`s to the clock time. The
  owner chose a light console over smooth gnomes (2026-10-02). WAAPI walks and CSS transitions are not
  `CSSAnimation`s, so walks stay smooth.
- **Seek animations; never drive the clock through an inherited CSS variable.** A `--gnome-clock` in every
  `animation-delay` was measured at ~25 ms of style recalc per tick (it re-styles all ~500 descendants)
  against ~3 ms for `animation.currentTime = t` (only the ~170 animated targets). With 24 gnomes the seek
  clock holds 150/150 frames at p95 17 ms on this box.
- **A browser gate that seeks animations and reads positions in a LATER call must hold the clock**, or a
  tick lands between them and snaps the seek back (a flaky "Gnome walks toward its teammate"). Use the
  gates' `holdClock(page, true/false)`, which sets the root's `data-paused` exactly as an off-screen
  workshop is paused. A seek and read inside one synchronous `evaluate` needs no hold.

## Browser gates
`node web/scripts/{beta-gnomes,classic-workshop,frozen-gnomes}.browser.cjs <base>`. `:4317` serves
master's build; for unbuilt web code run `npx vite --port 4391 --strictPort` in `web/` (it proxies to
`:4317`) and pass `http://127.0.0.1:4391`.
