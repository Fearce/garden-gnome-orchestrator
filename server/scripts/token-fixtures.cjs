// Tells a test fixture shaped like a credential from a real one, for audit-secrets.cjs.
// A real token's tail is random; a fixture spells a word as one of its dash-delimited
// segments (`sk-ant-oat01-test-routine-…`). Gate: test:privacy-guard.

const FIXTURE_WORDS = /^(test|tests|fixture|example|dummy|fake|placeholder|synthetic|sample)$/i;

/** True when a dash-delimited segment of the token is a fixture word. */
function isFixtureToken(token) {
  return token.split("-").some((segment) => FIXTURE_WORDS.test(segment));
}

/** The credential-shaped strings on a diff's added/removed lines that are not fixtures. */
function realTokensInDiff(diff, pattern) {
  const re = new RegExp(pattern, "g");
  const found = [];
  for (const line of diff.split(/\r?\n/)) {
    if (!/^[-+]/.test(line) || /^(\+\+\+|---) /.test(line)) continue;
    for (const match of line.matchAll(re)) if (!isFixtureToken(match[0])) found.push(match[0]);
  }
  return found;
}

module.exports = { isFixtureToken, realTokensInDiff };
