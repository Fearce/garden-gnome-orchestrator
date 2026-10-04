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
