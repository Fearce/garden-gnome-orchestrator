---
paths:
  - "server/src/remoteControl/**"
  - "server/src/tests/remoteControl.test.ts"
  - "web/src/components/remote/**"
---
# Remote control

The design and limits are in `docs/agent-reference/CLAUDE-full.md` → "Remote control"; read it before changing the pipeline, the auth, or the managed ffmpeg.

- **Never click, tap or type on the viewer canvas in a browser test against the live GGO** — it drives Kevin's real desktop. Assert on `.rc-status-streaming`, `.rc-metrics` (`"<rtt> ms · <n> fps"`) and the canvas size instead. Connecting at all takes over the one viewer slot, so a test kicks Kevin's tablet session to "Take control here"; don't run one while he is using it.
- **Headless H.264 decode**: launch Playwright with Brave's binary (`executablePath: "C:/Program Files/BraveSoftware/Brave-Browser/Application/brave.exe"`), which ships the H.264 decoder WebCodecs needs.
- **Test the public path through script-hub, not only `:4317`**: `http://127.0.0.1:3939/orchestrator/` is what `polymarket.sprogbroen.dk` tunnels to. The hub destroys any socket path not in `proxyOrchestratorUpgrade`'s allowlist (`script-hub/web/server.js`, kevsclaw repo) — a new socket route needs that line changed and the hub restarted with `POST :3939/api/restart {"id":"script-hub"}` (graceful self-exit; GGO and the fleet survive).
- **ffmpeg 9 + NVENC fails here with "Could not create the texture (80070057)"** — driver 591.86 is below the 610 ffmpeg 9 needs. That is why `MANAGED_FFMPEG` pins 8.0.1; don't "upgrade" it without the driver.
- **Config writes with a Windows path**: put the JSON body in a file written with the Write tool and `curl --data-binary @file`; a heredoc or inline `-d` mangles the backslashes.
