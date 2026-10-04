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
  timeout after checking the session cookie and refusing cross-site requests. Live streams use
  `/api/modules/<module>/stream` with a single-use ticket from `/api/modules/<module>/ticket`, because a
  WebSocket handshake ignores CORS.
- **Idles out.** A worker exits after 10 minutes without a request, an open stream or user-started work.
- **Visible.** The tab header shows the worker's state, pid and memory, with **Restart** and **Stop**.
  `GET /api/modules/services` lists all four. A worker still running code from an older GGO build says
  so and offers a restart. A busy worker is never replaced automatically.
- **Recovered.** If a worker dies, the next request starts a fresh one. A request to an unreachable
  upstream (Home Assistant down, Script Hub stopped) answers `503` with the reason. The tab shows it and
  the rest of GGO is unaffected.

### View lifecycle

Polling runs only while its tab is visible and the browser page is in the foreground. Leaving a tab stops
its polling and closes its frame socket and log streams.

### Work you start

Only an explicit action starts continuous work, and only Stop ends it. Today that means one action:
**Start recording** in Surveillance.

- Recording keeps running when you leave the tab, close the browser or restart GGO.
- It is remembered in `armed.json`. While the file exists, GGO checks the worker every minute and
  resumes the recording if the worker died, including after a reboot of GGO.
- **Stop recording** (with a confirmation) ends it and deletes `armed.json`. Stopping the service from
  the tab header also ends a recording, after its own confirmation.

## Data and migration

Each module keeps its state under `<DATA_DIR>/modules/<module>/`, which is gitignored with the rest of
`server/data/`:

| File | Contents |
| --- | --- |
| `config.json` | The module's settings: cameras, devices, hidden scripts. |
| `worker.json`, `worker.lock` | The running worker's pid, port and token, and its single-instance lock. |
| `worker.log` (+ `worker.log.1`) | The worker's log. It moves to `.1` past 4 MB, and ffmpeg output is capped per camera. |
| `armed.json` | Present only while a recording you started should keep running. |

**First use imports the Deck's settings.** When `config.json` is missing, the worker reads the matching
section from the Script Hub at `SCRIPT_HUB_URL` (`GET /api/settings/<section>`, default
`http://127.0.0.1:3939`) and saves it:

| Module | Deck section | Carried over |
| --- | --- | --- |
| Script Hub | `hiddenScripts` | Which scripts you hid. |
| Surveillance | `surveillance` | Every camera and its streams, snapshot URL, credentials, layout and recording quality; the recording folder. Recording itself starts **stopped**, even if the Deck was recording. |
| Home | `home-control` | Home Assistant URL and config folder, each vacuum with its entities, miIO host and token. |
| Sidekick | none | Sidekick's rules stay in the tray app's own `settings.json` and are edited in place, so nothing is copied. |

If the hub cannot be reached, nothing is written, so the import runs again on the next start. A hub
without that section (`404`) counts as nothing to import. A hub that answers with a server error fails
the start visibly instead of saving an empty config. To redo an import,
stop the module's service, delete its `config.json` and open the tab again.

**Secrets stay on the server.** Camera passwords, credentials inside stream URLs, miIO tokens and the
Home Assistant token never reach the browser: the API shows `********`, and saving a form with the mask
keeps the stored value. A camera's notes get the same treatment: its password, its URL passwords and any
`scheme://user:pass@` password written into the notes show as the mask and are put back on save.

## The four modules

- **Script Hub** talks to the Script Hub service at `SCRIPT_HUB_URL`. It covers the script list with
  search, category, status and visibility filters; Start, Stop and Keep Alive; notes; and a live log tail.
  The worker trims and gzips the hub's large status payload. The hidden-scripts list is stored in GGO.
- **Surveillance** shows live camera tiles, records, and edits and discovers cameras. A camera with a
  snapshot URL is polled at its own refresh interval. A stream-only camera gets one on-demand ffmpeg
  preview, or the recorder's own frames while recording. Reolink privacy mode can be toggled. Every
  recording ffmpeg writes 15-minute segments into the recording folder. The module needs ffmpeg: a path
  set under Recording, else the copy GGO installed for Remote control, else one on `PATH`.
- **Home** controls robot vacuums: status, start, pause, dock, find. It goes through Home Assistant
  first, signing in with the owner's refresh token from Home Assistant's own `.storage/auth`, so no new
  token has to be issued. The local miIO path is the fallback; it needs Python with `python-miio` and
  receives the token on stdin, never on a command line.
- **Sidekick** edits the companion-launcher tray app's rules in place, rejecting stale edits by file
  revision. It shows each rule's trigger and companion liveness and the app's launch log, and starts or
  stops the tray app through Script Hub.

## Verifying

- `npm run test:modules --prefix server` is the gate. It covers lifecycle, single instance, idle exit,
  stale builds, Deck import, secret masking, auth, unreachable upstreams and tab visibility, using
  real worker processes and a stand-in hub.
- `npm run modules-lab --prefix server` drives all four tabs in a browser against a throwaway instance;
  the header of `server/scripts/modules-lab.cjs` lists the build steps. It never starts or stops a
  script, never sends a vacuum command and never toggles Sidekick. It records briefly into its own temp
  folder, then stops.
- `npm run probe:module-latency --prefix server` samples HTTP, WebSocket and event-loop responsiveness of
  the live console. It is read-only.
