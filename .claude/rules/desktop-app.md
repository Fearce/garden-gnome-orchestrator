---
paths:
  - "desktop/**"
  - "server/src/desktop.ts"
  - "server/src/tests/desktop.test.ts"
  - "web/src/lib/desktop.ts"
  - "web/src/components/DesktopSwitch.tsx"
---
# Desktop app

User-facing guide: `desktop/README.md` (build, launch, connecting, packaging, security). Why Electron and not Tauri or a PWA: `docs/DECISIONS.md`. Read both before changing how the app starts a server, signs in or draws its title bar.

- **Verify in the real app, never only the unit tests**: `npm run lab --prefix desktop` drives the packaged-equivalent Electron app (Playwright `_electron`) against a throwaway server it starts itself on `:4397`. Build its web bundle first (`npx vite build --outDir ../server/.lab-web-dist-desktop --emptyOutDir` from `web/`, then `GGO_LAB_WEB_DIST=.lab-web-dist-desktop`). `npm run lab` rebuilds `desktop/dist` first; running `node scripts/desktop-lab.cjs` directly does not, so build after any `desktop/src` edit. Add `-- --verbose` to see the app's own output and each `[step n]` banner.
- **The web half must stay browser-safe**: `web/src/lib/desktop.ts` only reads `window.ggoDesktop` (the preload bridge). Never import anything from `desktop/` into `web/` or `server/`, and never add a code path where a plain browser tab launches the app — the browser hands over through a `ggo://open` link the user's click opens.
- **Start the server through ShellExecute on Windows, never a plain `spawn`** (`startThroughShell` in `localServer.ts`): Node spawns with handle inheritance on, so a detached supervisor kept the app's stdout/stderr pipes open and anything that launched the app through a pipe (Playwright's `app.close()`, a script) hung until the SERVER exited. Pass paths in environment variables, never quoted into the PowerShell source: PowerShell 5.1 also treats `‘ ’` as quotes, and `Start-Process -WorkingDirectory` reads `[ ]` as a wildcard.
- **Sign-in tickets are minted only by a same-site POST (`/api/desktop/ticket`) or inside the Google callback (`desktopHandoffPage`)**. Never add a GET that mints one: the session cookie is `SameSite=Lax`, so any site could steer the owner's browser to it.
- **`ggo://open` links carry `server=<origin>`** (`DesktopSwitch.tsx`); the app redeems the ticket and opens the task only when `sameServer` matches its own address. Keep the parameter when changing the link.
- **The probe's GGO fingerprint is `/api/me`**: 200 with a boolean `authed`, or the remote gate's 403 whose `error` starts with "remote access needs Google sign-in" (`isGgoAnswer` in `probe.ts`). Rewording that 403 in `server/src/remoteAccess.ts` makes GGO behind a remote link read as "something other than GGO".
- **Presence is reported only by an app that registered `ggo://`** (`linksRegistered` on the bridge, false under `GGO_DESKTOP_USER_DATA`). A lab or probe run against the real server must not make browsers offer Open in desktop.
- **Compare `ggo-app://` URLs by protocol and host, never `.origin`**: Node's `URL` gives a custom scheme the opaque origin `"null"`, so an origin check matches nothing (or everything).
- **Validate everything that crosses the bridge in the main process**: `parseTitleBarStyle`, `isTicket`, `parseDeepLink`, and the sender check in `main.ts` (`consolePage`) reject rather than coerce. A new IPC channel follows the same shape: one typed preload method, one validating handler, a sender check.
- **Never put a test window in front of the owner**: every scripted launch (lab, probe, a one-off Playwright check) sets `GGO_DESKTOP_BACKGROUND=1` (secondary monitor, `showInactive`, no focus) and moves windows only within their current display. A window the owner minimizes mid-run also explains odd results: a minimized window ignores `setBounds`. Capture a whole window (title-bar buttons included) only with `PrintWindow` (`captureWindow` in the lab), never a screen copy: a background window sits behind the owner's own windows, and a screen copy captures those.
- **Lab seeding**: write seeded tasks into the database BEFORE the first signed-in connection (the lab seeds while the sign-in page shows). Seeded under an already-connected console, they never reach its board.
- **Leftover lab processes** (a lab killed mid-run): stop `node.exe` processes whose command line holds `supervise.cjs` or `tsx` under this checkout, then the `:4397` listener. Filter on `Name='node.exe'` — matching any process by command line also matches (and kills) your own shell.
- **Gates**: `npm run test:desktop --prefix server` (tickets, handoff page, presence, redeem), `npm run test:supervisor --prefix server` (exit-78 duplicate retry), and `npm test --prefix desktop` (URL, navigation, deep-link, probe, port, log path, Windows start path, title-bar, download-name and settings policies).
