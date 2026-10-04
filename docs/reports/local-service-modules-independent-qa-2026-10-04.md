# Local service modules: independent deployment QA

The migration's browser behavior and live deployment pass this review's focused
checks. The overall tree **does not pass QA** because `test:calendar` reproducibly
fails its every-five-minutes schedule collapse assertion. Calendar code and its
test match the integration base; the separate Calendar task owns that repair.
No owner decision or external dependency is needed to resolve this gate.

## Deployment and checks

The reviewed Home Assistant response repair and camera-proxy/container-control
changes were rebased onto current master, fast-forwarded and pushed. Live server
build **a6eba134** was confirmed by `npm run deploy --prefix server -- --verify`.
The existing recording worker was preserved rather than restarted; its older-build
badge is expected. Script Hub, Home and Sidekick workers report the current build.

- `npm run build`: passed; deployment rebuilt the integrated server and web.
- `npm run typecheck`: server, web and relay passed after integration.
- `npm run test:modules --prefix server`: 34 checks, three Home Assistant response
  checks and tab visibility checks passed.
- `npm run modules-lab --prefix server`: **74/74 browser checks passed**, using
  isolated server and frontend outputs. Checks cover default-hidden tabs, Settings,
  reload persistence, demand startup, navigation cleanup, all four Stop/Start
  controls, unavailable-worker recovery, recording Off/24/7, recording across a
  GGO restart, recordings playback/download, and phone layouts. Final cleanup left
  no worker or camera process belonging to the lab.
- `npm run privacy:check --prefix server`: passed with the local private-term list.
- `npm run test:readme-claims --prefix server`: 69/69 passed.
- `npm run probe:doc-paths --prefix server`: passed.
- All **229 free gates were exercised**: 98 passed before deployment interrupted
  the full runner; the 131 remaining or failed gates were then run explicitly,
  with 130 passing. Combined coverage is **228/229 passing**, not a green full
  suite. Provider fallback's automatic Codex-burn assertion failed under the first
  run's load and passed on retry. Calendar's daily-collapse check failed twice.

## Live behavior and preserved data

Thirteen read-only checks through the actual HTTPS Deck proxy passed. All four
modules render their migrated data. All **five cameras show decoded pictures**,
with one module socket and zero socket errors on desktop; pictures also arrive on
phone. Every module fits the phone viewport. Home shows one migrated device and
offers **Start Home Assistant** for the existing stopped Docker container.
The review never starts that container, sends a vacuum action, starts a script or
changes Sidekick power. Container discovery and explicit start/deadline behavior
are covered by the focused gate's Docker stand-in.

Local read-only comparisons confirmed that all five cameras retain their
credentials, streams, notes and recording folders, and that the normalized vacuum
configuration matches its original settings. Ten hidden-script preferences remain
in GGO; after migration this list is independent of the old hub's list, so current
equality cannot prove the original import. Sidekick continues to read its tray
settings in place. All four retired module ids are absent from the Deck registry,
which still contains 34 unrelated cards. The owner's five-camera 24/7 recording
remained active throughout this review and deployment.

## Responsiveness

Milliseconds are p50 / p95 / maximum. Lab HTTP/WS phases use 40 observations each;
owner echoes use five and run only against the throwaway instance. The free gate
suite ran concurrently, so these phases are observations, not a causal benchmark.

| Lab phase | HTTP | WebSocket ping | Owner-message echo | Stalls >= 1 second |
| --- | --- | --- | --- | --- |
| Modules idle | 3.6 / 28.3 / 30.9 | 2.5 / 31.1 / 32.3 | 16.4 / 184.2 / 184.2 | 0 |
| Five cameras recording; other modules polling | 2.0 / 9.8 / 21.1 | 1.2 / 8.6 / 13.8 | 2.5 / 57.5 / 57.5 | 0 |

Worker RSS under lab load was 70 MB (Script Hub), 86 MB (Surveillance), 57 MB
(Home) and 64 MB (Sidekick). Fresh hidden tabs created no module folder or workers;
showing tabs alone started no service.

Before deployment, 30 production read-only samples measured HTTP
2.5 / 4.5 / 7.4 ms and WebSocket 1.6 / 4.0 / 7.0 ms, with zero stalls in the
preceding five-minute monitor window. After deployment, the baseline measured
HTTP 2.9 / 46.1 / 73.8 and WebSocket 1.8 / 45.0 / 73.3 ms. Under live module
load, HTTP measured 2.4 / 4.0 / 6.5 and WebSocket 1.8 / 3.0 / 6.0 ms.
Both post-deploy phases' five-minute windows contained the same two stalls,
totaling 5,076 ms, worst 2,565 ms, attributed by the server to SQLite finding
persistence. This is not evidence of zero production stalls or of a module-caused
regression. The separate server-stalls task owns that behavior.

## Deliverables and documentation

Both previously recorded report cards resolve inside the task's claimed worktree,
open locally and return authenticated HTTP 200 with bytes matching their files.
No refused-deliverable warning was found. The design doc, scoped agent rule and
durable memory entry describe the current module locations and service lifecycle;
they are supporting instructions, not owner-facing generated artifacts. Memory
graph validation found no errors. This report is this review's new deliverable.

## Remaining issue

`server/src/tests/calendar.test.ts:486` fails:
"an every-5-minutes schedule collapses to one item a day". The assertion requires
every collapsed occurrence to be all-day with a count, with at least seven days
returned. Repair or explicitly resolve this gate with the Calendar task before
acceptance. This review changed its backlog records and produced this report;
another QA pass must inspect those changes.
