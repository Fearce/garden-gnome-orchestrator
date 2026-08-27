# CLI text bridges (Codex / Grok chat + owner notes + deliverables)

CLI backends have no MCP servers, so three surfaces reach them as markers in assistant
text, which the runner intercepts and strips:
- `OFFICE[team|office]: <msg>` → `chatPost` (the office chatroom).
- `OPERATOR_NOTE: <line> | <https://…>` → the owner's note list, via the SAME
  `OperatorNotes` service the MCP tool uses (never a runner-owned DB write — the
  service is what clips, validates, de-dupes and broadcasts). The ` | url` suffix is
  optional: without it the service still lifts an http(s) link out of the line.
- `DELIVERABLE: <label> | <absolute path>` → a `kind='deliverable'` finding via
  `ThreadManager.postFinding`, with the current run id. This is the CLI equivalent of
  `post_deliverable`, so QA's deterministic backstop sees it and the open console gets
  the card immediately. Invalid grammar stays visible instead of deleting ordinary
  prose that happens to say "deliverable:".

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

## Debug
```
npm run test:office-bridge --prefix server
npm run probe:office-chat --prefix server
npm run probe:office-chat --prefix server -- --thread <uuid>
```
Short project-room bodies or leftover `OFFICE[` / valid `DELIVERABLE:` in `messages` ⇒ extractor/harvest,
not a missing `onOfficeChat` wire (that path is already on both CLI runners).
