---
paths:
  - server/src/agents/prompts.ts
  - server/src/agents/roles.ts
  - server/src/orchestrator/threadManager.ts
  - server/src/tests/qaRoundBudget.itest.ts
---

# QA roles that edit task work

The normal QA role is read-only. When a pipeline option allows QA to edit task files, it becomes an
owner of real repository state rather than a reviewer-only stage. Treat that as a commit-boundary change,
not merely a prompt or permission change.

## Required invariants

1. An editing QA run must stage only its own hunks and make a focused Conventional Commit before it
   returns. It pushes unless the task's captured `autoPush` policy is off or the repository's Vota
   commit-only rule applies. A task must never settle `done` with QA-created working-tree edits.
2. A QA run that reports `changed: true` is never its own final acceptance decision. Route the next
   QA pass to a different ready provider where possible. If only the same provider is available, force
   a **fresh session**; do not warm-resume the editor's session.
3. `changed` is load-bearing pipeline control flow, so it belongs in the structured-output schema's
   `required` list. Read-only QA must emit `changed: false` too, keeping one stable verdict contract
   across providers.
4. The task-specific QA kickoff carries the captured auto-push policy. Do not re-read a live setting
   mid-episode: a task that began with auto-push off must remain commit-only through its QA rounds.
5. The setting remains opt-in. Its persisted default and the browser's fallback default must both be
   false; after local/manual testing, reset a production `setting_qa_applies_fixes` row to `0` before
   handoff unless the owner explicitly wants it enabled.

## Regression coverage

Extend `test:qa-budget` when changing this flow. At minimum prove that an editing QA pass:

- starts a verifier QA pass without re-launching the implementor;
- forwards the task's auto-push policy; and
- forces `forceFresh` for a same-provider verifier.

Also run `test:structured`, `typecheck`, and `build`. For a change to this live pipeline, use an
isolated `DATA_DIR` harness before spending quota on a real end-to-end task.
