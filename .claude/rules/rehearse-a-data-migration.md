# Rehearsing a data migration against the real DB before you deploy it

For any `migrate()` step that REWRITES or DELETES existing rows — a backfill, a de-duplication, a
retention prune. (A plain `ALTER TABLE … ADD COLUMN` needs none of this; see
`add-a-broadcast-collection.md` for the schema mechanics.) These run in the `Db` constructor, so they
execute on Kevin's ~300 MB production database the moment the hub restart lands, before the server
accepts a connection. A gate proves the LOGIC on a synthetic DB; only the real one has the scale and
the legacy row shapes.

## The recipe

`VACUUM INTO` gives a consistent snapshot from a READ-ONLY connection while prod keeps serving — no
lock, no risk to the live file. Point the real `Db` at the copy and diff the observable state:

```js
// server/scripts/_migration_dryrun.cjs — throwaway, `_`-prefixed so the deliverable detector skips it
const src = new Database("data/orchestrator.sqlite", { readonly: true });
src.exec(`VACUUM INTO '${dest.split(path.sep).join("/")}'`);   // forward slashes, even on Windows
src.close();
const before = snapshotInvariants(new Database(dest, { readonly: true }));
const t = Date.now();
const { Db } = require("../dist/db/db.js");     // dist, so you rehearse what you will actually ship
const migrated = new Db(dest);                  // the constructor IS the migration
console.log(Date.now() - t, "ms");              // ← the number nobody thinks to measure
compare(before, snapshotInvariants(migrated.raw));
```

**Assert what the user can observe, not that it ran.** The useful invariant is content-addressed: for
every reference, hash what it RESOLVES to, before and after. "205 rows became 137" proves nothing about
whether a picture silently changed; "all 333 references hash to the same bytes they did before" does.
Delete the script and the temp dir when finished — it isn't a repeatable test, it needs the live DB.

## What this actually caught (2026-08-05, `1cd7154` / `542615d`)

- **A 13.6s boot delay.** The compaction rewrote references with `UPDATE … WHERE attachments LIKE
  '%id%'`, re-reading all 188k messages once per duplicate. Correct, gated, invisible to every test —
  the synthetic DB had four rows. Re-indexed to one pass per table: 2.6s, byte-identical result. **Time
  the constructor**; keepAlive restarts a server that looks hung.
- **Proof of losslessness before touching 300 MB of Kevin's data**, which is what made deploying it a
  non-event rather than a gamble.

## Gotchas

- The snapshot is also a compaction (`VACUUM INTO` drops free pages), so it is SMALLER than the live
  file. Don't read that difference as your migration having freed something.
- Rehearse against `dist/`, not `src/` — you are testing the artifact the restart will load.
- A one-time step must be kv-flagged (`this.kvGet("<name>_v1")`) like `backfillDirectorThreadLinks`, or
  it re-scans on every boot forever. Rehearse the SECOND open too: reopening must be a no-op.
- Wrap it in `this.raw.transaction(...)`. A migration that throws half-way through the Db constructor
  gives you a crash-looping server against a partially-rewritten database.

Cross-refs: `threadmanager-itest.md` (the free gate that proves the logic — write it too, and do the
revert-check), `nightly-quality-sweep.md` §8 (`probe:db-size`, which is what notices the storage
problem a migration like this exists to fix).
