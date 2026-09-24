// Board audit for the one-shot 2026-09-24 shutdown. Exit 0 = idle, 1 = busy, 2 = error.
const path = require('node:path');
const Database = require('../server/node_modules/better-sqlite3');

const scheduleId = '4e52d3f9-ca5c-4b3b-a1fc-dbfc15ba511d';
const deadline = Date.parse('2026-09-24T03:00:00+02:00');
const dbPath = path.join(__dirname, '..', 'server', 'data', 'orchestrator.sqlite');
let db;
try {
  const action = process.argv[2];
  // Exclude only the current scheduled check thread. Older fires remain ordinary
  // unfinished GGO work if one is still queued or running.
  const requestedSelfId = process.argv[3] || null;
  if (!['--check', '--disable', '--restore', '--expire'].includes(action)) {
    throw new Error('Expected --check, --disable, --restore, or --expire');
  }
  if (process.argv.length > 4 || (requestedSelfId && !['--check', '--disable'].includes(action))) {
    throw new Error('Only --check and --disable accept an optional current GGO thread ID');
  }
  db = new Database(dbPath, { readonly: action === '--check', fileMustExist: true });
  db.pragma('busy_timeout = 5000');
  const schedule = db.prepare('SELECT * FROM scheduled_tasks WHERE id = ?').get(scheduleId);
  if (!schedule || (action !== '--expire' && schedule.cron !== '*/5 * * * *')) {
    throw new Error('Expected GGO schedule is missing or changed');
  }
  const threadById = db.prepare('SELECT id, title, workspace, brief, raw_prompt, state, created_at FROM threads WHERE id = ?');
  const matchesScheduledCheck = thread => thread && thread.title === schedule.title &&
    thread.workspace === schedule.workspace && thread.brief === schedule.prompt && thread.raw_prompt === '' &&
    thread.created_at >= schedule.created_at;
  const activeStates = ['queued', 'planning', 'researching', 'implementing', 'qa', 'reviewing'];
  const latest = schedule.last_thread_id ? threadById.get(schedule.last_thread_id) : null;
  const selfThreadId = requestedSelfId || (matchesScheduledCheck(latest) && activeStates.includes(latest.state) ? latest.id : null);
  const self = selfThreadId && threadById.get(selfThreadId);
  if (requestedSelfId && (!matchesScheduledCheck(self) || !activeStates.includes(self.state))) {
    throw new Error('Cannot verify the current scheduled check thread');
  }

  // Each five-minute fire creates a separate GGO thread. Match the current run
  // by its recorded ID; title/prompt matching alone would hide older active fires.
  const unfinishedQuery = db.prepare(`
    SELECT id, title, state FROM threads
    WHERE state NOT IN ('done', 'cancelled', 'closed')
      AND id != ?
    ORDER BY created_at DESC
  `);
  const unfinished = () => unfinishedQuery.all(selfThreadId || '');
  if (action === '--disable' || action === '--expire') {
    db.transaction(() => {
      if (action === '--expire' && Date.now() < deadline) {
        throw new Error('Cannot expire the GGO schedule before the fixed 03:00 deadline');
      }
      if (action === '--disable' && unfinished().length) {
        throw new Error('Other GGO tasks became unfinished; schedule remains enabled');
      }
      const changed = db.prepare('UPDATE scheduled_tasks SET enabled = 0, next_run_at = NULL, updated_at = ? WHERE id = ?').run(Date.now(), scheduleId);
      const verified = db.prepare('SELECT enabled, next_run_at FROM scheduled_tasks WHERE id = ?').get(scheduleId);
      if (changed.changes !== 1 || verified?.enabled !== 0 || verified.next_run_at !== null) {
        throw new Error('Could not verify the GGO schedule is disabled');
      }
    })();
    console.log('GGO schedule disabled and verified');
    process.exitCode = 0;
  } else if (action === '--restore') {
    if (Date.now() >= deadline) throw new Error('Cannot restore the GGO schedule after the deadline');
    const nextRun = Math.floor(Date.now() / 300_000 + 1) * 300_000;
    db.prepare('UPDATE scheduled_tasks SET enabled = 1, next_run_at = ?, updated_at = ? WHERE id = ?')
      .run(nextRun, Date.now(), scheduleId);
    const verified = db.prepare('SELECT enabled, next_run_at FROM scheduled_tasks WHERE id = ?').get(scheduleId);
    if (verified?.enabled !== 1 || verified.next_run_at !== nextRun) {
      throw new Error('Could not restore the GGO schedule');
    }
    console.log('GGO schedule restored and verified');
    process.exitCode = 0;
  } else if (action === '--check') {
    const remaining = unfinished();
    console.log(JSON.stringify({ checkedAt: new Date().toISOString(), unfinished: remaining }));
    process.exitCode = remaining.length ? 1 : 0;
  }
} catch (error) {
  console.error(`Board audit failed: ${error.message}`);
  process.exitCode = 2;
} finally {
  db?.close();
}
