# Adding a server-authoritative broadcast collection + WS commands + view

For a whole new persisted entity the console lists and edits live — the Scheduled
Tasks feature is the reference. (For a single tunable knob use `add-a-setting.md`
instead. This is the bigger pattern: its own table, CRUD commands, a broadcast, and
a view.) Touch every spot — missing one typechecks fine but silently drops the value
at that layer:

1. `server/src/db/schema.ts` — the table via `CREATE TABLE IF NOT EXISTS`. A BRAND-NEW
   table needs NO `migrate()` entry (`exec(SCHEMA)` runs every boot); only ADDING a
   column to an existing table needs an `ALTER` line in `migrate()`.
2. `server/src/types.ts` — the domain interface (mirrored byte-for-byte in `web/src/types.ts`).
3. `server/src/db/db.ts` — a `rowToX` mapper + `create/get/list/update/delete` methods.
   Build a dynamic `UPDATE` from a FIXED whitelist `map` (never user keys) with `@named`
   params; coerce booleans to `0/1` on both insert and update.
4. NEW module `server/src/orchestrator/<x>.ts` — the service. Keep it STANDALONE: depend
   on a `dispatch` callback + `Db` + `EventHub`, NOT on `ThreadManager` (avoids the import
   cycle AND lets a concurrent agent edit threadManager without clobbering you). Broadcast
   the full list on every mutation: `hub.publish({ type: "x", x: this.list() })`.
5. `server/src/ws/protocol.ts` — the `x` ServerEvent + the field on the `hello` event, and
   the `x.create/x.update/x.delete` client commands (zod, validated at the boundary).
6. `server/src/ws/hub.ts` — `WsContext.<service>`, the `x.*` command handlers in
   `handleCommand`, and the field in `buildHello`.
7. `server/src/index.ts` — instantiate the service, pass it into `registerWs` ctx (and any
   consumer, e.g. `Director` gets a scheduler for its MCP tools).
8. `web/src/types.ts` — mirror the interface + the ServerEvent/ClientCommand additions.
9. `web/src/store.ts` — the state field + initial value, the actions (each `sendCommand`s),
   the `case "x":` handler, AND fold the field into the `hello` case with the version-skew
   guard the others use: `...(ev.x ? { x: ev.x } : {})`.
10. `web/src/components/<X>.tsx` — the view; wire a trigger (a header tab, a button).

Conventions that bite:
- The broadcast is the ONLY source of truth the client trusts — mutations are
  optimism-free (send the command, let the `x` broadcast reconcile). Don't mirror
  state locally on write.
- Director MCP tools that touch the collection need the tool NAME registered in
  `agents/toolNames.ts` AND added to `DIRECTOR_TOOLS` (the allowedTools list) — a tool
  the SDK can call but isn't allowlisted silently no-ops.
- Playwright E2E: scope selectors to the component/modal (`.sched-modal .ws-wrap input`),
  NOT bare utility classes — `.ws-wrap`/`.btn` also live in the Director composer, and a
  bare `text=`/class selector clicks the FIRST match in another pane, not your modal.

Verify: `npm run typecheck && npm run build`, then a throwaway-instance browser E2E
(recipe: `e2e-a-pipeline-lane.md` + project memory `browser-test-throwaway-instance`).
