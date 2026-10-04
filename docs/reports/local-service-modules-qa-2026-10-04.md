# Local service modules: editing QA

The review does **not pass**. The reviewed build works in the browser lab, but the
camera-proxy and Home Assistant service controls arrived uncommitted and are absent
from production. This QA committed and pushed its own response-handling repair as
`ed7d8cb3` on the migration branch. Another reviewer must inspect that repair.

## Repair and verification

Home Assistant's bridge now consumes response bodies within the request deadline,
reports a stalled body as HTTP 504 with the unavailable-service flag, and reports
malformed successful JSON as HTTP 502. It consumes rejected-credential responses
before refreshing the login and retrying. Three regression checks exercise those
behaviors against an actual local HTTP server; they run in `test:modules`.

- `npm run build`: passed before the repair; `npm run build --prefix server` passed
  after it. The frontend was also built into an isolated browser-lab directory.
- `npm run typecheck`: server, web and relay passed after the repair.
- `npm run test:modules --prefix server`: 34 module checks, three response checks
  and the tab-visibility checks passed after the repair.
- `npm run privacy:check --prefix server`: passed with the local private-term list.
- `npm run test:readme-claims --prefix server`: 65/65 passed.
- `npm run probe:doc-paths --prefix server`: passed after the frontend build
  finished. The first concurrent invocation had run before its build stamp existed.
- `npm run test:gates --prefix server`: 226/228 passed. Dispatch latency's queue
  ordering check failed under the suite load and passed on a focused retry.
  Calendar's check that every five-minute occurrence collapses into a daily item
  failed again on a focused retry. Calendar files were unchanged by this task and
  match the integration base; its separate task owns that behavior.

The browser lab passed **74/74** using the isolated entry
`data/qa-module-build/index.js`. It covered all four modules, default-hidden tabs,
Settings switches and reloads, on-demand starts, navigation cleanup, explicit
Stop/Start on each open tab, unavailable-worker recovery, camera pictures, recording
Off/24/7, recording surviving a GGO restart, playback/download and phone layouts.
The Home outage offered an explicit Start button without starting the actual
Home Assistant container. Unit checks exercised container discovery and an explicit
Start using a Docker stand-in; this review did not start or stop the owner's
Home Assistant, vacuum, scripts or Sidekick monitoring.

The initial lab scored 71/74 because its process census also counted four workers
from prior runs sharing the standard build-directory name. A unique build path
removed that ambiguity: disabled tabs created no module data, started no workers,
and the final Stop left no processes belonging to that run. Earlier workers and
the owner's existing production recording were left alone.

## Measured responsiveness

All numbers below are milliseconds, shown as p50 / p95 / maximum. HTTP and socket
samples contain 40 observations per lab phase; owner echoes contain five. Owner
messages were sent only to the throwaway lab instance.

| Lab phase | HTTP | WebSocket ping | Owner-message echo | Event-loop stalls >= 1 second |
| --- | --- | --- | --- | --- |
| Modules idle | 2.2 / 4.6 / 5.4 | 1.7 / 4.3 / 7.1 | 17.2 / 18.6 / 18.6 | 0 |
| Five cameras recording; other modules polling | 1.9 / 4.4 / 11.8 | 1.1 / 2.3 / 3.2 | 6.1 / 18.0 / 18.0 | 0 |

Worker RSS under load was 78 MB (Script Hub), 101 MB (Surveillance), 58 MB (Home)
and 68 MB (Sidekick).

Thirty read-only production samples measured HTTP 2.6 / 4.8 / 8.2 ms and socket
2.0 / 4.3 / 7.5 ms. Production's preceding five-minute event-loop window contained
three stalls, totaling 5,009 ms, worst 2,481 ms, attributed by the server to a
tool-message SQLite read. That is not evidence of zero production stalls or a
causal regression from this migration; the separate server-stalls task owns it.

## Production and configuration evidence

A fresh authenticated browser through the Deck proxy displayed five camera tiles
but **zero pictures**, with four WebSocket-related errors. Home displayed the
unavailable-service notice and **no Start Home Assistant button**. Deployment
verification reported live server build `5712fdf2`, while this worktree was then
at `e9ce82a3` with uncommitted runtime changes. No deployment of the QA repair is
claimed. The frontend build stamp correctly reported a dirty source tree.

Read-only comparisons confirmed that all five cameras' credentials, stream URLs,
recording folders and notes match their original settings, and the vacuum's
normalized configuration matches. The current GGO hidden-script list contains ten
entries while the old hub's list is empty; their current equality cannot prove
the original import because the copies are independent after migration. Sidekick
continues to use its existing tray settings. The four retired module ids are
absent from the Deck registry, which still contains 34 unrelated cards.

The existing migration-evidence deliverable was verified: its recorded path opens
inside the task worktree and its authenticated download returns HTTP 200 with
identical file bytes. No refused-deliverable finding was present. The design doc,
agent rule and durable-memory entry are supporting instructions, not owner-facing
artifacts. This QA report is a separate owner-facing deliverable.

## Remaining implementation work

1. Commit the inherited camera-proxy and Home Assistant changes, including the
   untracked `server/src/modules/worker/home/container.ts`. They were preserved
   because QA is instructed to commit only its own hunks. The branch is behind
   the integration base and the dirty worktree prevents an ordinary rebase.
   Rebase, fast-forward the base, push, deploy and verify both owner reports
   through the actual proxy on desktop and phone before claiming completion.
2. Bound Home Assistant container control by a **single overall deadline**.
   Discovery can take two 15-second Docker calls, Start allows 75 seconds, and
   verification repeats discovery. The possible total is 135 seconds, exceeding
   the module proxy's 90-second deadline. The browser can report failure even
   while Docker continues the requested operation. This arrived in the untracked
   implementation file and still needs a focused correction and a cumulative
   deadline regression check before that implementation is committed.
3. Resolve or independently account for the reproducible Calendar gate failure
   with its owning task. Do not report the full gate suite as passing.

These are implementation/verification gaps, not a terminal manual-deployment
handoff and not a request for an owner decision.
