// Read-only diagnosis of the live tool-call watermark query.
// Candidate index changes are tested exclusively in an in-memory fixture.
// node server/scripts/optimize-tool-digest.cjs --self-test
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const path = require('node:path');
const Database = require('better-sqlite3');
const INDEX = 'idx_messages_tool_thread_time'; // Keep the name required by the running query.
const SQL = `SELECT rowid AS seq, role, content FROM messages INDEXED BY ${INDEX}
  WHERE thread_id = ? AND rowid > ? AND kind = 'tool' ORDER BY created_at ASC, rowid ASC`;
const definition = `CREATE INDEX ${INDEX} ON messages(thread_id) WHERE kind = 'tool'`;

function layout(db) {
  return db.pragma(`index_info(${INDEX})`).map(column => column.name);
}
function tune(db) {
  assert.equal(db.name, ':memory:', 'index experiments are restricted to in-memory fixtures');
  const columns = layout(db);
  if (columns.join(',') === 'thread_id') return false;
  assert.equal(columns.join(','), 'thread_id,created_at', 'unknown index layout; refusing to replace it');
  db.transaction(() => { db.exec(`DROP INDEX ${INDEX}`); db.exec(definition); })();
  return true;
}
function measure(db, threadId, afterSeq) {
  const start = performance.now();
  const rows = db.prepare(SQL).all(threadId, afterSeq);
  return { ms: +(performance.now() - start).toFixed(3), rows: rows.length,
    hash: createHash('sha256').update(JSON.stringify(rows)).digest('hex') };
}
function selfTest() {
  const db = new Database(':memory:');
  try {
    db.exec(`CREATE TABLE messages(thread_id TEXT, role TEXT, content TEXT, kind TEXT, created_at INTEGER);
      CREATE INDEX ${INDEX} ON messages(thread_id, created_at) WHERE kind = 'tool'`);
    const insert = db.prepare('INSERT INTO messages VALUES(?,?,?,?,?)');
    db.transaction(() => {
      for (let i = 0; i < 10000; i++) insert.run(i % 2 ? 'other' : 'task', 'implementor', `call ${i}`,
        i % 3 ? 'tool' : 'text', 10000 - i);
    })();
    const inputs = [['task', 0], ['task', 9000], ['task', 10000], ['other', 20], ['absent', 0]];
    const before = inputs.map(args => measure(db, ...args));
    assert.equal(tune(db), true);
    inputs.forEach((args, i) => {
      const after = measure(db, ...args);
      assert.equal(after.hash, before[i].hash, 'full and incremental tool results must remain byte-identical');
      assert.equal(after.rows, before[i].rows);
    });
    const plan = db.prepare(`EXPLAIN QUERY PLAN ${SQL}`).all('task', 9000).map(row => row.detail).join('; ');
    assert.match(plan, /thread_id=\? AND rowid>\?/, 'the watermark must be an index seek');
    assert.equal(tune(db), false, 'a second application makes no schema changes');
    db.exec(`DROP INDEX ${INDEX}; CREATE INDEX ${INDEX} ON messages(kind)`);
    assert.throws(() => tune(db), /unknown index layout/);
    console.log('Tool-digest tuning: byte-identical chronological full/delta results, watermark seek, idempotence and unknown-layout refusal passed.');
  } finally { db.close(); }
}

function main() {
  assert.ok(!process.argv.includes('--apply'), 'Live index changes are forbidden: schedule offline maintenance instead');
  if (process.argv.includes('--self-test')) { selfTest(); return; }
  const db = new Database(path.join(__dirname, '..', 'data', 'orchestrator.sqlite'), { readonly: true });
  db.pragma('busy_timeout = 5000');
  try {
    const task = db.prepare(`SELECT thread_id, COUNT(*) n, MAX(rowid) last FROM messages
      INDEXED BY ${INDEX} WHERE kind = 'tool' GROUP BY thread_id ORDER BY n DESC LIMIT 1`).get();
    if (!task) throw Error('No tool history available to validate');
    const before = [0, task.last - 1000, task.last].map(cursor => measure(db, task.thread_id, cursor));
    const beforeLayout = layout(db);
    const after = [0, task.last - 1000, task.last].map(cursor => measure(db, task.thread_id, cursor));
    before.forEach((row, i) => assert.equal(row.hash, after[i].hash, 'live result/order parity'));
    console.log(JSON.stringify({ checkedAt: new Date().toISOString(), readonly: true,
      beforeLayout, afterLayout: layout(db), toolRows: task.n, before, after, parity: 'passed',
      plan: db.prepare(`EXPLAIN QUERY PLAN ${SQL}`).all(task.thread_id, task.last).map(row => row.detail) }));
  } finally { db.close(); }
}
if (require.main === module) main();
