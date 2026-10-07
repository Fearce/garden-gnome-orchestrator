// One cross-process writer queue per Git object store, including linked worktrees.
// SQLite owns the writer lock. Never delete or override active native Git locks.
const { realpathSync, mkdirSync, existsSync, unlinkSync, statSync } = require('node:fs');
const { randomUUID } = require('node:crypto');
const path = require('node:path');
const { execFile, spawn } = require('node:child_process');
const { promisify } = require('node:util');
const { AsyncLocalStorage } = require('node:async_hooks');
const Database = require('better-sqlite3');
const active = new AsyncLocalStorage();
// A burst of commit hooks across several agents can legitimately take minutes.
// This bounds admission only; it never interrupts a transaction that owns the lock.
const WAIT_MS = 600_000;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const sqliteBusy = error => error.code === 'SQLITE_BUSY' || error.code === 'SQLITE_LOCKED';

function busyError(timeoutMs) {
  const error = new Error(`Git transaction queue timed out after ${timeoutMs} ms before starting the command. Retry after the active transaction finishes; do not delete index.lock or other Git locks.`);
  error.code = 'GGO_GIT_BUSY';
  return error;
}

async function retryBusy(fn, deadline, timeoutMs) {
  for (;;) {
    try { return fn(); }
    catch (error) {
      if (!sqliteBusy(error)) throw error;
      if (Date.now() >= deadline) throw busyError(timeoutMs);
      await sleep(Math.min(100 + Math.floor(Math.random() * 100), Math.max(1, deadline - Date.now())));
    }
  }
}

// Admission has its own short-lived WAL writes. A transaction holds the original
// guard below, so older clients and server processes still exclude new clients.
// Each ticket also holds an exclusive SQLite lease: the OS, rather than a PID or
// elapsed-time guess, proves whether a waiting process is still alive.
async function registerTicket(commonDir, deadline, timeoutMs) {
  const directory = path.join(commonDir, 'ggo-git-queue-leases');
  mkdirSync(directory, { recursive: true });
  const token = randomUUID();
  const leasePath = path.join(directory, `${token}.sqlite`);
  let lease, db, row;
  try {
    lease = new Database(leasePath, { timeout: 0 });
    lease.exec('CREATE TABLE lease_guard (id INTEGER PRIMARY KEY); BEGIN EXCLUSIVE');
    db = await retryBusy(() => new Database(path.join(commonDir, 'ggo-git-admission.sqlite'), { timeout: 0 }), deadline, timeoutMs);
    await retryBusy(() => {
      db.pragma('journal_mode = WAL');
      db.exec('CREATE TABLE IF NOT EXISTS pending (id INTEGER PRIMARY KEY AUTOINCREMENT, token TEXT NOT NULL UNIQUE, requested_at INTEGER NOT NULL, pid INTEGER NOT NULL)');
    }, deadline, timeoutMs);
    row = await retryBusy(() => db.prepare('INSERT INTO pending (token, requested_at, pid) VALUES (?, ?, ?)').run(token, Date.now(), process.pid), deadline, timeoutMs);
    let closed = false;
    return {
      id: Number(row.lastInsertRowid), token, db, directory,
      close() {
        if (closed) return;
        closed = true;
        let removed = false;
        try { db.prepare('DELETE FROM pending WHERE id=? AND token=?').run(Number(row.lastInsertRowid), token); removed = true; }
        catch (error) { if (!sqliteBusy(error)) console.error(`Git admission cleanup: ${error.message}`); }
        finally { try { db.close(); } finally { lease.close(); } }
        // A busy cleanup leaves the row and the now-unlocked lease for the next
        // caller to reap. Never leave a registered row without its lease file.
        if (removed) { try { unlinkSync(leasePath); } catch {} }
      },
    };
  } catch (error) {
    db?.close(); lease?.close();
    try { unlinkSync(leasePath); } catch {}
    throw error;
  }
}

function ticketIsAlive(ticket, candidate) {
  if (!/^[0-9a-f-]{36}$/.test(candidate.token)) throw new Error('Invalid Git admission ticket; inspect queue metadata without touching native Git locks.');
  const leasePath = path.join(ticket.directory, `${candidate.token}.sqlite`);
  if (!existsSync(leasePath)) {
    // A completed owner may have withdrawn since our head snapshot. Otherwise
    // missing evidence is uncertainty, never permission to bypass that ticket.
    if (!ticket.db.prepare('SELECT id FROM pending WHERE id=? AND token=?').get(candidate.id, candidate.token)) return false;
    throw new Error('Git admission ticket has no lease file; inspect queue metadata without touching native Git locks.');
  }
  let probe;
  try {
    probe = new Database(leasePath, { timeout: 0, fileMustExist: true });
    probe.exec('BEGIN EXCLUSIVE; ROLLBACK');
    return false;
  } catch (error) {
    if (sqliteBusy(error)) return true;
    // Completion can race the file open after the existence check.
    if (!ticket.db.prepare('SELECT id FROM pending WHERE id=? AND token=?').get(candidate.id, candidate.token)) return false;
    throw error;
  } finally { probe?.close(); }
}

function firstInLine(ticket) {
  for (;;) {
    const head = ticket.db.prepare('SELECT id, token FROM pending ORDER BY id LIMIT 1').get();
    if (!head) throw new Error('Git admission lost its own ticket; command was not started.');
    if (head.id === ticket.id && head.token === ticket.token) return true;
    if (ticketIsAlive(ticket, head)) return false;
    ticket.db.prepare('DELETE FROM pending WHERE id=? AND token=?').run(head.id, head.token);
    try { unlinkSync(path.join(ticket.directory, `${head.token}.sqlite`)); } catch {}
  }
}

async function commonDirectory(repo) {
  const { stdout } = await promisify(execFile)('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], {
    cwd: repo, windowsHide: true, timeout: 15_000,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' },
  });
  return realpathSync(stdout.trim());
}

async function acquire(commonDir, timeoutMs = WAIT_MS) {
  const deadline = Date.now() + timeoutMs;
  const lockPath = path.join(commonDir, 'ggo-git-transactions.sqlite');
  const ticket = await registerTicket(commonDir, deadline, timeoutMs);
  try { for (;;) {
    let db;
    try {
      if (!firstInLine(ticket)) {
        if (Date.now() >= deadline) throw busyError(timeoutMs);
        await sleep(Math.min(100 + Math.floor(Math.random() * 100), Math.max(1, deadline - Date.now())));
        continue;
      }
      db = new Database(lockPath, { timeout: 0 });
      db.exec('CREATE TABLE IF NOT EXISTS transaction_guard (id INTEGER PRIMARY KEY)');
      db.exec('BEGIN EXCLUSIVE');
      let released = false;
      return () => {
        if (released) return;
        released = true;
        try { db.exec('ROLLBACK'); } finally { try { db.close(); } finally { ticket.close(); } }
      };
    } catch (error) {
      db?.close();
      if (!sqliteBusy(error)) throw error;
      if (Date.now() >= deadline) throw busyError(timeoutMs);
      await sleep(Math.min(100 + Math.floor(Math.random() * 100), Math.max(1, deadline - Date.now())));
    }
  } } catch (error) { ticket.close(); throw error; }
}

async function withCommonDirectory(commonDir, fn, timeoutMs = WAIT_MS) {
  const key = realpathSync(commonDir);
  const current = active.getStore();
  if (current?.has(key)) return fn();
  const release = await acquire(key, timeoutMs);
  try { return await active.run(new Set([...(current ?? []), key]), fn); }
  finally { release(); }
}

async function withGitTransaction(repo, fn, timeoutMs = WAIT_MS) {
  return withCommonDirectory(await commonDirectory(repo), fn, timeoutMs);
}

async function waitForIndex(repo, commonDir, deadline) {
  const { stdout } = await promisify(execFile)('git', ['rev-parse', '--path-format=absolute', '--git-path', 'index'], {
    cwd: repo, windowsHide: true, timeout: 15_000,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' },
  });
  const lock = stdout.trim() + '.lock';
  let announced = false, nextAudit = 0;
  while (existsSync(lock)) {
    if (!announced) {
      console.error('Git transaction is waiting for a native index lock; the command has not started. Active or uncertain owners remain untouched.');
      announced = true;
    }
    if (Date.now() >= deadline) {
      const error = new Error('Git transaction timed out waiting for a native index lock before starting the command. Inspect its owner; do not delete the lock or reset the index.');
      error.code = 'GGO_GIT_BUSY';
      throw error;
    }
    let age;
    try { age = Date.now() - statSync(lock).mtimeMs; }
    catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    if (process.platform === 'win32' && age >= 120_000 && Date.now() >= nextAudit) {
      nextAudit = Date.now() + 10_000;
      try {
        const result = await promisify(execFile)('powershell.exe', ['-NoProfile', '-NonInteractive', '-File', path.join(__dirname, 'git-recover-index.ps1'), '-CommonDirectory', commonDir, '-LockPath', lock], { windowsHide: true, timeout: Math.max(1, Math.min(30_000, deadline - Date.now())) });
        if (result.stdout.trim()) console.error(`Git transaction preserved an abandoned native index lock; audit receipt: ${JSON.parse(result.stdout.trim())}`);
      } catch (error) {
        // Exit 75 means pre-move uncertainty. A failed post-move verification or
        // an interrupted audit stops our command instead of hiding that failure.
        if (error.code !== 75) throw error;
      }
    }
    await sleep(Math.min(200, Math.max(1, deadline - Date.now())));
  }
}

// Conservative classification: reads do not queue, unknown commands do. Configuration
// flags precede the verb at several call sites; never confuse a flag value with a verb.
function gitVerbIndex(args) {
  let i = 0;
  while (i < args.length && args[i].startsWith('-')) {
    const arg = args[i++];
    if (['-c', '-C', '--git-dir', '--work-tree', '--namespace'].includes(arg)) i++;
  }
  return i;
}

function isGitWrite(args) {
  const i = gitVerbIndex(args);
  const verb = args[i];
  if (verb === 'worktree') return !['list'].includes(args[i + 1]);
  if (verb === 'remote') return !['-v', '--verbose', 'get-url', 'show'].includes(args[i + 1]);
  if (verb === 'branch') return args.slice(i + 1).some(a => ['-d', '-D', '-m', '-M', '-c', '-C', '--delete', '--move', '--copy', '--set-upstream-to', '--unset-upstream'].includes(a)) || args.slice(i + 1).some(a => !a.startsWith('-'));
  if (verb === 'config') return !args.slice(i + 1).some(a => ['--get', '--get-all', '--get-regexp', '--list', '-l'].includes(a));
  return !['rev-parse', 'status', 'diff', 'show', 'log', 'for-each-ref', 'ls-files', 'ls-tree', 'merge-base', 'rev-list', 'check-ignore', 'check-ref-format', 'cat-file', 'describe'].includes(verb);
}

async function main(argv) {
  const separator = argv.indexOf('--');
  const options = separator < 0 ? [] : argv.slice(0, separator);
  const command = separator < 0 ? [] : argv.slice(separator + 1);
  let repo = process.cwd(), timeoutMs = WAIT_MS;
  for (let i = 0; i < options.length; i += 2) {
    if (options[i] === '--repo' && options[i + 1]) repo = path.resolve(options[i + 1]);
    else if (options[i] === '--timeout-ms' && /^\d+$/.test(options[i + 1] ?? '')) timeoutMs = Number(options[i + 1]);
    else throw new Error('Usage: node git-transaction.cjs [--repo <checkout>] [--timeout-ms <milliseconds>] -- <program> <arguments...>');
  }
  if (!command.length || !Number.isSafeInteger(timeoutMs) || timeoutMs > 600_000) throw new Error('Provide a command and a wait between 0 and 600000 ms.');
  const deadline = Date.now() + timeoutMs;
  const commonDir = await commonDirectory(repo);
  const code = await withCommonDirectory(commonDir, async () => {
    // Push/fetch do not use the index. Unknown helpers may stage/commit, so wait
    // before starting them rather than partially executing and blindly retrying.
    const directGit = /^git(?:\.exe)?$/i.test(path.basename(command[0]));
    const gitArgs = command.slice(1);
    const refOnly = directGit && ['push', 'fetch'].includes(gitArgs[gitVerbIndex(gitArgs)]);
    if (!refOnly) await waitForIndex(repo, commonDir, deadline);
    return new Promise((resolve, reject) => {
    // The lock covers the whole command (including a multi-step commit helper or integration script).
    // Keep it until the child closes, including when a signal asks the wrapper to exit.
    const child = spawn(command[0], command.slice(1), {
      cwd: repo, stdio: 'inherit', shell: false, windowsHide: true,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never', GIT_OPTIONAL_LOCKS: '0' },
    });
    const stop = signal => child.kill(signal);
    const onInt = () => stop('SIGINT'), onTerm = () => stop('SIGTERM');
    process.on('SIGINT', onInt); process.on('SIGTERM', onTerm);
    const cleanup = () => { process.off('SIGINT', onInt); process.off('SIGTERM', onTerm); };
    child.once('error', error => { cleanup(); reject(error); });
    child.once('close', code => { cleanup(); resolve(code ?? 1); });
    });
  }, Math.max(0, deadline - Date.now()));
  process.exitCode = code;
}

module.exports = { acquire, commonDirectory, withCommonDirectory, withGitTransaction, isGitWrite, main };
if (require.main === module) main(process.argv.slice(2)).catch(error => {
  console.error(error.message);
  process.exitCode = error.code === 'GGO_GIT_BUSY' ? 75 : 1;
});
