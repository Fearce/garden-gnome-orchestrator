# GG Orchestrator desktop app

An optional desktop window for GG Orchestrator. It shows the same console the browser does, from the
same server, so every feature and every live update is identical. It adds what a browser tab can't:
its own window and taskbar button, the console's top bar as the title bar, a screen that finds or
starts your server, and links that open GGO on a task.

The web console does not depend on it. Nothing in `server/` or `web/` loads Electron, and a browser
never starts the app or anything desktop-only.

## Desktop or web?

| | Web console | Desktop app |
| --- | --- | --- |
| Install | Nothing: open `http://127.0.0.1:4317` | Build it once (below) |
| Phone, tablet, another machine, remote link | Yes | No: Windows x64 desktop only |
| Own window, taskbar button, title bar | A browser tab | Yes |
| Starts a stopped local server | No | Yes, **Start GGO** |
| Opens on a task from a link | No | `ggo://open?thread=…` |
| Google sign-in | In the page | In your browser, then handed to the app |

Switch any time: the top bar has **Open in web** in the app and **Open in desktop** in the browser
(the latter only on a machine where the installed app has run). Either way you land signed in, on the
task you had open. A link carries the address of the console that made it: if the app points at a
different server, it opens without using the link's sign-in or task.

## Platforms

Built and verified on **Windows 11 x64**: `npm run lab` drives the real app there end to end. The
code avoids Windows-only APIs apart from the title-bar overlay (macOS keeps its own traffic lights),
but macOS and Linux builds are **not** produced or tested. `npm run dist` builds the Windows x64
installer only.

## Build and launch

Needs the same Node 22+ as the server. From the repository root:

```bash
npm run desktop:install   # once: Electron, electron-builder, TypeScript
npm run desktop           # build and launch from source
```

The install fetches no Electron binary: Electron downloads it (about 110 MB) the first time
`npm run desktop`, the lab or the load probe starts it. If that reports `Electron failed to install
correctly`, the download failed (usually offline): run `node desktop/node_modules/electron/install.js`
once you are online.

To get an installer and a standalone app:

```bash
npm run desktop:dist
```

This writes to `desktop/release/` (gitignored):

- `GG-Orchestrator-Setup-<version>-x64.exe` installs per user (no admin) with Start menu and
  desktop shortcuts. It is unsigned, so Windows SmartScreen asks once: **More info → Run anyway**.
- `win-unpacked/GG Orchestrator.exe` runs without installing.

Updates: pull the repository and run `npm run desktop:dist` again, then reinstall (or relaunch
`win-unpacked`). There is no auto-updater. The console page itself always comes from your server,
so console updates reach the app on their own; only the window around it is rebuilt this way.

## Connecting

The app opens `http://127.0.0.1:4317/` by default. **Change** at the bottom of the connection
screen accepts any GGO address: `192.0.2.10:4317`, or `https://example.com/orchestrator/` for a
console behind a reverse proxy. The choice is saved in the app's user-data folder
(`%APPDATA%\GG Orchestrator\desktop-settings.json`), never in the repository.

What the connection screen shows:

- **Connecting**: looking for the server.
- **GGO isn't running**: nothing answers. It retries on its own (1.5 s, growing to 15 s) and, for a
  local address, offers **Start GGO**. If your checkout's server listens on another port (`PORT` in
  the environment or `server/.env`), it offers **Use port N** instead, since a server started there
  would never answer at this address.
- **Can't reach GGO**: the same for a remote address; check the address and that the server is up.
- **Something other than GGO answers**: another program holds the port. The app won't start a
  server into it.
- **Lost the connection**: an open console page stopped loading. It reconnects and returns to the
  page you were on.
- **This window stopped**: the window's renderer crashed. Your tasks are unaffected; **Reload**.

While the console is open, a server restart (a deploy, an update) shows the console's own
"reconnecting…" in the top bar and resumes without leaving the page.

A self-signed HTTPS address (`:4319`) is not supported: Electron refuses its certificate. Use the
HTTP address on this machine, or a properly signed HTTPS one.

## Starting the server

**Start GGO** runs the same supervisor `npm run serve --prefix server` uses
(`server/scripts/supervise.cjs`), with your system Node, from the GGO checkout the app belongs to:

- run from source or `desktop/release/win-unpacked`, that is the checkout around it;
- installed elsewhere, choose it once with **Choose GGO folder…**.

The server is detached. **Closing the window never stops it**, so agents keep working; reopening the
app reconnects to it. To stop it, stop it the way you would any `npm run serve`: close it from your
process manager, or end the `node` processes running `supervise.cjs` and `src/index.ts`. Its log is
`server/data/server.log`, or `server.log` in the `DATA_DIR` of the environment the app was launched
from (the supervisor writes it and does not read `server/.env`); **Open server log** opens it if a
start doesn't come up.

The app checks the address and the port before starting anything, starts once per click (the button
gives way to the starting screen at once), and never starts into a port another program holds. If a
server from the same data folder is running anyway, the newcomer's data-folder lock makes it exit
(code 78); its supervisor retries for up to a minute, in case the other one was only shutting down,
then stops rather than run beside it. The app never starts itself at login and leaves nothing running
in the background once you quit it.

## Signing in

- **Password**: type it in the window, as in the browser.
- **Google**: Google blocks sign-in inside embedded browsers, so the app opens the sign-in in your
  default browser. When it finishes, the browser asks to open GG Orchestrator and hands the window a
  one-time ticket. Only that sign-in's own callback issues the ticket; no other page can make the
  browser mint one.

Sessions are the console's normal 30-day cookie, kept in the app's own profile (encrypted at rest in
the packaged app; a run from source keeps Chromium's default cookie store).
A one-time ticket lives two minutes, works once, and exists only in the server's memory.

## Files and links

- **Download** on a deliverable saves to your Downloads folder, numbering a name that's taken, with
  progress on the taskbar button and a notification that shows the file in its folder.
- **View** and other console pages that open a window open in a child window of the app.
- Any other link opens in your default browser. The window never navigates away from the console.

## Security

Every page runs with context isolation, the Chromium sandbox and no Node.js. The console page gets
one small bridge (`window.ggoDesktop`: open in browser, title-bar colours, a task link); the
connection screen, served from the app's own `ggo-app://` scheme under a strict CSP, gets another. The
main process checks that each call comes from its own window's top frame on the expected page.
Camera, microphone, location and similar permissions are refused; the console gets only
notifications, clipboard writes and full screen. `<webview>` is disabled, and a `ggo://` link is
parsed strictly: a malformed part drops the whole link. The packaged app disables `ELECTRON_RUN_AS_NODE`,
`NODE_OPTIONS`, the inspector flags and loading code outside its integrity-checked archive.

## Development

```bash
npm run build --prefix desktop      # compile to desktop/dist
npm test --prefix desktop           # unit tests (Node's test runner)
npm run lab --prefix desktop        # the real app end to end, against a throwaway server
```

The lab needs a web bundle built for labs; from `web/`:
`npx vite build --outDir ../server/.lab-web-dist-desktop --emptyOutDir`, then run it with
`GGO_LAB_WEB_DIST=.lab-web-dist-desktop`. Add `-- --shots ../server/data/desktop-lab-shots` to keep
its screenshots and timings. It starts its own server on `:4397` from this checkout, so nothing runs
against your real GGO, and stubs the system browser and notifications.

A run with `GGO_DESKTOP_USER_DATA` (the lab, `npm run probe:load`) uses a throwaway profile: it
registers no `ggo://` handler and so never tells the server that this machine should offer
**Open in desktop**. Both also set `GGO_DESKTOP_BACKGROUND=1`, which opens the window on a monitor
other than the primary one (the primary only when there is no other) and never takes focus, so a
test run doesn't land on top of whatever you're doing.

`npm run probe:load --prefix desktop -- --out <folder>` measures a running GGO's `/api/me` and
WebSocket latency with the app closed, open and closed again, plus the app's startup time, memory
and CPU, and writes `desktop-load-probe.json`. It signs in with `AUTH_PASSWORD` and only reads.
If the app does not exit within 20 seconds, the probe fails and cleans up its test process rather
than recording a misleading "app closed again" measurement.

Layout: `src/main.ts` (app lifecycle, IPC), `src/controller.ts` (the window and its connection),
`src/localServer.ts` (finding and starting a server), `src/navigationPolicy.ts` (what may load
where), `src/preload.ts` (the two bridges), `static/` (the connection screen). The server half is
`server/src/desktop.ts`; the console half is `web/src/lib/desktop.ts` and
`web/src/components/DesktopSwitch.tsx`.
