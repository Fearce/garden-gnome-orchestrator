// Tells a test fixture shaped like a credential from a real one, for audit-secrets.cjs.
// Exempt only the exact historical fixture at its audited test path. Valid credentials
// may themselves contain words such as `test`. Gate: test:token-fixtures.

const FIXTURE_PATH = "server/src/tests/cloudSessions.test.ts";
const FIXTURE_TOKEN = ["sk", "ant", "oat01", "test", "routine", "token"].join("-");

function isFixtureToken(token, file) {
  return file === FIXTURE_PATH && token === FIXTURE_TOKEN;
}

function tokensInDiff(diff, pattern) {
  const re = new RegExp(pattern, "g");
  const real = [];
  let fixtures = 0;
  let oldFile = "", newFile = "";
  for (const line of diff.split(/\r?\n/)) {
    if (line.startsWith("diff --git ")) { oldFile = ""; newFile = ""; continue; }
    if (line.startsWith("--- ")) { oldFile = line.slice(4).replace(/^a\//, ""); continue; }
    if (line.startsWith("+++ ")) { newFile = line.slice(4).replace(/^b\//, ""); continue; }
    if (!/^[-+]/.test(line)) continue;
    const file = line[0] === "+" ? newFile : oldFile;
    for (const match of line.matchAll(re)) {
      if (isFixtureToken(match[0], file)) fixtures++;
      else real.push(match[0]);
    }
  }
  return { real, fixtures };
}

function realTokensInDiff(diff, pattern) {
  return tokensInDiff(diff, pattern).real;
}

/** An empty/unreadable diff cannot prove that a history match is a fixture. */
function isFixtureOnlyDiff(diff, pattern) {
  const { real, fixtures } = tokensInDiff(diff, pattern);
  return fixtures > 0 && real.length === 0;
}

module.exports = { isFixtureToken, realTokensInDiff, isFixtureOnlyDiff };
