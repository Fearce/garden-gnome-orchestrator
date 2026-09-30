---
paths:
  - server/src/agents/modelFamily.ts
  - server/src/agents/codexModelGeneration.ts
  - server/src/agents/modelCatalog.ts
  - server/src/orchestrator/claudeOpusFloor.ts
  - server/src/orchestrator/modelRequest.ts
  - server/src/orchestrator/modelRoutingPolicy.ts
  - server/src/orchestrator/tokenConservation.ts
  - server/src/tests/modelFamily.itest.ts
  - web/src/lib/models.ts
---

# Newest-in-family — the model-version invariant

Owner rule (2026-09-30, after a sub-agent ran `gpt-6-sol` while `gpt-6.1-sol` was installed): GGO never
runs an older member of a model LINE when a newer member is available, and a release reconfigures GGO with
no manual step. A different line is a choice: Sonnet beside Opus, Luna/Spark beside Sol. The design is in
`docs/ARCHITECTURE.md` § "Newest in family"; these are the traps.

- **Never write a hand-kept "latest model" list or compare against an id literal.** Resolve through
  `latestFamilyModel` (the process-wide roster) or `newestInFamily(id, rosterInHand)`. `=== "gpt-6-sol"`,
  `=== DEFAULT_FLAGSHIP_MODEL` and `.has(model)` on a set of ids all silently reject the next release. The
  routing policy uses `atOrAbove`, conservation uses `sameModelFamily` — copy those.
- **Unknown naming passes through untouched, deliberately.** An id the parsers in `modelFamily.ts` cannot
  read (`gpt-daybreak-blue-latest`, the `opus` alias) is never "upgraded" by guesswork. A provider that
  ships a new naming scheme needs a new parser plus a `test:model-family` case — until then its models are
  simply not family-managed.
- **The roster cache keys on `ModelCatalog.cacheSignature()`** (the raw `cache_*_models` kv values), plus a
  60 s max age for what the signature cannot see (which Codex login is active). So a gate that writes a
  catalog kv directly sees the new roster on its next call, with no invalidate call. Do not go back to a
  plain TTL: `test:auto-model` read a 5 s-stale roster within one harness.
- **Stored state is REWRITTEN, not just re-read** (`migrateSupersededModels`, at boot, on each catalog
  change and after `setSettings`). Gates asserting "the raw row keeps the old id" are now wrong by design,
  so update them rather than weakening the migration. Finished tasks and settled goal steps are history
  and stay untouched.
- **Only the family rule migrates.** Cross-line mappings stay read-time rules: pre-GPT-6 → GPT-6
  (`currentCodexModel`) and the Opus floor (`claudeOpusTarget`, which lifts a Sonnet ROLE to Opus).
  Migrating them would erase the operator's legacy pick that the review floor still needs to see.
- **The web never merges its built-in suggestions into a server list** (`web/src/lib/models.ts`). The
  server lists are already curated + live + saved and family-filtered, and re-merging `CODEX_MODELS`
  re-offered `gpt-6-sol` beside `gpt-6.1-sol`. Built-ins only stand in before the server list arrives.
- **Revert-check:** removing either `migrateSupersededModels()` from the constructor or the
  `latestFamilyModel` line in `AgentRun`'s constructor turns `test:model-family` red (13 assertions,
  verified 2026-09-30).
