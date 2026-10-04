# Backlog

Reported problems and planned work that nobody has picked up yet. Each entry records **what was
reported and what evidence already exists**, so the task that picks it up starts from that evidence
instead of re-diagnosing from scratch. An entry is not a diagnosis: where the cause is unknown, it
lists the open possibilities rather than guessing.

Settled "should we adopt / replace X?" questions live in [`DECISIONS.md`](DECISIONS.md), not here.

When you pick an entry up, link your task/commit under it. When it's fixed, delete the entry in the
same commit as the fix. Git history keeps the record.

---

## In progress

- **Replace Ollama memory with Haiku and Luna and build RAG memory into GGO** (2026-10-04, Lanternroot; task 6b9aab39).

## Shipped, awaiting live proof

- **QA: keep automated desktop windows off the primary monitor and repeat clean-exit verification** (2026-10-04, Codex QA; task 70393577).
  Electron/browser lab 59/59, gates 229/229, types/builds/privacy and Windows packaging pass. Packaged windows close in 626/332 ms; live browser task/settings/calendar pass. Independent review and distribution delivery remain required.
- **QA: harden desktop settings, checkout selection, download names and load-probe cleanup** (2026-10-04, Moss Gauge).
  Desktop units 19/19 and new real-window regressions pass; application types/builds, Windows packaging and privacy pass. Clean-exit lab failures and distribution delivery remain under Ready.

## Ready (priority order)

1. **Resolve Electron clean-exit verification before accepting the desktop app** (2026-10-04, Moss Gauge): desktop lab 52/55; three 20-second app-exit timeouts, and packaged-window-close verification timed out at 15 seconds. Live HTTP/WS load probe completed without a desktop-open regression.
2. **Surface the desktop distribution and all retained validation artifacts** (2026-10-04, Moss Gauge): installer and retained screenshots/metrics have no deliverable cards; existing eight cards serve. Installer exceeds the 25 MB serving cap and needs a supported delivery path.
1. **Investigate console smoke served/local bundle mismatch and browser shutdown timeout**: 2026-10-03 probe reports ws=live with no console errors, served index-C8zofTVy.js versus local index-BHXtYnz4.js, and browser shutdown exceeded 5000ms; authenticated HTTP bundle verification passed earlier in the same task.
4. **Stabilize the dispatch-latency gate's saturated-pool ordering assertion** (2026-10-05, Codex QA): full gates scored 228/229 with blocker0 finishing before dispatch under concurrent load; two focused reruns passed 8/8. Evidence: test:dispatch-latency, section C; unrelated to module workers.

## Blocked / waiting

- **Purge cached private-project reference from PR #10** (owner action: include old PR body in the GitHub Support request).
  QA redacted the live body and verified https://github.com/Fearce/garden-gnome-orchestrator/pull/10; legitimate contributor attribution remains intact.

- **Rewrite published history to remove personal details the tree no longer carries** (owner action: filter-repo + force-push master, delete five stale remote branches, GitHub Support for PR refs/caches, coordinate the published fork rewrite).
  Corrected kit (surfaced as a deliverable) in the main checkout's gitignored `_privacy-remediation` folder: fresh public mirror dry-run 2026-10-04 reduced 2,751 matches (including exposed PFX passphrase) to 0; public fork still has 211 matches; nothing force-pushed.
- **Rotate the local HTTPS PFX passphrase** (owner action): it is a weak dictionary word, and `npm run audit:secrets --prefix server` finds that word in four reachable published commits (value withheld), so treat it as exposed: set a random passphrase, re-encrypt the PFX and update `server/.env`.

## Open

No open entries.

## Done (newest first; keep the last 20)

- 2026-10-05 **Owner report: cameras stuck on "Waiting for a picture..." and Home Assistant not answering** (Ferrule Juniper): live build 38078a69 showed 5/5 pictures on direct HTTP/HTTPS, the Deck proxy and LAN HTTPS; a foreign-Origin handshake through the Deck upgraded and streamed while a cross-site one got 403. The stopped `homeassistant_xiaomi` container was started from the Home tab's own Start (answered in 20s, vacuum live) and its restart policy, drifted to `no`, was restored to the compose file's `unless-stopped`.
- 2026-10-05 **QA: wait for Home's page-wide probe before checking outage controls** (Codex QA): modules-lab 74/74, live direct/proxy desktop/phone 24/24, three authenticated report downloads, preserved configs and recording; types, isolated builds, privacy and README pass. Full gates 228/229; dispatch-latency passed two focused reruns, with its load-sensitive assertion tracked under Ready.
- 2026-10-04 **Independent module deployment QA** (a6eba134, 38078a69; Codex QA): 74/74 isolated and 13/13 live proxy/browser checks, preserved local configurations and recording, authenticated report downloads; all 229 gates covered green after the Calendar task's 28a0706f repair. Includes the Deck-proxy camera socket and explicit Home Assistant Start (d8481ca2), serialized Sidekick rule saves (e9ce82a3) and explicit Stop that holds with the tab open (58e13ef5), all live in 38078a69. Evidence: docs/reports/local-service-modules-independent-qa-2026-10-04.md.
- 2026-10-04 **Auto-burn subscriptions within 24 hours of weekly reset** (1a3e8dba, Moss Spark): pushed to master and live build verified; authenticated live hello reports autoBurn=false and the served entry matches dist with the new control. Browser lab 21/21; routing/Codex/boundary regression, burn/model/goal/Director gates, typechecks/build, README and privacy checks pass.

- 2026-10-04 **Optional Electron desktop app with Open in desktop / Open in web handoff** (8521a443..c2283ee4, Quillhatch): server live as 5712fdf2; the packaged Windows app reached the live server's sign-in in 928 ms with the bridge and no Node in the renderer; desktop lab 51/51; live load probe under 7 implementing agents moved no HTTP/WS percentile (/api/me p95 6.0 to 6.5 ms, WS ping p95 1.4 to 2.6 ms); live web portal check passed.
- 2026-10-04 **QA: Surveillance 24/7 and scheduled recording (off by default), recording options, recordings browser, hub-less start** (07ebac86..24dfe20f, Ferrule Juniper): live build 24dfe20f carried the owner's running 5-camera recording over as 24/7. 14/14 live desktop and phone checks covered the mode shown, the options dialog, a real segment played in 113ms, a 206 MP4 download, a traversal refused with 400, and the recording left untouched. Isolated lab 58/58; 228/228 gates; module gate 32 checks, including the legacy-recording carry-over.

- 2026-10-04 **CLAUDE.md and AGENTS.md require same-change README upkeep and keep personal details out of the tracked tree** (c829e625, Ledgerfern): `privacy:check` clean with the operator's 25 private terms loaded, `test:privacy-guard` passes, `test:readme-claims` 64/64, `audit:secrets --no-history` reports no secrets, and `probe:doc-paths` resolves every path the new rules cite.

- 2026-10-04 **QA: preserve failed Deck imports, mask device-note tokens and bound camera relay buffers** (6970c5e0, Mistcap Reed): pushed and live in build a628a671; 25 module checks plus visibility, 43 browser-lab checks including recording through an actual restart, 12 live desktop/mobile checks plus Settings/reload checks; all 228 gates covered across the full run and two build-dependent reruns; configs retained and the evidence deliverable serves correctly.

- 2026-10-04 **QA: Supervisor delivery recovery, repeated-text browser checks and activity-query stalls** (2da95383, bad7f5c9, Bramble Gauge): deployed build c710345d; 16/16 delivery and 17/17 read-receipt browser checks; activity index rehearsed at 236 to 80 reads with 824 identical rows. Live browser replay cleared Sending in 55ms without another owner copy; 80 HTTP/WS samples p95 3.5/2.6ms, worst five-minute lag 1.1s. Typechecks/build and focused gates pass except the inherited privacy issue in Ready.

- 2026-10-04 **Script Hub, Surveillance, Home and Sidekick moved from the Dashboard Deck into optional GGO tabs** (066b6908..d4d23aa1, Ferrule Juniper): live build ec829269 passed 16/16 browser checks (hidden by default, reload persistence, on-demand start, migrated 5 cameras/1 vacuum/287 scripts/3 Sidekick rules, no secrets in responses, socket and polling cleanup); isolated lab 42/42 incl. explicit recording start/stop and worker recovery; live HTTP p95 4.5ms before, 3.8ms with modules under load, zero event-loop stalls (docs/reports/local-service-modules-2026-10-04.md); Deck cards retired (ac14700).

- 2026-10-04 **Owner messages stuck on "Sending…": event-loop stalls and receipt states** (ae00dada..0db6a2d7, Wickfern): the calendar inject ffaa6433 was delivered once and read, not lost; the cause was event-loop stalls (worst 45.8s at 16:15Z). Live build 0db6a2d7 ran 10 min under agent load with zero ≥1s block reports (pre-fix windows: 34.3s/45.8s worst, 355s/136s blocked). Live browser inject at 17:52:28Z was acknowledged 73ms after send, and "Sending…" cleared by 152ms; HTTP p50 4ms. The receipt UI and lab (94a011a6) cover failure, disconnect and reload.

- 2026-10-04 **Calendar QA: saved defaults and month ordering integrated** (6225a033, 53f3b854, Codex QA): pushed to master; deployed build 53f3b854 verified; 83/83 isolated browser checks and 9/9 live proxy checks prove create/edit/move/delete and reload persistence; typechecks, builds, focused calendar/scheduler/cron and privacy checks pass; all 226 gates covered by 44 passes before the deployment interruption plus a 182/182 remainder run.

- 2026-10-04 **Calendar events with an unspecified end** (b0c66ba, Thistle Gauge): live build b0c66ba4; authenticated day view and details show the stored start with an unspecified end; focused calendar gates, typechecks, privacy guard and 78/78 browser checks pass; all 226 gates covered across the interrupted full run and a 15/15 remainder run.

- 2026-10-04 **Correct persistent-goal README claims and privacy-remediation handoff** (Codex QA): 226/226 free gates, build/typechecks, privacy guard, README 64/64, doc paths 18/18 and browser calendar 65/65 pass; corrected kit dry-run removed all 2,751 matches; PR #10 live body redacted and read back; history/rotation/deliverable blockers remain above.

- 2026-10-04 **Calendar QA: DST spans, following weekdays, paused moves, modal focus and Today navigation** (3b6b0f2, Moss Lantern): calendar-lab 72/72; calendar/scheduler/cron gates, typechecks, builds and privacy guard pass; deployed build 3b6b0f2c verified; live deck-proxy browser checks Today, modal focus, authenticated range, 1-week + 1-day defaults and served bundle equality.

- 2026-10-04 **Privacy QA: protect environment variants and relay state; redact audit evidence** (Moss Lantern): privacy gate exercises binary runtime-file rejection and redacted secret/history output; README links and current-tree secret audit pass; full suite 225/225 and browser labs 42/42 passed before these focused fixes.
- 2026-10-04 **Calendar and IDE writes work through the deck's `/orchestrator/` proxy** (79a6672, a12307e, Almanac Wren): live build a12307e6; through `https://localhost:3940/orchestrator/` a create returned POST 200 and a UI delete returned DELETE 200, and the event stayed gone after a reload (was 403 "Origin does not match this console"); `test:calendar` and `test:ide` pass.
- 2026-10-04 **README brought up to date; personal details removed from the public tree** (895407f, Quillfern Sieve): live build 895407fb; `test:privacy-guard` clean over every tracked file, `test:readme-claims` 63/63, 224/225 full gates (the one, `test:doc-paths`, fixed and green); the history rewrite is under Blocked.
- 2026-10-04 **Full calendar with default reminders** (66521d3, 70d9ffc, Almanac Wren): live build 70d9ffc9; `test:calendar` and `calendar-lab` (65/65, synthetic data, no task started) pass; the five reminders converted from schedules read back from the live range API, and the live new-event form opens with the owner's 1-week + 1-day defaults.
- 2026-10-04 **One composer repo chip per workspace** (593eb55, Twinpicker): live build 593eb556 rewrote the stored 9-entry row (`C:/x` beside `C:\x`) to one canonical entry per workspace at boot; `sonnet-probe`, which the old bug had evicted from the capped list, was restored; the live composer shows 7 unique chips and `c:/Claude-Orchestrator/` lights the existing chip; `test:recent-repos` and `repo-chips-lab` (11/11) pass.
