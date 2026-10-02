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

# The beta workshop header (depth stage + motion clock)

The header gnome strip under Beta gnomes (and Old gnomes beta, which reuses `BetaWorkshop` with the classic
art). Read this before changing how gnomes are chosen, placed, walked or animated.

## The depth stage — `web/src/lib/workshopStage.ts` (pure, unit-gated)
- **Own gnomes are never hidden.** `stageCast` takes every own gnome (director + local workers + frozen
  workers last), then visitors only while `stageCapacity(...).comfortable` has room. There is no "+N"
  overflow badge on the beta stage; a dense crowd stands closer and smaller (`CROWD_SLOT` → `CROWD_MIN_SLOT`)
  instead. Never reintroduce a cap on own gnomes to make room for visitors.
- **The director keeps a post at the left edge** (owner, 2026-10-02: "all the way to the left and should not
  scale in size"). `stageCast` lists our own director first (`holdsPost`), `assignDepths` keeps a `pinned`
  entry in front without letting it stand in for the freshest worker, and `stageLayout` stands it at full
  size, unpaired and still, then lays everyone else out (`floorLayout`) on the floor to the right of its
  label. Below `POST_LABEL_STAGE` (360 px) its label shows only on hover (`data-label="hover"`), so a
  narrow stage keeps its floor for the crowd. `data-post` stops the walk loop in CSS.
- **The director's pose follows AFK time** (`directorRest.ts`): standing while busy and for
  `DIRECTOR_CHAIR_MS` (30 min) after, a chair until `DIRECTOR_BEDTIME_MS` (4 h), then the bed.
  `useDirectorRest` sets one timer per threshold. The clock is the server's `director_idle_since`; a
  skip-director send is not director work and never resets it, across restarts too (the boot reads the
  saved clock, not the feed's newest message).
- **A roomy stage spaces everyone evenly** (owner, 2026-10-02: "when there's free space the gnomes should
  space out more evenly"). `evenStage` stands every group (a pair counts as one; front groups include their
  labels) in floor order with equal air between neighbours and at both ends, over the WHOLE stage width,
  whenever that air is at least `EVEN_AIR` (right of the director's post). A lone gnome stands centre stage. There is no small-crew floor
  cap any more (the old `CREW_PITCH` huddled a few gnomes at the left with the right half empty). A solo
  front gnome whose only crowd neighbour is on its right carries its label on the left, so its stroll
  crosses open floor instead of its own label. Only a stage too full for `EVEN_AIR` falls back to the
  layered layout below.
- **Three lanes on one floor** (`STAGE_DEPTHS`): 0 is the labelled front, 1 and 2 stand higher on the
  floor, smaller and dimmer (`.beta-actor[data-depth]` filter). The lanes are NOT separate strips: front
  groups (a pair counts as one) spread evenly over the floor, and the crowd fills the floor the front
  bodies leave free, behind and between them (behind labels too, never behind a body). Within one crowd
  lane each group stands at least `CROWD_MIN_SLOT` right of the previous one (`standCrowd`), so no gnome
  lands between a pair; a lane too full for that squeezes its gaps and pair walks (`fit`, refitted until
  it stops running off the floor) instead of piling gnomes on one spot.
- **Depth reads from occlusion, not size alone** (owner, 2026-10-02: "big and small gnomes, not
  3-dimensional"). Each loop strolls a front gnome up to `STROLL[0]` px toward the side where it passes the
  most crowd gnomes, so it walks in front of them, and further (`passingStroll`, up to `FRONT_STROLL_MAX`)
  when the nearest crowd gnome stands beyond that amble. A stroller that still clears nobody takes the nearest
  crowd gnome ahead as its escort (`escortsFor`): it walks toward the front gnome on the SAME beat (shared
  `delay`), covering its scale's share of the front's reach, so the two cross mid-walk. Only a very sparse,
  very wide stage (four gnomes on ~1100 px) has more air than that amble can cross. Further lanes stroll less (parallax), and a crowd pair
  too far apart to meet within its lane's stroll is unpaired. Front strolls never reach a front
  neighbour's label. Front labels are `pointer-events: none` so a crowd gnome behind one stays clickable.
- **Hit-test the figure, not the box.** `.beta-actor`, `.beta-workstation` and everything inside are
  `pointer-events: none`; only the workstation's `::before` (the figure's core, `inset: 6% 18% 0`; the
  whole box for a resting director) takes the pointer. The 32×48 box and the full-box tool SVG reach past
  the art, and as targets they buried 4–6 visible crowd gnomes per stage. Hovering lifts a gnome to z 60.
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

## The motion clock — `betaGnomes.ts` `observeGnomeMotion`
- Every root it observes gets `data-motion-clock`, whose CSS pauses all loop animations under it; one
  shared `setInterval` (`GNOME_MOTION_FPS` = 24) seeks each root's `CSSAnimation`s to the clock time. 5 fps
  read as lag to the owner (2026-10-02). Measured on a production build, 24 gnomes, main-thread ms per
  2.5 s: 5 fps ~820, 24 fps ~1055, 30 fps ~1240, free-running 60 fps ~1640; all held 60 fps frames. WAAPI walks and CSS transitions are not
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
