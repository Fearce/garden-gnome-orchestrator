// One cross-process writer queue per Git object store, including linked worktrees.
// SQLite owns the lock. Never remove Git lock files.
const { realpathSync } = require('node:fs');
const path = require('node:path');
const { execFile, spawn } = require('node:child_process');
const { promisify } = require('node:util');
const { AsyncLocalStorage } = require('node:async_hooks');
const Database = require('better-sqlite3');
const active = new AsyncLocalStorage();
const WAIT_MS = 120_000;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

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
  for (;;) {
    let db;
    try {
      db = new Database(lockPath, { timeout: 0 });
      db.exec('CREATE TABLE IF NOT EXISTS transaction_guard (id INTEGER PRIMARY KEY)');
      db.exec('BEGIN EXCLUSIVE');
      let released = false;
      return () => {
        if (released) return;
        released = true;
        try { db.exec('ROLLBACK'); } finally { db.close(); }
      };
    } catch (error) {
      db?.close();
      if (error.code !== 'SQLITE_BUSY' && error.code !== 'SQLITE_LOCKED') throw error;
      if (Date.now() >= deadline) {
        const busy = new Error(`Git transaction queue timed out after ${timeoutMs} ms. Retry after the active transaction finishes; do not delete index.lock or other Git locks.`);
        busy.code = 'GGO_GIT_BUSY';
        throw busy;
      }
      await sleep(Math.min(100 + Math.floor(Math.random() * 100), Math.max(1, deadline - Date.now())));
    }
  }
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

// Conservative classification: reads do not queue, unknown commands do. Configuration
// flags precede the verb at several call sites; never confuse a flag value with a verb.
function isGitWrite(args) {
  let i = 0;
  while (i < args.length && args[i].startsWith('-')) {
    const arg = args[i++];
    if (['-c', '-C', '--git-dir', '--work-tree', '--namespace'].includes(arg)) i++;
  }
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
  const code = await withGitTransaction(repo, () => new Promise((resolve, reject) => {
    // The lock covers the whole command (including a multi-step commit helper or integration script).
    // Keep it until the child closes, including when a signal asks the wrapper to exit.
    const child = spawn(command[0], command.slice(1), {
      cwd: repo, stdio: 'inherit', shell: false, windowsHide: true,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' },
    });
    const stop = signal => child.kill(signal);
    const onInt = () => stop('SIGINT'), onTerm = () => stop('SIGTERM');
    process.on('SIGINT', onInt); process.on('SIGTERM', onTerm);
    const cleanup = () => { process.off('SIGINT', onInt); process.off('SIGTERM', onTerm); };
    child.once('error', error => { cleanup(); reject(error); });
    child.once('close', code => { cleanup(); resolve(code ?? 1); });
  }), timeoutMs);
  process.exitCode = code;
}

module.exports = { acquire, commonDirectory, withCommonDirectory, withGitTransaction, isGitWrite, main };
if (require.main === module) main(process.argv.slice(2)).catch(error => {
  console.error(error.message);
  process.exitCode = error.code === 'GGO_GIT_BUSY' ? 75 : 1;
});
