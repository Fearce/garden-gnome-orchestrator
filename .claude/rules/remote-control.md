---
paths:
  - "server/src/remoteControl/**"
  - "server/src/tests/remoteControl.test.ts"
  - "web/src/components/remote/**"
---
# Remote control

The design and limits are in `docs/agent-reference/CLAUDE-full.md` → "Remote control"; read it before changing the pipeline, the auth, or the managed ffmpeg.

- **Never click, tap or type on the viewer canvas in a browser test against the live GGO** — it drives the owner's real desktop. Assert on `.rc-status-streaming`, `.rc-metrics` (`"<rtt> ms · <n> fps"`, plus `" · <n.n> Mb/s"` while the bitrate is lowered) and the canvas size instead. Connecting at all takes over the one viewer slot, so a test kicks the owner's tablet session to "Take control here"; don't run one while they are using it — check `GET /api/remote-control/status` first; a non-null `active` (client IP + user agent) means they are connected.
- **Stream smoothness is measured, not eyeballed**: `npm run remote-stream-lab --prefix server` (real `RemoteSession` + real `StreamClient` through emulated links) before and after any change to `session.ts`, `flowControl.ts`, `capture.ts`, the encoder args or `streamClient.ts`. It captures this PC's display with its own session, so it is safe while the owner is connected. `remote-viewer-lab` covers the React tab on a throwaway instance; CDP `Network.emulateNetworkConditions` DOES throttle the stream socket there. The `.rc-metrics` text gains ` · <n.n> Mb/s` (`.rc-rate-reduced`) only while the bitrate is lowered.
- **Never `spawn()` on GGO's main thread for anything in the stream path.** On this box a spawn blocks the calling event loop for 10–1200 ms at random (measured 2026-09-28), and a blocked loop reads to flow control as backlog. Captures go through `Capture` (own worker thread per ffmpeg).
- **Don't reuse a decoder config across a bitrate change**: NVENC's SPS carries the HRD bitrate, so every handover sends a new `config` and the viewer must `configure()` in place.
- **Headless H.264 decode**: launch Playwright with Brave's binary (`executablePath: "C:/Program Files/BraveSoftware/Brave-Browser/Application/brave.exe"`), which ships the H.264 decoder WebCodecs needs.
- **Test the public path through script-hub, not only `:4317`**: `http://127.0.0.1:3939/orchestrator/` is what the owner's public tunnel hostname points at. Its frontdoor worker (`web/frontdoor.js` in the script-hub repo) forwards every `/orchestrator/*` upgrade to GGO, so a new socket route needs no hub change. Don't widen `proxyOrchestratorUpgrade` in `server.js`: public GGO traffic never reaches it (done and reverted 2026-09-28, `aaef8a7`).
- **ffmpeg 9 + NVENC fails here with "Could not create the texture (80070057)"** — driver 591.86 is below the 610 ffmpeg 9 needs. That is why `MANAGED_FFMPEG` pins 8.0.1; don't "upgrade" it without the driver.
- **Config writes with a Windows path**: put the JSON body in a file written with the Write tool and `curl --data-binary @file`; a heredoc or inline `-d` mangles the backslashes.
