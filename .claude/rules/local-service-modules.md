---
paths:
  - "server/src/modules/**"
  - "server/src/tests/modules.test.ts"
  - "server/scripts/modules-lab.cjs"
  - "server/scripts/module-latency.cjs"
  - "web/src/components/modules/**"
  - "web/scripts/module-tabs.test.ts"
---
# Local service tabs (Script Hub, Surveillance, Home, Sidekick)

Design, data layout, Deck import and lifecycle are in `docs/local-service-modules.md`; read it before changing the supervisor, a worker or a tab.

- **Expensive work stays in the worker, never in GGO's process.** Camera decoding, ffmpeg, process enumeration, script control and device I/O run in `server/src/modules/worker/**`. GGO only proxies (`routes.ts`) and supervises (`supervisor.ts`). A new feature that `spawn()`s or polls belongs in the worker. Starting the worker goes through `spawnDetached` (a worker thread), because a main-thread `spawn()` blocks the console for hundreds of ms on this OS.
- **Nothing starts until asked.** Never call `supervisor.ensure()` from boot, a timer or a broadcast. The only boot-time call is `resumeArmed()`, which acts only on an `armed.json` the owner's own Start wrote. `test:modules` asserts "nothing runs, polls or touches disk until a module is asked for"; keep it green.
- **User-started work survives navigation and restarts; Stop ends it.** Mark continuous work with `ctx.setArmed(reason)` and report it in `busy`, so idle exit, stale-build replacement and the header's Stop all respect it. Clear it on the explicit stop.
- **Tabs poll only while visible.** Use `usePoll`/`usePageVisible` from `web/src/components/modules/hooks.ts` and close sockets and EventSources in effect cleanup. `modules-lab` checks that no `/api/modules/` request leaves the page on another tab, and that frame and log streams close on leaving.
- **Secrets never reach the browser.** Mask them in the worker's view (`SECRET_MASK`) and restore on save (`restoreSecrets`, `restoreDeviceSecrets`). Free text counts: imported camera notes held a real password, so `maskCamera` masks secrets inside `notes` too; mask any new free-text field the same way. Pass tokens to child processes on stdin, never as arguments. `workerEnvironment()` strips credential-looking variables; don't widen it.
- **A failed first import cannot become an empty setup.** Only a missing Deck section (`404`) permits defaults. Other read failures must stop startup without writing `config.json`, so retry can still carry over the owner's settings. Device notes must mask and restore the miIO token too.
- **Tracked files are neutral.** Real camera addresses, device tokens, script inventories and paths live only in `<DATA_DIR>/modules/*/config.json`. Tests and docs use `192.0.2.x`, `example.com` and sample ids (`npm run privacy:check --prefix server`).
- **ffmpeg leftovers are found by a per-data-folder tag** (`ffmpegTag(dataDir)` in `processes.ts`). Never revert it to a fixed string: a lab or dev instance's startup sweep would then kill the live instance's recording.
- **ffmpeg stderr goes through `LineThrottle`.** Cameras with damaged HEVC streams print a line per frame. Without the cap, `worker.log` grows by megabytes a day, and it is never truncated while the worker runs.
- **Verify with** `npm run test:modules --prefix server` and the browser lab. The lab needs isolated builds (`npx tsc -p tsconfig.json --outDir .modules-lab-dist` from `server/`, `npx vite build --outDir ../server/.lab-web-dist-modules --emptyOutDir` from `web/`) and reads the real hub's settings read-only. Stop clicks need `page.once("dialog", d => d.accept())`, since Stop confirms and Playwright dismisses dialogs by default. Service rows are keyed by `module`, not `id`.
- **The live instance's workers outlive deploys.** After a deploy, an idle worker on the old build is replaced on the new GGO's first request to it. A busy one (recording) stays on the old build until the owner restarts it: its tab shows "Older build" and `GET /api/modules/services` reports `stale: true`. To prove a worker change live, call `POST /api/modules/<id>/service/restart` on idle modules; never force-restart a recording one.
