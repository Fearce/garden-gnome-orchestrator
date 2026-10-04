# Local service tabs: migration and performance evidence

Script Hub, Surveillance, Home and Sidekick moved from the Script Hub tablet deck into four optional GGO
tabs on 2026-10-04 (design: [`../local-service-modules.md`](../local-service-modules.md)). This records what
was measured before and after the change, on the live console and on an isolated lab instance.

All latencies are milliseconds, `p50 / p95 / max` over 40 samples (owner messages: 5), taken with
`npm run probe:module-latency --prefix server` (live, read-only) or by `npm run modules-lab --prefix server`
(isolated instance, same sampler). "Event loop" is GGO's own stall monitor over the preceding 300 s.

## Live console

| When | HTTP `/api/me` | WebSocket ping | Event loop |
| --- | --- | --- | --- |
| Before the deploy (build `101592a0`, no module code) | 2.4 / 4.5 / 4.9 | 1.7 / 3.6 / 4.1 | 0 stalls |
| After the deploy, every tab hidden (build `ec829269`) | 2.1 / 3.8 / 4.4 | 1.6 / 2.2 / 2.4 | 0 stalls |
| After, under module load | 1.7 / 3.8 / 6.2 | 1.0 / 1.6 / 2.8 | 0 stalls |

Module load on the live console: all four tabs open in a headless browser, five cameras streaming frames
to it over the module socket (23 frames in 6 s), and the Script Hub, Home and Sidekick APIs each read once a
second. Owner messages are not sampled live, because each one is a real message to the Director.

## Isolated lab instance

| Phase | HTTP `/api/me` | WebSocket ping | Owner message echo | Event loop |
| --- | --- | --- | --- | --- |
| Every module idle | 2.2 / 4.4 / 5.0 | 1.7 / 4.5 / 6.0 | 1.5 / 3.1 / 3.1 | 0 stalls |
| Recording five cameras, frames streaming, three modules polled | 2.0 / 4.9 / 5.1 | 1.2 / 3.9 / 4.4 | 1.8 / 3.2 / 3.2 | 0 stalls |

The lab run passed 42 of 42 browser checks.

## Resources

| Worker | Resident memory | Notes |
| --- | --- | --- |
| Script Hub | 71–75 MB | First paint 1.05 s from a cold worker, 287 scripts listed |
| Surveillance | 91 MB idle, 108 MB recording five cameras | First live picture 6.6 s from a cold worker |
| Home | 58 MB | |
| Sidekick | 66–76 MB | |

Each worker is a separate process outside GGO's process tree; GGO's own process does none of this work.

## With the tabs hidden

On the live console after the deploy, before any tab was opened: `GET /api/modules/services` reported all
four modules `stopped`, no `server/data/modules` folder existed, and no worker or ffmpeg process was running.
Showing the four tabs (Settings, then a reload) still started nothing. On another tab, the page made no
`/api/modules/` request for 15 s, and leaving Surveillance closed its frame socket.

## Migration

The first live use imported the Deck's settings: five cameras with their streams, credentials, layout and
recording quality (recording stopped), one robot vacuum with its Home Assistant entity and miIO details, and
the hidden-scripts list. Sidekick's three rules are read in place from the tray app's own settings file.
No camera password or device token appeared in any API response the browser received.

Home Assistant was not running on the machine during these checks, so Home showed its outage notice and
disabled the controls of the vacuum bridged through it. That is the unavailable-upstream path working, not a
migration gap.

## Editing QA verification

The independent review passed 43 browser checks, including an actual GGO restart while five cameras
recorded: the same Surveillance worker kept recording, and explicit Stop ended it. The Sidekick cancel
check now compares its real settings revision. Local comparisons confirmed camera ids and passwords,
the recording folder, device tokens and hidden-script preferences were retained. The evidence card
served this report with bytes matching the file in the task workspace.

QA fixed three runtime gaps: an unavailable first Deck import now fails without saving defaults,
device notes mask and restore miIO tokens, and GGO's camera relay bounds queued frames for slow browsers.
The focused module gate passed 25 checks plus tab visibility; typechecks and the privacy guard passed.
The full suite passed 226 of 228 gates before the normal build existed; after `npm run build`, the two
build-dependent gates (`test:doc-paths` and `test:park-classify`) passed on the targeted rerun.

The final isolated browser run sampled these results while the free gate suite also ran on the machine:

| Phase | HTTP | WebSocket ping | Owner message echo | Event-loop stalls |
| --- | --- | --- | --- | --- |
| Modules idle | 2.0 / 3.8 / 70.6 | 1.6 / 4.4 / 70.1 | 17.1 / 93.4 / 93.4 | 0 |
| Recording five cameras and polling three modules | 1.9 / 3.1 / 3.4 | 1.0 / 1.8 / 2.3 | 15.5 / 29.7 / 29.7 | 0 |

Worker resident memory under that load was 72 MB (Script Hub), 92 MB (Surveillance), 57 MB (Home) and
76 MB (Sidekick). All workers and camera processes stopped at the end of the lab.

The fixes were pushed as `6970c5e0` and verified in live build `a628a671`. The live browser passed 12
integration/mobile/lifecycle assertions, following separate default-hidden, Settings and reload checks.
Its first camera open exceeded the worker's 20-second startup window and showed a service error; reopening
the tab after the worker became healthy displayed the cameras. No persistent work was started.

Under live module load, 40 samples measured HTTP 2.2 / 49.4 / 264.3 ms and WebSocket ping
1.7 / 49.5 / 263.8 ms. GGO reported zero event-loop stalls in the preceding five minutes; that monitor
counts stalls of at least one second. Owner messages were sampled only in the isolated lab.

## 24/7 recording, recording options and recordings browser

The owner asked for an always-on option that is clearly off by default, plus recording options. QA round 2
also found that Surveillance and Home could not start without a reachable Script Hub. Both are now built
(design: [`../local-service-modules.md#surveillance-recording`](../local-service-modules.md#surveillance-recording)):

- **Off / 24/7 / Schedule**: one persisted recording mode, Off on every imported and new setup. Turning
  it on writes `armed.json` before the mode is saved, so the supervisor restarts the worker after an idle
  exit, a GGO deploy or a reboot. A recording worker refuses a plain stop.
- **Options**: per-camera record switch, file length, a weekly schedule, keep-days and a per-camera size
  cap. Both limits default to keep everything. Deletion is bounded (400 files per sweep), matches only the
  recorder's own segment names, and never touches the newest or a recently written file.
- **Recordings browser**: by camera and day, playing through an on-demand MP4 copy (`-c copy`), with MP4
  and original downloads. All of it goes through the authenticated module proxy. Segment names are checked
  against the recorder's pattern and resolved only inside the configured folders. The proxy now forwards
  the raw, percent-encoded path, so an encoded `..` reaches that check and gets a 400.
- **No Script Hub**: a refused connection starts the worker with an empty setup and saves nothing.
  The first save, or a later status read once the hub answers, does the import. A timeout or a hub error
  still blocks the start, so a pending import is never overwritten with defaults.

The module gate now passes 32 checks. The isolated lab passed 58 browser checks, desktop and phone:
- recording is off at import and survives a save;
- 24/7 survives a GGO restart;
- a segment lists, plays (first frame in 644 ms on the earlier run) and downloads as a 206 attachment;
- a traversal is refused;
- Off asks for confirmation and stops every camera;
- Home shows the "not answering" notice without a hub;
- nothing overflows at phone width;
- Stop leaves no process behind.

| Phase | HTTP | WebSocket ping | Owner message echo | Event-loop stalls |
| --- | --- | --- | --- | --- |
| Modules idle | 2.4 / 5.4 / 26.2 | 1.8 / 3.9 / 20.2 | 2.6 / 17.9 / 17.9 | 0 |
| Recording five cameras 24/7 and polling three modules | 2.0 / 5.2 / 5.2 | 1.0 / 2.0 / 2.8 | 4.3 / 405.5 / 405.5 | 0 |

One of the five loaded owner-message samples took 405 ms. The other four stayed under 5 ms. The sampler
does not attribute that delay, and the stall monitor counts blocks of at least one second, so its zero
count cannot rule out a shorter event-loop pause. The earlier run measured 80 ms max for the same phase.
Worker memory: 72 MB (Script Hub), 79 MB
(Surveillance, recording 5 cameras), 56 MB (Home), 56 MB (Sidekick).

### Live, build 24dfe20f

The owner had started recording on the previous build, with five cameras, before modes existed. The
worker was restarted onto the new build with the supervisor restart, which keeps the armed marker. It
logged "a recording started before recording modes existed is kept going as 24/7 recording" and resumed
all five cameras after about three seconds. The gate now covers that path as well.

A live headless browser run passed 14 checks on desktop and phone without changing the mode or any
setting:
- the plan reads "Recording 24/7 · 5 of 5 cameras" with 24/7 selected;
- the settings dialog offers five record switches (all on), seven schedule days, a file length, an empty
  keep-days field ("Keep everything") and an empty size cap;
- the browser lists all five cameras, and a real recorded segment played in 113 ms;
- the MP4 download is a 206 attachment;
- an encoded traversal gets 400 and a request without a login is refused;
- both views fit a phone;
- afterwards all five cameras were still recording.

A direct read returned a live JPEG for each camera, under 0.5 s old.

The run's 40 HTTP and WebSocket samples measured 2.6 / 9.4 / 1603.9 and 2.1 / 8.9 / 1603.4 ms. GGO's
monitor recorded two event-loop blocks in that five-minute window, worst 4.8 s, both blamed on
`ThreadManager.liveAgentThreads` reading the threads table during the post-deploy agent resume. Module
traffic runs in the worker processes and was not involved.

## Independent QA: explicit service Stop

The open Sidekick view restarted its worker on the next poll after the header's Stop; a browser
reproduction found it running again after 13 seconds. The shared module frame now unmounts the view
before stopping its worker and offers an explicit Start. Home's request hooks now live inside that
view boundary. Script Hub's delayed action refreshes are cancelled on unmount, and closed or hidden
poll hooks refuse refreshes from callbacks that finish later.

The expanded isolated browser lab passed **72/72 checks**. For each of the four tabs, it clicks Stop,
waits 16 seconds (past the view poll), verifies the worker remains stopped and no view requests leave
the browser, then clicks Start and verifies the view returns. Phone Surveillance repeats Stop/Start
and confirms recording remains Off. The other checks cover default-hidden services, Settings and
reloads, migration, live frames, 24/7 across a GGO restart, playback/download, navigation cleanup and
unavailable-service recovery. All lab workers and ffmpeg children were gone afterwards.

| Phase | HTTP | WebSocket ping | Owner message echo | Stalls of at least 1 s |
| --- | --- | --- | --- | --- |
| Modules idle | 2.4 / 4.3 / 4.5 | 1.7 / 5.2 / 7.0 | 14.4 / 19.4 / 19.4 | 0 |
| Recording five cameras and polling three modules | 2.3 / 4.6 / 6.1 | 1.5 / 3.8 / 5.1 | 2.5 / 17.2 / 17.2 | 0 |

Worker memory under load: 69 MB (Script Hub), 76 MB (Surveillance), 58 MB (Home), 66 MB (Sidekick).
The live read-only sample before the frontend fix, with the owner's recording continuing, measured
HTTP 2.3 / 3.8 / 25.1 ms and WebSocket 1.6 / 3.1 / 24.9 ms, with zero stalls of at least one second.

Verification: build; server/web/relay typechecks; 228/228 free gates; 32 module checks and tab visibility;
lazy-chunk checks; privacy guard; README 65/65. Read-only local comparisons confirmed all five cameras'
credentials, streams, folders and notes, the vacuum configuration and hidden-script preferences were
preserved. The report's existing deliverable card returned HTTP 200 with matching file bytes; the
design doc, agent rule and shared-memory entry are supporting files rather than owner-facing artifacts.

The frontend fix was integrated, pushed and built from `58e13ef5`. A live desktop/phone browser run
passed **24/24 checks**: Script Hub, Home and Sidekick each stayed stopped without view traffic and
reopened through Start; settings enabled and disabled all four tabs across reloads; disabling the open
Surveillance view closed its traffic; five cameras displayed pictures; a real segment played and
downloaded with HTTP range support. The owner's 24/7 recording remained in the same worker throughout.
Under live module load, HTTP measured 2.2 / 3.7 / 28.1 ms and WebSocket 1.7 / 2.6 / 27.3 ms, with
zero stalls of at least one second. The served entry matched the frontend stamped `58e13ef5`.

### Concurrent Sidekick rule saves

Five isolated trials found another data-loss path: two saves from the same settings revision both
returned success, but only one new rule remained. Sidekick now serializes the whole read/revision-check/
write operation per settings file. Regression checks cover concurrent creates, a stale conflict and
retry, preserved unknown settings, and concurrent edits through the authenticated proxy into a real
worker: one response is 200 and the other is 409, then the refreshed edit succeeds. The focused module
gate passes 33 checks plus tab visibility; server typecheck and privacy guard pass. These tests use
isolated settings and never change the owner's live rules.
