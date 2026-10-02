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

## Shipped, awaiting live proof

- **Release stale goal parallel-step waits after owner edits or Resume** (Bramble Fuse, 2026-10-02).
  Regression reproduces a held goal staying at one task after raising its limit; goal gates and typecheck verify release, slot counts and retained report history.

## Open

No open entries.

## Done (newest first; keep the last 20)

- 2026-10-02 **Unpin d2r step 15 to allow Codex routing** (Bramblewick): authenticated thread.model Auto and thread.resume both succeeded; SQLite confirms task ef2438cb-33b8-43db-9545-6e338502e16e implementing with model_request NULL, no error, and a running gpt-6.1-sol implementor on codex:gpt-6.1-sol.
