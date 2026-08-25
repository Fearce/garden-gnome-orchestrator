#!/usr/bin/env node

const assert = require("node:assert/strict");
const { EMAIL_PATTERN, withoutSshRemotes, withoutUrlUserinfo, realEmailLines } = require("./email-hygiene.cjs");

const rows = (...lines) => lines.join("\n");

// --- the grep pattern the audit feeds git ------------------------------------
// It must stay broad: everything narrowing happens in realEmailLines, so a pattern
// that misses a shape here makes the whole check silently blind.
const broad = new RegExp(EMAIL_PATTERN);
assert.equal(broad.test("owner@acme.test"), true);
assert.equal(broad.test("first.last+tag@sub.example.co.uk"), true);
assert.equal(broad.test("no-at-sign.org"), false);
assert.equal(broad.test("missing@tld"), false, "a bare host is not an address");

// --- SSH remote users are not mailboxes --------------------------------------
assert.equal(withoutSshRemotes("git@github.com:Fearce/sample.git"), ":Fearce/sample.git");
assert.equal(withoutSshRemotes("ssh://git@github.com:22/o/r.git"), "ssh://:22/o/r.git");
assert.equal(withoutSshRemotes("owner@acme.test"), "owner@acme.test", "a real address is untouched");
assert.equal(
  withoutSshRemotes("git@company.test"),
  "git@company.test",
  "a bare git@ mailbox is not an SSH remote URL",
);
assert.equal(
  withoutSshRemotes("build-git@company.test"),
  "build-git@company.test",
  "do not strip the tail of a longer email local part",
);

// --- an http(s) remote's userinfo is not a mailbox either ---------------------
assert.equal(
  withoutUrlUserinfo("https://someone@github.com/fearce/card-marker.git"),
  "https://github.com/fearce/card-marker.git",
);
assert.equal(
  withoutUrlUserinfo("https://user:ghp_token@github.com/o/r.git"),
  "https://github.com/o/r.git",
  "a userinfo carrying a password is still userinfo",
);
assert.equal(
  withoutUrlUserinfo("someone@github.com"),
  "someone@github.com",
  "without the scheme:// prefix it is prose, and prose is where a real leak hides",
);
assert.equal(
  withoutUrlUserinfo("see https://acme.test and mail owner@acme.test"),
  "see https://acme.test and mail owner@acme.test",
  "a URL and a mailbox on one line: only a userinfo is removed",
);

// --- what the audit actually reports -----------------------------------------
assert.deepEqual(realEmailLines(""), [], "no grep hits is not a finding");

// THE 2026-08-12 REGRESSION: the Git console (163689c) put SSH remote URLs in tracked
// files, and every one of them was reported as a "real-looking email" — nine warnings a
// night on a WARN-only check, which is how a check stops being read.
assert.deepEqual(
  realEmailLines(
    rows(
      'server/src/git/repoOps.ts:144:  const scp = ... // git@github.com:owner/repo.git',
      'server/src/tests/repoOps.itest.ts:473:    check("GitLab", remoteWebUrl("git@gitlab.com:o/r.git", "main"))',
      'server/scripts/git-console-lab.cjs:238:  execFileSync("git", ["remote", "set-url", "origin", "git@bitbucket.org:o/r.git"])',
      'server/src/tests/repoOps.itest.ts:467:    check("a port", remoteWebUrl("ssh://git@github.com:22/Fearce/repo.git", "dev"))',
    ),
  ),
  [],
);

// THE 2026-08-25 RECURRENCE, one URL form down: the Online Office (ccd8ff3) put http(s)
// remotes with a userinfo component into a tracked fixture, and the 08-12 strip only knew
// the scp-style `git@host:` shape. Same WARN-only cry-wolf failure, so the same rule applies.
assert.deepEqual(
  realEmailLines(
    rows(
      'server/src/tests/onlineOffice.itest.ts:263:      "https://someone@github.com/fearce/card-marker.git",',
      'server/src/office/repoIdentity.ts:40:  // https://user:token@gitlab.com/o/r.git normalizes the same way',
    ),
  ),
  [],
);

// ...but the check still has to DO its job — this is the leak it exists to catch.
assert.deepEqual(realEmailLines("docs/notes.md:3: ping owner@acme.test about it"), [
  "docs/notes.md:3: ping owner@acme.test about it",
]);
assert.deepEqual(realEmailLines("docs/notes.md:4: ping git@company.test about it"), [
  "docs/notes.md:4: ping git@company.test about it",
]);

// The reason the SSH remote is stripped rather than the whole ROW dropped: a real
// address sharing a line with a remote URL would otherwise be filtered out with it.
const mixed = 'src/x.ts:9: remote("git@github.com:o/r.git") // owner: owner@acme.test';
assert.deepEqual(realEmailLines(mixed), [mixed], "a real address beside an SSH remote still reports");

const mixedUrl = 'src/x.ts:9: clone("https://someone@github.com/o/r.git") // owner: owner@acme.test';
assert.deepEqual(realEmailLines(mixedUrl), [mixedUrl], "a real address beside an http remote still reports");

// --- placeholders stay quiet --------------------------------------------------
for (const placeholder of [
  "README.md:1: contact you@example.com",
  "docs/setup.md:4: ALLOWED_EMAIL=user@example.com",
  "web/package.json:9:    \"@types/react\": \"^19.0.0\",",
  "server/package.json:12:    \"@anthropic-ai/claude-agent-sdk\": \"^0.1.0\",",
  "package-lock.json:88:      \"maintainer\": \"maintainer@acme.test\"",
  "CONTRIBUTING.md:2: use noreply@github.com",
]) {
  assert.deepEqual(realEmailLines(placeholder), [], `placeholder should stay quiet: ${placeholder}`);
}

// CRLF from git on Windows: the split eats the \r, and the trailing newline must not
// smuggle a blank row into the findings.
assert.deepEqual(realEmailLines("a.md:1: owner@acme.test\r\n"), ["a.md:1: owner@acme.test"]);

console.log("Email hygiene predicate tests passed.");
