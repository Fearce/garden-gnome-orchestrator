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

- **Independently verify README/privacy fixes and repair the remediation kit** (Codex QA, 2026-10-04, branch ggo/readme-privacy-audit-6ff32a00).

- **Owner messages stuck on "Sending…": GGO event-loop stalls and receipt states** (Wickfern, 2026-10-04, branch ggo/event-loop-stalls-913d9247).
  Stalls up to 45.8s on 2026-10-04 16:14Z delayed an inject that was delivered once (receipt ffaa6433 read); diagnostics 31192a9 live; fix + receipt UI in progress.

## Shipped, awaiting live proof

- **Calendar events with an unspecified end** (Thistle Gauge, branch ggo/calendar-start-only-dcb4ded9).
  Focused calendar gates and 78/78 browser lab checks pass; awaiting integration and deployment.

## Ready (priority order)

1. **Investigate console smoke served/local bundle mismatch and browser shutdown timeout**: 2026-10-03 probe reports ws=live with no console errors, served index-C8zofTVy.js versus local index-BHXtYnz4.js, and browser shutdown exceeded 5000ms; authenticated HTTP bundle verification passed earlier in the same task.

## Blocked / waiting

- **Rewrite published history to remove personal details the tree no longer carries** (owner action: filter-repo + force-push master, delete the five stale remote branches other than master, GitHub Support for PR refs).
  Kit with exact steps, dry-run 2026-10-04 (all-history hits to 0, nothing pushed): the README in the main checkout's gitignored `_privacy-remediation` folder.
- **Rotate the local HTTPS PFX passphrase** (owner action): it is a weak dictionary word, and `npm run audit:secrets --prefix server` finds that word in four reachable published commits (value withheld), so treat it as exposed: set a random passphrase, re-encrypt the PFX and update `server/.env`.

- **Privacy QA: deliver the history-remediation kit and correct its credential assurance** (implementor follow-up).
  Its README and supporting rewrite files are outside the task workspace; the configured PFX passphrase also occurs in reachable published history (value withheld), so the kit's "no credentials ever committed" assurance needs correction and rotation remains required.

## Open

No open entries.

## Done (newest first; keep the last 20)

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
