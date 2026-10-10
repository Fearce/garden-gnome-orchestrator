/**
 * The one-time walk that seeds `message_attachment_index` (schema.ts) with messages written before it.
 *
 * Every stage kickoff after a restart looks for the pictures the owner attached to its task. That read went
 * through the whole feed, and `attachments` sits behind `content` on overflow pages, so a long task cost
 * thousands of random reads on the event loop (2.9 s in crash.log, 2026-10-10) to find a handful of rows.
 * The table's triggers cover every write from the first boot; this walk adds the older rows in small chunks
 * while the console is already usable, and readers keep using the feed until it is done.
 */

/** kv keys: how far the walk has got, and whether it has finished. */
export const ATTACHMENT_INDEX_CURSOR_KEY = "message_attachment_index_cursor";
export const ATTACHMENT_INDEX_READY_KEY = "message_attachment_index_ready";

/** Rows per chunk. On a live-DB snapshot a 500-row chunk read in 0.5 ms typically and 350 ms at worst. */
export const ATTACHMENT_INDEX_CHUNK = 500;

/** Gap between chunks, so agent output keeps streaming while the walk runs. */
export const ATTACHMENT_INDEX_PAUSE_MS = 100;

export interface AttachmentIndexStep {
  indexed: number;
  done: boolean;
}

interface AttachmentIndexHost {
  backfillAttachmentIndexChunk(chunk: number): AttachmentIndexStep;
  attachmentIndexReady(): boolean;
}

/** Drive the walk to completion on a timer. The cursor is persisted per chunk and indexing a row twice
 *  replaces it with itself, so a restart mid-walk simply resumes. */
export function startAttachmentIndexBackfill(
  db: AttachmentIndexHost,
  log: (message: string) => void,
  chunk = ATTACHMENT_INDEX_CHUNK,
  pauseMs = ATTACHMENT_INDEX_PAUSE_MS,
): { done: Promise<void>; stop: () => void } {
  let timer: NodeJS.Timeout | null = null;
  let stopped = false;
  const stop = (): void => {
    stopped = true;
    if (timer) clearTimeout(timer);
    timer = null;
  };

  const done = new Promise<void>((resolve) => {
    if (db.attachmentIndexReady()) return resolve();
    const started = Date.now();
    let indexed = 0;
    const tick = (): void => {
      if (stopped) return resolve();
      let step: AttachmentIndexStep;
      try {
        step = db.backfillAttachmentIndexChunk(chunk);
      } catch (e) {
        // Kickoffs keep reading the feed, so stopping loses only speed; the next boot resumes here.
        log(`attachment index backfill stopped: ${e instanceof Error ? e.message : String(e)}`);
        return resolve();
      }
      indexed += step.indexed;
      if (step.done) {
        log(`attachment index ready — ${indexed} messages with attachments in ${Math.round((Date.now() - started) / 1000)}s`);
        return resolve();
      }
      // Not unref'd, like the search walk: a script awaiting `done` must not exit with it unsettled.
      timer = setTimeout(tick, pauseMs);
    };
    tick();
  });

  return { done, stop };
}
