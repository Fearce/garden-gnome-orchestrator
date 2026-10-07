// Rebase + fast-forward are one transaction; another task cannot advance the base
// in between. Verification and authorized pushing happen separately after integration.
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { commonDirectory, withGitTransaction } = require('./git-transaction.cjs');
const exec = promisify(execFile);

async function git(repo, args) {
  const { stdout, stderr } = await exec('git', ['--no-pager', ...args], {
    cwd: repo, windowsHide: true, timeout: 180_000, maxBuffer: 2_000_000,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never', GIT_OPTIONAL_LOCKS: '0', GIT_EDITOR: 'true' },
  });
  if (stderr.trim()) console.error(stderr.trim());
  return stdout.trim();
}

async function integrate(repo, worktree) {
  const common = await commonDirectory(repo);
  if (common !== await commonDirectory(worktree)) throw new Error('The checkouts must belong to the same repository.');
  return withGitTransaction(repo, async () => {
    for (const checkout of [repo, worktree]) {
      if (await git(checkout, ['status', '--porcelain'])) throw new Error(`Review and commit pending changes in ${checkout}, preserving peer work, then retry integration.`);
      const rebase = await git(checkout, ['rev-parse', '--git-path', 'rebase-merge']);
      const apply = await git(checkout, ['rev-parse', '--git-path', 'rebase-apply']);
      const merge = await git(checkout, ['rev-parse', '--git-path', 'MERGE_HEAD']);
      if ([rebase, apply, merge].some(p => require('node:fs').existsSync(path.resolve(checkout, p)))) throw new Error('Finish the existing merge or rebase before integrating.');
    }
    const base = await git(repo, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
    const branch = await git(worktree, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
    if (!base || !branch || base === branch) throw new Error('Integration requires distinct checked-out base and task branches.');
    await git(worktree, ['rebase', base]);
    await git(repo, ['merge', '--ff-only', branch]);
    const commit = await git(repo, ['rev-parse', 'HEAD']);
    if (commit !== await git(worktree, ['rev-parse', 'HEAD'])) throw new Error('Integration receipt mismatch; inspect history without resetting either checkout.');
    return { base, branch, commit };
  });
}

async function main(argv) {
  let repo, worktree;
  for (let i = 0; i < argv.length; i += 2) {
    if (argv[i] === '--repo' && argv[i + 1]) repo = path.resolve(argv[i + 1]);
    else if (argv[i] === '--worktree' && argv[i + 1]) worktree = path.resolve(argv[i + 1]);
    else throw new Error('Usage: node git-integrate.cjs --repo <main checkout> --worktree <task checkout>');
  }
  if (!repo || !worktree) throw new Error('Both --repo and --worktree are required.');
  console.log(JSON.stringify(await integrate(repo, worktree)));
}
module.exports = { integrate };
if (require.main === module) main(process.argv.slice(2)).catch(error => {
  console.error(error.stderr || error.message);
  process.exitCode = error.code === 'GGO_GIT_BUSY' ? 75 : 1;
});
