# Local service tabs

Four optional board tabs host integrations with services on this machine: **Script Hub**, **Surveillance**,
**Home** and **Sidekick**. They replace the cards that used to live on a separate Script Hub tablet deck, so
one console covers agents and the machine's own services.

## Turning a tab on

Settings → **Interface** → **Local service tabs** has one switch per tab. All four are off by default. The
choice is stored in the browser (`director_settings.shownModuleTabs` in `localStorage`), so a phone and a
desktop can show different tabs. A shown tab joins the board header and the phone's **All areas** menu.

Showing a tab starts nothing. A module's service starts the first time the tab asks it for data.

## How a module runs

Each module runs in its own **worker process** (`server/src/modules/worker/main.ts <module>`), owned by
`ModuleSupervisor` (`server/src/modules/supervisor.ts`). This boundary keeps the console's event loop
clear of camera decoding, process enumeration, script control and device I/O. A crashed or hung worker
cannot stall owner chat or task execution.

- **Started on demand.** The first request that needs the module starts its worker; concurrent first
  requests share one start. A `worker.lock` file guarantees one worker per module, even across two GGO
  processes that share a data folder.
- **Outside GGO's process tree.** The spawn runs on a worker thread through a short-lived launcher, so
  Windows' slow `CreateProcess` never blocks the console. A GGO restart or deploy therefore leaves the
  worker, and any recording it holds, running.
- **Loopback only, token-guarded.** A worker listens on `127.0.0.1` on a random port and refuses any
  request without its per-start token (`worker.json`). Its environment is GGO's minus every
  credential-looking variable.
- **Reached through GGO.** The browser calls `/api/modules/<module>/api/*`, which GGO proxies with a
  timeout after checking the session cookie and refusing cross-site requests. The path goes to the worker
  still percent-encoded, cut from the raw URL, so an encoded `/` or `\` in an id or file name can never
  turn into a separator on the worker side. Live streams use
  `/api/modules/<module>/stream` with a single-use ticket from `/api/modules/<module>/ticket`, because a
  WebSocket handshake ignores CORS. On that handshake the ticket is the cross-site guard: Chromium sends
  no `Sec-Fetch-Site` there, and the Dashboard Deck's `/orchestrator/` proxy rewrites `Host`, so the
  Origin-vs-Host fallback used for ordinary requests would refuse the owner's own cameras behind it. A
  handshake the browser does name cross-site is still refused.
- **Idles out.** A worker exits after 10 minutes without a request, an open stream or user-started work.
- **Visible.** The tab header shows the worker's state, pid and memory, with **Restart** and **Stop**.
  `GET /api/modules/services` lists all four. A worker still running code from an older GGO build says
  so and offers a restart. A busy worker is never replaced automatically.
- **Recovered.** If a worker dies, the next request starts a fresh one. A request to an unreachable
  upstream (Home Assistant down, Script Hub stopped) answers `503` with the reason. The tab shows it and
  the rest of GGO is unaffected.

### View lifecycle

Polling runs only while its tab is visible and the browser page is in the foreground. Leaving a tab stops
its polling and closes its frame socket and log streams, except when Surveillance motion notifications
are enabled: their shared picture socket stays open while the console is open, including other board tabs.

The header's **Stop** also closes the open view's polling and streams, so they cannot start the worker
again on their next tick. **Start** reopens that view. Opening the tab again starts its worker on demand;
it does not restart recording that was explicitly stopped.

### Work you start

Only an explicit choice starts continuous work, and only an explicit choice ends it. Today that is one
choice: Surveillance's recording mode, **Off · 24/7 · Schedule** (see [Surveillance recording](#surveillance-recording)).
It is **Off** by default, also for imported cameras: nothing records and no camera is contacted except
for the live pictures of an open tab or explicitly enabled motion notifications in an open console.

- 24/7 or Schedule keeps running when you leave the tab, close the browser, restart or deploy GGO, or
  reboot. The mode is stored in Surveillance's `config.json`, and while it is on the worker keeps
  `armed.json`. While that file exists GGO checks the worker every minute and starts it again if it died.
- **Off** (with a confirmation) stops every camera and deletes `armed.json`.
- The header's plain **Stop** refuses a worker that holds a plan (`409`). **Stop anyway** (after its own
  confirmation) ends the plan for good: GGO deletes `armed.json` as it stops the worker, and the worker's
  next start finds the mode on but the marker gone, so it sets the mode back to Off. **Restart** keeps the
  plan. Turning a plan on writes the marker before the mode is saved, so a crash in between cannot be
  mistaken for Stop anyway.

## Data and migration

Each module keeps its state under `<DATA_DIR>/modules/<module>/`, which is gitignored with the rest of
`server/data/`:

| File | Contents |
| --- | --- |
| `config.json` | The module's settings: cameras, devices, hidden scripts, Surveillance's recording mode and options. |
| `worker.json`, `worker.lock` | The running worker's pid, port and token, and its single-instance lock. |
| `worker.log` (+ `worker.log.1`) | The worker's log. It moves to `.1` past 4 MB, and ffmpeg output is capped per camera. |
| `armed.json` | Present only while recording is set to 24/7 or Schedule. |
| `playback/` | Surveillance only: MP4 copies of played segments, at most 1 GB, oldest dropped first. Safe to delete. |

**First use imports the Deck's settings.** When `config.json` is missing, the worker reads the matching
section from the Script Hub at `SCRIPT_HUB_URL` (`GET /api/settings/<section>`, default
`http://127.0.0.1:3939`) and saves it:

| Module | Deck section | Carried over |
| --- | --- | --- |
| Script Hub | `hiddenScripts` | Which scripts you hid. |
| Surveillance | `surveillance` | Every camera and its streams, snapshot URL, credentials, layout and recording quality; the recording folder. Recording starts **Off**, even if the Deck was recording, and keeps every file (no retention) until you set one. |
| Home | `home-control` | Home Assistant URL and config folder, each vacuum with its entities, miIO host and token. |
| Sidekick | none | Sidekick's rules stay in the tray app's own `settings.json` and are edited in place, so nothing is copied. |

A hub without that section (`404`) counts as nothing to import. A hub that answers with a server error or
times out fails the start visibly and writes nothing, so a pending import is never replaced by an empty
setup. A machine with **no Script Hub at all** (the connection is refused) starts Surveillance and Home
empty, with `origin: "deck-unreachable"` and a notice that nothing was imported, but still writes
nothing: if the hub is running at the next worker start, the import happens then. Script Hub's tab
treats it the same way for its hidden-scripts list, and retries the import on each status read until the
list is saved. Your first save writes
`config.json` with `origin: "new"`, and from then on the hub is never asked again. To redo an import,
stop the module's service, delete its `config.json` and open the tab again.

**Secrets stay on the server.** Camera passwords, credentials inside stream URLs, miIO tokens and the
Home Assistant token never reach the browser: the API shows `********`, and saving a form with the mask
keeps the stored value. A vacuum's notes mask its miIO token too. A camera's notes get the same treatment: its password, its URL passwords and any
`scheme://user:pass@` password written into the notes show as the mask and are put back on save.

## The four modules

- **Script Hub** talks to the Script Hub service at `SCRIPT_HUB_URL`. It covers the script list with
  search, tag, status and visibility filters; Start, Stop and Keep Alive; notes; and a live log tail.
  The worker trims and gzips the hub's large status payload. Hidden scripts and organization overrides
  are stored in GGO. **Organize** edits management (My app or Agent-managed) and up
  to 20 tags per script. Explicit registry `agentManaged` metadata takes precedence over the legacy
  owner convention; a saved local edit takes precedence over both. Tags are searchable, filterable
  and clickable. Sorting offers name or recovery first. Organization never
  changes the upstream runtime category, Keep Alive or start/stop behavior. `PUT /organization`
  accepts a reviewed `{scripts: {id: {management, tags}}}` audit atomically; unknown ids or
  invalid labels reject the whole audit. Per-card saves use `PUT /scripts/:id/organization`.
- **Surveillance** shows live camera tiles, records, plays recordings back, and edits and discovers
  cameras. A camera with a snapshot URL is polled at its own refresh interval. A stream-only camera gets
  one on-demand ffmpeg preview, or the recorder's own frames while recording. Reolink privacy mode can be
  toggled. The module needs ffmpeg for recording, stream-only previews and playback: a path set under
  Recording settings, else the copy GGO installed for Remote control, else one on `PATH`.
  Each camera has **Notifications on/off**, saved in its configuration and off by default.
  Camera settings also save **Motion sensitivity** per camera: Low requires stronger changes across
  more of the picture to reduce false alerts, Medium preserves the original thresholds, and High
  detects smaller movements. Choose a level and **Save camera** to apply it to monitoring immediately.
  Enabled cameras detect changes in a 32-by-24 luminance grid in the browser, ping independently of
  the task notification bell and add to the unread Surveillance tab count. Unread alerts give the tab
  a red border, a fill and glow that throb from dark to bright red, and a pulsing count; narrow
  layouts show a prominent **Surveillance motion** button beneath the area selector. Reduced-motion preferences keep the strong highlight without
  animation. Opening Surveillance clears the alert and count;
  reloads retain the count in that browser tab. Each camera has a 30-second alert cooldown. Uniform
  brightness shifts are ignored, but lighting and picture changes can still trigger alerts. Monitoring
  shares the live picture socket, works across board tabs while the console is open, and ends on Stop
  or when the last enabled camera is switched off outside Live. Browser sleep pauses detection; sound
  needs a click or keypress after reload to satisfy the browser's autoplay policy.
- **Home** controls robot vacuums: status, start, pause, dock, find. It goes through Home Assistant
  first, signing in with the owner's refresh token from Home Assistant's own `.storage/auth`, so no new
  token has to be issued. The local miIO path is the fallback; it needs Python with `python-miio` and
  receives the token on stdin, never on a command line. When Home Assistant does not answer and an
  existing Docker container mounts its config folder at `/config`, the tab names that container and
  offers **Start Home Assistant**; the Devices dialog also shows it with Start or Stop (Stop confirms).
  The worker runs `docker start|stop` itself; the lookup, the start or stop and the re-check share one
  80-second deadline, under the console proxy's 90-second answer limit. Opening the tab never starts it, GGO
  never creates a container, and the container's restart policy is left as the owner set it.
  Each Home Assistant vacuum card also shows its **cleaning schedule** (`server/src/modules/worker/home/schedule.ts`). The
  schedule is two Home Assistant automations, so it keeps running with GGO closed. The **auto-start**
  starts the docked vacuum once its battery reaches a set level, inside a daily window and on chosen days;
  it re-checks at the window's start and every 30 minutes. The **quiet-hours guard** docks the vacuum
  whenever it cleans outside that window, through the vacuum's own start-charge button when it has one.
  GGO manages an automation only when it is exactly the shape GGO writes, checked by rebuilding it from the
  parsed window, days, battery sensor and dock button and comparing triggers, conditions, actions and
  mode. So the owner's hand-written pair is adopted whatever its id. An automation with one more condition
  or step, or a numeric condition on a sensor other than the vacuum's battery, is never rewritten: it is
  listed as "Also starts it", "Also docks it" or "Also uses it" with its own on/off switch, and the edit
  dialog warns before GGO adds its own rule beside it. An automation counts as the vacuum's only when its
  config names the vacuum entity exactly, so a second vacuum's automations stay off this card. The card
  reads the schedule through Home Assistant's config API (`/api/config/automation/config/<id>`, at most six
  reads at once) when it opens and when the browser tab becomes visible again, with no timer. A save
  rewrites only an automation whose fields changed, keeping its id, battery sensor and dock button but
  regenerating its alias and description, which name the times. Home Assistant's editor API rewrites
  `automations.yaml` on such a save, so YAML comments in that file are dropped. A rule that does not
  exist yet gets a `ggo_<vacuum>_auto_start` or `ggo_<vacuum>_quiet_hours_guard` id, and one left off is
  not created. Home Assistant answers a write before its reload finishes, so the save waits up to 10
  seconds for new automations to appear before switching each on or off (`automation.turn_on|turn_off`).
  Days apply only to a window within one day: Home Assistant checks a weekday against the calendar day,
  so a window past midnight must run every day. A miIO-only device has no schedule.
- **Sidekick** edits the companion-launcher tray app's rules in place, rejecting stale edits by file
  revision. Concurrent edits are serialized before checking that revision, so two editors cannot both
  save from the same snapshot and overwrite each other. It shows each rule's trigger and companion liveness and the app's launch log, and starts or
  stops the tray app through Script Hub. Liveness comes from `tasklist`; a failed read reuses the last good
  list, and with none it reports liveness as unknown (`processListError`, power disabled) while rules and the
  editor keep working.

## Surveillance recording

The bar above the cameras always states the plan: **Recording is off** (the default), **Recording 24/7**,
or the schedule with its next start or stop. Its three-way switch is the only control that changes the
mode (`PUT /recording/mode`). Saving any other setting (`PUT /config`) keeps the stored mode, so an edit
from a stale page cannot turn recording on or off.

- **24/7** records every camera set to record, around the clock.
- **Schedule** records inside a daily window on chosen days, in the machine's local time. A window that
  ends before it starts runs past midnight and belongs to its start day (Fri 22:00–07:00 records into
  Saturday morning). The same start and end mean the whole day. The worker re-checks the window every
  30 seconds. Between windows the plan stays armed, so the worker stays up and picks the next window up.
- **Recording settings** holds the schedule, a **Record this camera** switch per camera (also in each
  camera's editor), the recording folder, file length (1, 5, 10, 15, 30 or 60 minutes, default 15),
  **keep for N days**, a **size cap per camera** in GB, and the ffmpeg path. A camera with no RTSP stream
  cannot record, and turning a plan on with no recordable camera or no folder is refused with the reason.
- **Retention** runs in the worker while it is up: a minute after start, every 10 minutes, every 30
  seconds while a backlog remains, and 5 seconds after the settings change. It deletes oldest first, at
  most 400 files per sweep. It deletes only the recorder's own files, named `YYYY-MM-DD_HH-MM-SS.ts`, and
  never the newest file of a camera or a file written in the last 3 minutes. With no days and no cap set,
  it never touches the disk. Every setup (new, imported or pre-existing) keeps everything until you set
  days or a cap, because a recording folder may already hold footage. **Clean up now** in the recordings view runs a sweep at once.
- The **Recordings** view lists each camera's folder by day, then a day's files with their time span and
  size. A file plays in the page as an MP4 that ffmpeg remuxes on first play (`-c copy`, no re-encode,
  cached under `playback/`), with seeking. Each file downloads as MP4 or as the original `.ts`. The browser
  passes only a camera id and a file name; the worker refuses any name the recorder could not have
  written and any path outside that camera's folder. Responses go through GGO's authenticated proxy, which
  passes `Range`, `Content-Range`, `Accept-Ranges` and `Content-Disposition`. Switching to Recordings
  closes the live picture socket unless motion notifications are enabled.
- A recording made before modes existed (an `armed.json` but no recording settings in `config.json`)
  continues as 24/7 on the first start of the new worker.

## Verifying

- `npm run test:modules --prefix server` is the gate. It covers lifecycle, single instance, idle exit,
  stale builds, Deck import (including a machine with no hub), secret masking, auth, unreachable
  upstreams, tab visibility, the recording modes and schedule, retention, and the recordings routes
  (ranges, MP4 playback, refused paths), using real worker processes and a stand-in hub.
  `homeSchedule.test.ts` covers reading, adopting, rewriting and switching vacuum schedules against a
  stand-in Home Assistant.
- `npm run home-schedule-lab --prefix server` drives the vacuum schedule in a browser against a fake Home
  Assistant: the card, its on/off switch, and an edit saved through the dialog. It uses the same isolated
  builds as `modules-lab` and never contacts the real Home Assistant.
- `npm run surveillance-viewer-lab --prefix server` drives the fullscreen camera viewer (open from a
  picture, button/wheel/pinch/keyboard zoom, drag pan and limits, rotation, frame resizing, reset, phone fallback) against mocked module
  routes and a mocked frame socket, after `npm run build --prefix web`. It never contacts a camera.
- `npm run surveillance-notifications-lab --prefix server` checks per-camera toggles, independent
  motion pings, unread counts, cooldown, reloads, saved sensitivity and false-alert suppression,
  a shared socket, narrow layouts and explicit Stop
  against mocked camera pictures and module routes. Build web first; no real camera is contacted.
- `npm run modules-lab --prefix server` drives all four tabs in a browser against a throwaway instance;
  the header of `server/scripts/modules-lab.cjs` lists the build steps. It never starts or stops a
  script, never sends a vacuum command and never toggles Sidekick. It turns 24/7 on with one-minute files
  into its own temp folder, survives a GGO restart, plays a file in the recordings view, then turns
  recording Off.
- `npm run probe:module-latency --prefix server` samples HTTP, WebSocket and event-loop responsiveness of
  the live console. It is read-only.
