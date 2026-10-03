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

## Open

No open entries.

## Done (newest first; keep the last 20)

- 2026-10-03 **Fill parallel-goal slots beyond the live critical path** (68cd577, Bramble Fuse): goal gates/typechecks pass; deployed build verified; d2r steps 17/19/20 all implementing with running codex:gpt-6.1-sol runs. Authenticated per-repo cap increased 5→7 to fit four other active d2r tasks; global cap remains 15, goal cap 3.
- 2026-10-02 **Release stale goal parallel-step waits after owner edits or Resume** (dfd1197, Bramble Fuse): goal gates and typecheck pass; deployed build verified; authenticated d2r edit persisted waitReleased=true with settledSteps=14 and restored maxConcurrent=3.
- 2026-10-02 **Unpin d2r step 15 to allow Codex routing** (Bramblewick): authenticated thread.model Auto and thread.resume both succeeded; SQLite confirms task ef2438cb-33b8-43db-9545-6e338502e16e implementing with model_request NULL, no error, and a running gpt-6.1-sol implementor on codex:gpt-6.1-sol.
