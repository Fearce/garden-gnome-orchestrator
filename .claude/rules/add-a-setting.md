---
paths:
  - server/src/orchestrator/threadManager.ts
  - server/src/ws/protocol.ts
  - server/src/types.ts
  - web/src/components/SettingsPanel.tsx
---

# Adding an operator setting (the 6-file pattern)

Every operator-tunable setting follows one fixed shape. Touch all six spots —
missing one typechecks fine but silently drops the value at that layer:

1. `server/src/types.ts` — field on `OrchestratorSettings` (comment: default +
   what on/off means). `SettingsPatch` is DERIVED from this interface — no
   separate edit unless the field must be read-only (then add it to the `Omit`).
2. `server/src/ws/protocol.ts` — same field in the `settings.set` zod object
   (it's `.partial()`, so just the base type, e.g. `z.boolean()`).
3. `server/src/orchestrator/threadManager.ts` `settings()` — read via
   `this.settingBool("setting_<snake_case>", <default>)` / `settingNum(...)`.
4. `threadManager.ts` `setSettings()` — persist:
   `if (patch.x !== undefined) this.db.kvSet("setting_<snake_case>", ...)`.
   Booleans store `"1"`/`"0"`. Broadcast + queue-pump happen at the end already.
5. `web/src/types.ts` — mirror the field on the web `OrchestratorSettings`.
6. `web/src/store.ts` `DEFAULT_SETTINGS` + `web/src/components/SettingsPanel.tsx`
   — default (must match the server's) and a `ToggleRow`/`NumberRow`/`TextRow`
   in the right `Group`.

Conventions that bite:
- Settings are read LIVE at use time (`this.settings().x`), never snapshotted at
  dispatch — so a toggle applies to tasks already in flight. Match that unless
  you have a reason not to (then snapshot onto the thread row, like effort).
- kv key is `setting_` + snake_case of the field name. Keep them aligned.
- The default appears in three places (settingBool arg, web DEFAULT_SETTINGS,
  the panel hint text) — keep all three telling the same story.

Verify: `npm run typecheck && npm run build`, then browser-test the round-trip
on a throwaway instance (recipe: project memory `browser-test-throwaway-instance`
— alt ports, EMPTY temp DB, auth blanked; kill it by PORT owner via
`Get-NetTCPConnection -LocalPort 4327` → `Stop-Process`, NOT `pkill -f node`,
which silently no-ops in Git Bash on Windows and could match prod). Server
change ⇒ deploy yourself via the atomic hub restart (see CLAUDE.md).
