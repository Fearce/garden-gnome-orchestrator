// The "real-looking email in a tracked file" predicate behind `audit:secrets`.
//
// It lives here rather than inside audit-secrets.cjs because that script runs
// top-to-bottom and process.exit()s, so it can't be required by a gate — and a
// hand-copied mirror of a classifier drifts (see the cap-classifier lesson in
// .claude/rules/nightly-quality-sweep.md). Both the audit and its gate load THIS.

// Deliberately broad — the filters below decide what actually counts as a leak.
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;

// Doc placeholders, scoped npm package names, and maintainer addresses in lockfiles.
const PLACEHOLDER =
  /example\.com|you@|your-|@types|@anthropic|@fastify|@vitejs|noreply|package-lock\.json|user@|name@/;

/**
 * `git@github.com:owner/repo.git` (and its ssh:// form) is an SSH user@host,
 * not a mailbox. Require the path separator so a real address whose local part
 * happens to be "git" is not silently hidden. The leading character check also
 * prevents matching the tail of a longer email local part.
 */
const withoutSshRemotes = (line) =>
  line.replace(/(^|[^A-Za-z0-9._%+-])(?:git|hg|svn)@[A-Za-z0-9.-]+(?=[:/])/g, "$1");

/**
 * `https://someone@github.com/owner/repo.git` is a URL's userinfo component, not a
 * mailbox — the same distinction as the SSH form above. The local part is arbitrary
 * here (and may carry a `:password`), so what identifies it is the `scheme://` prefix
 * rather than a known user name. Requiring that prefix is what keeps the same address
 * written bare in prose reported: only the userinfo is removed, so the rest of the line
 * stays scannable for a real one. (Which is why this sentence names none — the scan reads
 * its own source, and a predicate that has to be excluded from the check it feeds is one
 * nobody can prove still works.)
 */
const withoutUrlUserinfo = (line) =>
  line.replace(/([A-Za-z][A-Za-z0-9+.-]*:\/\/)[A-Za-z0-9._%+-]+(?::[^@\s/]*)?@(?=[A-Za-z0-9.-]+)/g, "$1");

/**
 * Rows ("file:line: text") from a broad email grep, minus the ones that matched only a
 * placeholder or the user half of a remote URL. The user is STRIPPED rather than the
 * whole row dropped, so a real address sharing that line is still reported.
 */
function realEmailLines(grepOutput) {
  return String(grepOutput)
    .split(/\r?\n/)
    .filter((l) => l && !PLACEHOLDER.test(l) && EMAIL.test(withoutUrlUserinfo(withoutSshRemotes(l))));
}

module.exports = { EMAIL_PATTERN: EMAIL.source, withoutSshRemotes, withoutUrlUserinfo, realEmailLines };
