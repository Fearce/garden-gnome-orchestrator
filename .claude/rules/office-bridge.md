---
paths:
  - "server/src/agents/officeBridge.ts"
  - "server/src/agents/grokRunner.ts"
  - "server/src/agents/codexRunner.ts"
  - "server/src/tests/officeBridge.test.ts"
---

# CLI text bridges (Codex / Grok chat + owner notes + deliverables)

CLI backends have no MCP servers, so three surfaces reach them as markers in assistant
text, which the runner intercepts and strips:
- `OFFICE[team|office]: <msg>` → `chatPost` (the office chatroom).
- `OFFICE[name]: <name>` → `setOfficeName` (the `office_set_name` equivalent). There is no
  default name pool, so this is how a CLI agent gets any name at all; `cliRoleKickoff` and the
  kickoff's naming note both tell it to. Returned as `names`, never as a chat post. A name another
  agent used within 30 days is refused (`applyCliOfficeName`): an implementor is sent the refusal and
  must answer with a new `OFFICE[name]:` line; a one-shot role gets a free "Name 2" instead.
- `OPERATOR_NOTE: <line> | <https://…>` → the owner's note list, via the SAME
  `OperatorNotes` service the MCP tool uses (never a runner-owned DB write — the
  service is what clips, validates, de-dupes and broadcasts). The ` | url` suffix is
  optional: without it the service still lifts an http(s) link out of the line.
- `DELIVERABLE: <label> | <absolute path>` → a `kind='deliverable'` finding via
  `ThreadManager.postFinding`, with the current run id. This is the CLI equivalent of
  `post_deliverable`, so QA's deterministic backstop sees it and the open console gets
  the card immediately. Invalid grammar stays visible instead of deleting ordinary
  prose that happens to say "deliverable:".
- `GOAL_PROGRESS: {"items":[...]}` → `GoalRunner.recordWork` via
  `ThreadManager.recordCliGoalProgress`, the CLI form of `report_goal_progress` (one JSON
  line, like `SUBTASK:`). It is extracted first in `extractCliBridgeMessages`, and every body
  scanner stops at it. A payload that is not a JSON object stays visible. A report the goal
  refuses posts a warning finding, since a CLI agent has no tool result to read.

## Files
- `server/src/agents/officeBridge.ts` — all three extractors plus the shared
  `extractCliBridgeMessages` ordering seam
- `server/src/agents/grokRunner.ts` — segment harvest + final flush
- `server/src/agents/codexRunner.ts` — whole-message extract on agent_message
- `server/src/orchestrator/threadManager.ts` — authoritative note/deliverable writes, wired at all four runner-cfg sites
- `server/src/tests/officeBridge.test.ts` — unit gate

## Rules that bit (do not re-break)
- **Mid-segment Grok harvests: `openEnded: false`.** Thought events land mid-claim;
  treating end-of-buffer as complete posts truncations (`"claimi"`, `"\\n"`).
  Only the final flush after a clean CLI `end` may pass `openEnded: true`.
- **Don't let colon-side `\s*` eat the next line** into the body.
- **Glued model turns** (`claim.Implementing…`) must end the body before the
  capital so narration stays out of the chatroom.
- **A `DELIVERABLE:` path containing `"` is prose, not a card.** QA's own issue text tells the
  implementor to "surface it using post_deliverable or DELIVERABLE: label | absolute path", and a
  Codex QA quoted that inside its JSON verdict. Stripping it broke the JSON, so the task parked
  as "QA could not complete" (task 6b9aab39, 2026-10-05). Windows forbids `"` in filenames, so
  `splitDeliverable` refuses such a path and the line stays in the visible text.
- **Junk bodies** (empty, literal `\n`, punctuation-only) never post. The bridges share
  `isJunkOfficeBody` — a junk note is worse than a junk chat line, since the note list's
  whole value is that every row is worth clicking.
- **Order matters in the runners**: deliverables extract FIRST, office second, notes
  last. A reply carrying all three markers must deliver all three and leave none behind.
  Two consequences, both paid for (`f5a7218`): every body scanner must STOP at the next
  bridge marker; in particular `takeOfficeBody` must stop at an
  `OPERATOR_NOTE:` marker — Grok withholds the segment newline while an OFFICE marker
  is open, so the two arrive GLUED more often than on separate lines, and an office body
  that eats the note loses the row *and* broadcasts the PR link as a claim. And each
  extractor's final trim must respect the OTHER open markers, or it eats the trailing
  space the next chunk appends to (`claiming db.tsand schema.ts`).

- **The queued follow-up batch is bounded** (`agents/batchedInput.ts`). A CLI turn takes no mid-turn
  input, so every office push sent during an hours-long Codex/Grok turn is queued and joined into the
  next prompt. Unbounded, one batch reached 956,965 characters and the next turns were refused by Codex's
  `turn/start` limit (`input_too_large`, 1,048,576) after hours of work (2026-10-08). The bound keeps
  required inputs verbatim and trims only messages explicitly sent with `source: "ambient"`.
  Owner replies, Director messages, receipt-bearing text and image attachments remain required.
  Omitted messages receive no consumption receipt. Fresh recovery reserves its actual kickoff size.
  Don't join `pendingSends` by hand in a new runner. Gate: `test:batched-input`.

## Debug
```
npm run test:office-bridge --prefix server
npm run probe:office-chat --prefix server
npm run probe:office-chat --prefix server -- --thread <uuid>
```
Short project-room bodies or leftover `OFFICE[` / valid `DELIVERABLE:` in `messages` ⇒ extractor/harvest,
not a missing `onOfficeChat` wire (that path is already on both CLI runners).
