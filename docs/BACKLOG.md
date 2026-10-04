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

_(none: claim from Ready)_

## Ready (priority order)

1. **Investigate console smoke served/local bundle mismatch and browser shutdown timeout**: 2026-10-03 probe reports ws=live with no console errors, served index-C8zofTVy.js versus local index-BHXtYnz4.js, and browser shutdown exceeded 5000ms; authenticated HTTP bundle verification passed earlier in the same task.

## Blocked / waiting

- **Purge cached private-project reference from PR #10** (owner action: include old PR body in the GitHub Support request).
  QA redacted the live body and verified https://github.com/Fearce/garden-gnome-orchestrator/pull/10; legitimate contributor attribution remains intact.

- **Rewrite published history to remove personal details the tree no longer carries** (owner action: filter-repo + force-push master, delete five stale remote branches, GitHub Support for PR refs/caches, coordinate the published fork rewrite).
  Corrected kit (surfaced as a deliverable) in the main checkout's gitignored `_privacy-remediation` folder: fresh public mirror dry-run 2026-10-04 reduced 2,751 matches (including exposed PFX passphrase) to 0; public fork still has 211 matches; nothing force-pushed.
- **Rotate the local HTTPS PFX passphrase** (owner action): it is a weak dictionary word, and `npm run audit:secrets --prefix server` finds that word in four reachable published commits (value withheld), so treat it as exposed: set a random passphrase, re-encrypt the PFX and update `server/.env`.

## Open

No open entries.

## Done (newest first; keep the last 20)

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
- 2026-10-03 **Allow model changes on paused tasks with stale running implementor records** (Bramble Quill): 20 desktop/phone browser checks, 50 model-routing checks, UI gate and all typechecks pass; authenticated live entry bundle matches rebuilt web output.

- 2026-10-03 **Preserve console smoke evidence when browser shutdown times out** (Mosswick): syntax and test:console-probe pass; live timeout reproduces and now prints websocket, error, bundle and UI assertion results while retaining exit code 1. Probe script change requires no service restart.
- 2026-10-03 **Start immediately for queued tasks over both concurrency limits** (f70f5e8, Mosswick): 32 queue assertions, 9 desktop/phone browser checks, typechecks and slot/token-freeze/restart gates pass; deployed build matches f70f5e89 and authenticated served bundle contains the action. Production browser smoke hit a shutdown timeout.
- 2026-10-03 **Fill parallel-goal slots beyond the live critical path** (68cd577, Bramble Fuse): goal gates/typechecks pass; deployed build verified; goal steps 17/19/20 all implementing with running codex:gpt-6.1-sol runs. Authenticated per-repo cap increased 5→7 to fit four other active tasks in that repo; global cap remains 15, goal cap 3.
- 2026-10-02 **Release stale goal parallel-step waits after owner edits or Resume** (dfd1197, Bramble Fuse): goal gates and typecheck pass; deployed build verified; authenticated goal edit persisted waitReleased=true with settledSteps=14 and restored maxConcurrent=3.
- 2026-10-02 **Unpin a goal step to allow Codex routing** (Bramblewick): authenticated thread.model Auto and thread.resume both succeeded; SQLite confirms task ef2438cb-33b8-43db-9545-6e338502e16e implementing with model_request NULL, no error, and a running gpt-6.1-sol implementor on codex:gpt-6.1-sol.
