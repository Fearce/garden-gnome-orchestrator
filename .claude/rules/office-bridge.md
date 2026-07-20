# CLI office bridge (Codex / Grok team chat)

CLI backends have no office MCP. They post via `OFFICE[team|office]: <msg>` in
assistant text; the runner intercepts, strips, and calls `chatPost`.

## Files
- `server/src/agents/officeBridge.ts` — shared extractor (`extractOfficeChat`)
- `server/src/agents/grokRunner.ts` — segment harvest + final flush
- `server/src/agents/codexRunner.ts` — whole-message extract on agent_message
- `server/src/tests/officeBridge.test.ts` — unit gate

## Rules that bit (do not re-break)
- **Mid-segment Grok harvests: `openEnded: false`.** Thought events land mid-claim;
  treating end-of-buffer as complete posts truncations (`"claimi"`, `"\\n"`).
  Only the final flush after a clean CLI `end` may pass `openEnded: true`.
- **Don't let colon-side `\s*` eat the next line** into the body.
- **Glued model turns** (`claim.Implementing…`) must end the body before the
  capital so narration stays out of the chatroom.
- **Junk bodies** (empty, literal `\n`, punctuation-only) never post.

## Debug
```
npm run test:office-bridge --prefix server
npm run probe:office-chat --prefix server
npm run probe:office-chat --prefix server -- --thread <uuid>
```
Short project-room bodies or leftover `OFFICE[` in `messages` ⇒ extractor/harvest,
not a missing `onOfficeChat` wire (that path is already on both CLI runners).
