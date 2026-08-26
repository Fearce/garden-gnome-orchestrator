/**
 * The trigram index behind the console's task search, and the one-time walk that populates it.
 *
 * The search has always been `content LIKE '%q%'` over `messages` — unindexable by construction, and
 * that table is now ~105 MB of tool output, so every keystroke re-read all of it on the server's only
 * thread. `messages_fts` (schema.ts) makes the same question an index lookup.
 */

/** The trigram tokenizer indexes every 3-character window, so it has nothing to say about a shorter
 *  query — and a 1- or 2-character MATCH returns zero rows *silently* rather than erroring, which
 *  would turn "slow" into "finds nothing". Callers must treat a null expression as "not indexable". */
export const TRIGRAM_LEN = 3;

const quoteFts = (s: string): string => `"${s.replace(/"/g, '""')}"`;

/**
 * An FTS5 expression matching a superset of the rows whose content contains `q`.
 *
 * A superset, not the exact set, and deliberately so: `detail=none` stores no token positions, so it
 * cannot evaluate the phrase query that would be exact ("fts5: phrase queries are not supported").
 * ANDing the query's own trigrams is the next best filter — measured over-fetch on real data is
 * ~0.2% (2,885 candidates for 2,881 hits) — and the caller re-applies the real `LIKE ... ESCAPE`
 * to every candidate, so what the search returns stays byte-identical to the scan this replaces.
 *
 * Returns null for a query too short to have a trigram.
 */
export function trigramMatchExpr(q: string): string | null {
  // Slice by CODE POINT, not by JS string index. SQLite's trigram tokenizer counts characters, so
  // cutting "emoji 🍦" with `String.slice` hands it a 2-character term (space + astral char, which is
  // two UTF-16 units) that tokenizes to nothing and matches nothing — a search silently missing every
  // message containing an emoji, which agent output is full of.
  const chars = [...q];
  if (chars.length < TRIGRAM_LEN) return null;
  // Non-overlapping windows plus one anchored at the end cover every character of the query while
  // keeping a 200-character query (the protocol's cap) to a few dozen AND terms instead of ~200.
  // Any subset of the trigrams is still a superset of the answer, so dropping the overlaps is safe.
  const terms: string[] = [];
  for (let i = 0; i + TRIGRAM_LEN <= chars.length; i += TRIGRAM_LEN) terms.push(chars.slice(i, i + TRIGRAM_LEN).join(""));
  const tail = chars.slice(chars.length - TRIGRAM_LEN).join("");
  if (terms[terms.length - 1] !== tail) terms.push(tail);
  return [...new Set(terms)].map(quoteFts).join(" AND ");
}

/** kv keys: how far the backfill walk has got, and whether it has finished. */
export const FTS_CURSOR_KEY = "messages_fts_cursor";
export const FTS_READY_KEY = "messages_fts_ready";

/** Rows per chunk. ~60 ms of indexing per 1,000 rows on this hardware, so this keeps each turn of the
 *  walk well under a frame while still finishing ~370k rows in about a minute. */
export const BACKFILL_CHUNK = 500;

/** Gap between chunks — the whole point of chunking is that agent output keeps streaming meanwhile. */
export const BACKFILL_PAUSE_MS = 50;

/** The two triggers that ADD rows to the index. Installed only when the walk is complete, in the same
 *  transaction as its final catch-up: while the walk is still running they would race it and
 *  double-index any row inserted above the cursor. The DELETE trigger has no such hazard (it is a
 *  tombstone on a contentless_delete table) and so ships in SCHEMA, live from the first boot. */
export const FTS_WRITE_TRIGGERS = `
CREATE TRIGGER IF NOT EXISTS messages_fts_ai AFTER INSERT ON messages BEGIN
  INSERT INTO messages_fts(rowid, content) VALUES (new.rowid, new.content);
END;
CREATE TRIGGER IF NOT EXISTS messages_fts_au AFTER UPDATE ON messages BEGIN
  DELETE FROM messages_fts WHERE rowid = old.rowid;
  INSERT INTO messages_fts(rowid, content) VALUES (new.rowid, new.content);
END;
`;

/** What one turn of the walk did, so the driver can pace itself and report progress. */
export interface BackfillStep {
  indexed: number;
  done: boolean;
}

interface BackfillHost {
  backfillSearchIndexChunk(chunk: number): BackfillStep;
  searchIndexReady(): boolean;
}

/**
 * Drive the walk to completion on a timer, off the request path. Resolves when the index is live.
 *
 * Crash-safe by construction: the cursor is persisted per chunk and nothing else writes to the index
 * until the walk finishes, so a restart mid-walk simply resumes — which matters here, where the
 * server is bounced routinely and the walk takes about a minute.
 */
export function startSearchIndexBackfill(
  db: BackfillHost,
  log: (message: string) => void,
  chunk = BACKFILL_CHUNK,
  pauseMs = BACKFILL_PAUSE_MS,
): { done: Promise<void>; stop: () => void } {
  let timer: NodeJS.Timeout | null = null;
  let stopped = false;
  const stop = (): void => {
    stopped = true;
    if (timer) clearTimeout(timer);
    timer = null;
  };

  const done = new Promise<void>((resolve) => {
    if (db.searchIndexReady()) return resolve();
    const started = Date.now();
    let indexed = 0;
    let announced = false;
    const tick = (): void => {
      if (stopped) return resolve();
      let step: BackfillStep;
      try {
        step = db.backfillSearchIndexChunk(chunk);
      } catch (e) {
        // Leave the cursor where it is and stop: search keeps working (it falls back to the scan)
        // and the next boot retries from here rather than looping on a broken chunk.
        log(`search index backfill stopped: ${e instanceof Error ? e.message : String(e)}`);
        return resolve();
      }
      indexed += step.indexed;
      if (!announced && step.indexed > 0) {
        announced = true;
        log("building the message search index — search falls back to a full scan until it is ready");
      }
      if (step.done) {
        if (announced) log(`search index ready — ${indexed} messages in ${Math.round((Date.now() - started) / 1000)}s`);
        return resolve();
      }
      timer = setTimeout(tick, pauseMs);
    };
    tick();
  });

  return { done, stop };
}
