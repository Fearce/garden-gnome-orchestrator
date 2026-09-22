# Backlog

Reported problems and planned work that nobody has picked up yet. Each entry records **what was
reported and what evidence already exists**, so the task that picks it up starts from that evidence
instead of re-diagnosing from scratch. An entry is not a diagnosis: where the cause is unknown, it
lists the open possibilities rather than guessing.

Settled "should we adopt / replace X?" questions live in [`DECISIONS.md`](DECISIONS.md), not here.

When you pick an entry up, link your task/commit under it. When it's fixed, delete the entry in the
same commit as the fix. Git history keeps the record.

---

## Open

### The "Changes" (diff-review) view still doesn't work correctly

*Reported 2026-09-22 by the owner after playtesting. Not yet investigated.*

**Report.** The owner says the board's Changes/diff-review view is "still not working correctly",
even after an earlier fix. The report is general. It does not name a theme, a task, or a trigger.

**Prior fix (the evidence to start from).** Task **`d4c9a97d`** (`d4c9a97d-080e-434e-a8e6-c7ed25b87cb2`,
dispatched as "Fix orchestrator broken on Nocturne theme when reviewing changes", stored title
"Reproduce deliverables-viewing bug under Nocturne and default theme", now `closed`) fixed and
verified a **Nocturne-specific** version of this bug:

- Fix commit `d4bf91d` *fix(web): restore Nocturne task overlays*. On `[data-theme="nocturne"] .detail`,
  the entrance animation's fill mode changed from `both` to `backwards`. The forwards-filled transform
  had kept the task panel as the containing block for every `position: fixed` child, which trapped
  task-owned overlays (Changes, deliverable previews, implementation memos, chip popovers) inside the
  right column. Files: `web/src/themes/nocturne.css`, `web/scripts/themes.test.tsx`,
  `server/scripts/deliverables-lab.cjs`.
- The task posted six screenshot deliverables, which can be opened from its card: before/after for
  "Nocturne deliverable preview" and for "Nocturne Changes view", plus "Classic deliverable
  verification" and "Classic Changes verification".

**Open possibilities.** Keep all three open until evidence rules each one out:

1. **Regression.** Something after `d4bf91d` broke the Changes view again.
2. **Gap the fix didn't cover.** The fix was verified on Nocturne and Classic only, for the trigger
   paths that task exercised. The current failure could come from a different theme or appearance
   setting, a different way of opening the view, or a different kind of diff/changes payload (for
   example a large diff, binary files, a nested repo, or a task with no commits).
3. **A different bug with the same symptom.** It could be unrelated to the containing-block defect.

**First step for whoever picks this up.** Ask the owner, or reproduce, *what* is wrong and *where*
(theme, task, how the view was opened, what it shows versus what it should show). Only then choose
between the possibilities above. `npm run deliverables-lab --prefix server` is the existing headless
harness: since `d4bf91d` it opens Changes on a real working-tree unified diff under Nocturne and then
Classic, with full-viewport bounds checks. If it passes while the owner's case fails, the difference
between its fixture and the owner's case is the lead.
