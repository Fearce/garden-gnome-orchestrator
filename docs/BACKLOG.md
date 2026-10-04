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

- **Fix duplicated composer repo chips (slash/case spellings of one workspace)** (Twinpicker, 2026-10-04).

## Ready (priority order)

1. **Investigate console smoke served/local bundle mismatch and browser shutdown timeout**: 2026-10-03 probe reports ws=live with no console errors, served index-C8zofTVy.js versus local index-BHXtYnz4.js, and browser shutdown exceeded 5000ms; authenticated HTTP bundle verification passed earlier in the same task.

## Open

No open entries.

## Done (newest first; keep the last 20)

- 2026-10-03 **Allow model changes on paused tasks with stale running implementor records** (Bramble Quill): 20 desktop/phone browser checks, 50 model-routing checks, UI gate and all typechecks pass; authenticated live entry bundle matches rebuilt web output.

- 2026-10-03 **Preserve console smoke evidence when browser shutdown times out** (Mosswick): syntax and test:console-probe pass; live timeout reproduces and now prints websocket, error, bundle and UI assertion results while retaining exit code 1. Probe script change requires no service restart.
- 2026-10-03 **Start immediately for queued tasks over both concurrency limits** (f70f5e8, Mosswick): 32 queue assertions, 9 desktop/phone browser checks, typechecks and slot/token-freeze/restart gates pass; deployed build matches f70f5e89 and authenticated served bundle contains the action. Production browser smoke hit a shutdown timeout.
- 2026-10-03 **Fill parallel-goal slots beyond the live critical path** (68cd577, Bramble Fuse): goal gates/typechecks pass; deployed build verified; d2r steps 17/19/20 all implementing with running codex:gpt-6.1-sol runs. Authenticated per-repo cap increased 5→7 to fit four other active d2r tasks; global cap remains 15, goal cap 3.
- 2026-10-02 **Release stale goal parallel-step waits after owner edits or Resume** (dfd1197, Bramble Fuse): goal gates and typecheck pass; deployed build verified; authenticated d2r edit persisted waitReleased=true with settledSteps=14 and restored maxConcurrent=3.
- 2026-10-02 **Unpin d2r step 15 to allow Codex routing** (Bramblewick): authenticated thread.model Auto and thread.resume both succeeded; SQLite confirms task ef2438cb-33b8-43db-9545-6e338502e16e implementing with model_request NULL, no error, and a running gpt-6.1-sol implementor on codex:gpt-6.1-sol.
