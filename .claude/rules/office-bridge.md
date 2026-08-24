# CLI text bridges (Codex / Grok team chat + owner notes)

CLI backends have no MCP servers, so two surfaces reach them as markers in assistant
text, which the runner intercepts and strips:
- `OFFICE[team|office]: <msg>` → `chatPost` (the office chatroom).
- `OPERATOR_NOTE: <line> | <https://…>` → the owner's note list, via the SAME
  `OperatorNotes` service the MCP tool uses (never a runner-owned DB write — the
  service is what clips, validates, de-dupes and broadcasts). The ` | url` suffix is
  optional: without it the service still lifts an http(s) link out of the line.

## Files
- `server/src/agents/officeBridge.ts` — both extractors (`extractOfficeChat`, `extractOperatorNotes`)
- `server/src/agents/grokRunner.ts` — segment harvest + final flush
- `server/src/agents/codexRunner.ts` — whole-message extract on agent_message
- `server/src/orchestrator/threadManager.ts` — `postCliOperatorNote`, wired at all four runner-cfg sites
- `server/src/tests/officeBridge.test.ts` — unit gate

## Rules that bit (do not re-break)
- **Mid-segment Grok harvests: `openEnded: false`.** Thought events land mid-claim;
  treating end-of-buffer as complete posts truncations (`"claimi"`, `"\\n"`).
  Only the final flush after a clean CLI `end` may pass `openEnded: true`.
- **Don't let colon-side `\s*` eat the next line** into the body.
- **Glued model turns** (`claim.Implementing…`) must end the body before the
  capital so narration stays out of the chatroom.
- **Junk bodies** (empty, literal `\n`, punctuation-only) never post. Both bridges share
  `isJunkOfficeBody` — a junk note is worse than a junk chat line, since the note list's
  whole value is that every row is worth clicking.
- **Order matters in the runners**: office extracts FIRST, notes run over what it left
  visible. A reply carrying both markers must deliver both and leave neither behind.

## Debug
```
npm run test:office-bridge --prefix server
npm run probe:office-chat --prefix server
npm run probe:office-chat --prefix server -- --thread <uuid>
```
Short project-room bodies or leftover `OFFICE[` in `messages` ⇒ extractor/harvest,
not a missing `onOfficeChat` wire (that path is already on both CLI runners).
