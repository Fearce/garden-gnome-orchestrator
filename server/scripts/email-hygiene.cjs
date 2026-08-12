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

/** `git@github.com` in a remote URL is an SSH user@host, not a mailbox. */
const withoutSshRemotes = (line) => line.replace(/\b(?:git|hg|svn)@[A-Za-z0-9.-]+/g, "");

/**
 * Rows ("file:line: text") from a broad email grep, minus the ones that matched
 * only a placeholder or an SSH remote URL. The remote is STRIPPED rather than the
 * whole row dropped, so a real address sharing that line is still reported.
 */
function realEmailLines(grepOutput) {
  return String(grepOutput)
    .split(/\r?\n/)
    .filter((l) => l && !PLACEHOLDER.test(l) && EMAIL.test(withoutSshRemotes(l)));
}

module.exports = { EMAIL_PATTERN: EMAIL.source, withoutSshRemotes, realEmailLines };
