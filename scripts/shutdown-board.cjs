// Board audit for the one-shot 2026-09-24 shutdown. Exit 0 = idle, 1 = busy, 2 = error.
const path = require('node:path');
const Database = require('../server/node_modules/better-sqlite3');

const scheduleId = '4e52d3f9-ca5c-4b3b-a1fc-dbfc15ba511d';
const deadline = Date.parse('2026-09-24T03:00:00+02:00');
const dbPath = path.join(__dirname, '..', 'server', 'data', 'orchestrator.sqlite');
let db;
try {
  const action = process.argv[2];
  if (!['--check', '--disable', '--restore', '--expire'].includes(action)) {
    throw new Error('Expected --check, --disable, --restore, or --expire');
  }
  db = new Database(dbPath, { readonly: action === '--check', fileMustExist: true });
  db.pragma('busy_timeout = 5000');
  const schedule = db.prepare('SELECT * FROM scheduled_tasks WHERE id = ?').get(scheduleId);
  if (!schedule || schedule.cron !== '*/5 * * * *') throw new Error('Expected five-minute GGO schedule is missing or changed');
  const self = schedule.last_thread_id && db.prepare('SELECT id, title, workspace, created_at FROM threads WHERE id = ?').get(schedule.last_thread_id);
  if (action !== '--expire' && (!self || self.title !== schedule.title || self.workspace !== schedule.workspace || self.created_at < schedule.created_at)) {
    throw new Error('Cannot identify the current scheduled check thread');
  }

  const unfinishedQuery = db.prepare(`
    SELECT id, title, state FROM threads
    WHERE state NOT IN ('done', 'cancelled', 'closed')
      AND id != ?
    ORDER BY created_at DESC
  `);
  if (action === '--disable' || action === '--expire') {
    db.transaction(() => {
      if (action === '--expire' && Date.now() < deadline) {
        throw new Error('Cannot expire the GGO schedule before the fixed 03:00 deadline');
      }
      if (action === '--disable' && unfinishedQuery.all(self.id).length) {
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
    const unfinished = unfinishedQuery.all(self.id);
    console.log(JSON.stringify({ checkedAt: new Date().toISOString(), unfinished }));
    process.exitCode = unfinished.length ? 1 : 0;
  }
} catch (error) {
  console.error(`Board audit failed: ${error.message}`);
  process.exitCode = 2;
} finally {
  db?.close();
}
