#!/usr/bin/env node
// Gate: the privacy guard catches each class of personal detail that has leaked into this public repo,
// stays quiet on the neutral examples the repo uses instead, and the tracked tree is clean right now.
//
// Every planted sample is assembled at runtime from fragments, so this file never contains the shape it
// asserts on and can stay inside the scan it proves.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const { lineFindings, scanTree, loadPrivateTerms, localIdentity, fakeSnowflake, harmlessIp, protectedFile } = require("./privacy-guard.cjs");

const rules = (line, opts) => lineFindings(line, opts).map((f) => f.rule);
const join = (...parts) => parts.join("");

// --- home-directory paths ---------------------------------------------------------------------------
assert.deepEqual(rules(join("python C:", "/Users/", "jdoe", "/.claude/x.py")), ["home-directory path"]);
assert.deepEqual(rules(join("C:", "\\\\Users\\\\", "jdoe", "\\\\AppData")), ["home-directory path"], "escaped backslashes too");
assert.deepEqual(rules(join("cd ", "/home/", "jdoe", "/src")), ["home-directory path"]);
assert.deepEqual(rules(join("open ", "/Users/", "jdoe", "/Library")), ["home-directory path"]);
assert.deepEqual(rules("C:/Users/alex/AppData/Local/Temp/probe"), [], "the fixtures' neutral user");
assert.deepEqual(rules("C:\\Users\\<operator>\\projects"), [], "a placeholder is the cure, not the leak");
assert.deepEqual(rules("C:/Users/Public/Documents"), []);

// --- addresses --------------------------------------------------------------------------------------
assert.deepEqual(rules(join("ssh deploy@", "88.", "41.", "39.", "175")), ["public IPv4 address"]);
assert.deepEqual(rules(join("http://", "88.", "41.", "39.", "175", ":8787/")), ["public IPv4 address"], "inside a URL");
for (const ok of ["192.168.1.50", "10.0.0.1", "172.18.0.4", "127.0.0.1", "203.0.113.9", "198.51.100.4", "192.0.2.10", "9.9.9.9", "1.2.3.4"]) {
  assert.deepEqual(rules(`host ${ok}`), [], `${ok} identifies no real host`);
}
assert.deepEqual(rules("Mozilla/5.0 Chrome/141.0.0.0 Mobile"), [], "a browser version string");
assert.deepEqual(rules('<path d="M8 0C3.58 0 0 3.58 0 8c.72 1.21 1.87.87 2.33.66"/>'), [], "SVG path data");
assert.equal(harmlessIp([256, 1, 1, 1]), true, "not an address at all");

// --- account ids ------------------------------------------------------------------------------------
assert.deepEqual(rules(join("userId: ", "1119", "0968658", "3828480")), ["real-looking account id (17-19 digits)"]);
assert.equal(fakeSnowflake("100000000000000001"), true);
assert.equal(fakeSnowflake("123456789012345678"), true);
assert.equal(fakeSnowflake("234567890123456789"), true);
assert.equal(fakeSnowflake(join("1542", "1040621", "56079144")), false);
assert.deepEqual(rules("const at = 1730000000000;"), [], "a millisecond timestamp is 13 digits");

// --- tailnets and mail ------------------------------------------------------------------------------
assert.deepEqual(rules(join("https://desk.", "tail9f3", "c2.ts.net")), ["tailnet hostname"]);
assert.deepEqual(rules("https://ggo.tail1234.ts.net and https://your-host.tailnet.ts.net"), []);
assert.deepEqual(rules(join("mail ", "jane.doe", "@", "gmail", ".com")), ["e-mail address"]);
for (const ok of ["owner@example.com", "lab@example.test", "gate@example.invalid", "x@sub.example.co.uk", "git@github.com:o/r.git", "https://token@github.com/o/r.git", "31897010+acme@users.noreply.github.com", "someone@github.com"]) {
  assert.deepEqual(rules(ok), [], `${ok} names no one`);
}

// --- private terms, allowlist and the skip marker ---------------------------------------------------
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "privacy-guard-"));
try {
  const termsFile = path.join(tmp, ".privacy-terms");
  fs.writeFileSync(termsFile, "# comment\n\\bfrobcorp\\b\n\n");
  const privateTerms = loadPrivateTerms({ termsFile, identity: ["jdoe42"] });
  assert.equal(privateTerms.length, 2, "comments and blank lines are not terms");
  assert.deepEqual(rules("ship the FrobCorp client build", { privateTerms }), ["private term (server/.privacy-terms or local identity)"]);
  assert.deepEqual(rules("committed as jdoe42 from home", { privateTerms }), ["private term (server/.privacy-terms or local identity)"], "the local identity");
  assert.deepEqual(rules("frobcorpus is a different word", { privateTerms }), []);
  assert.deepEqual(rules("ship the frobcorp build // personalization-ok", { privateTerms }), [], "an explicit line marker");
  assert.deepEqual(loadPrivateTerms({ termsFile: path.join(tmp, "missing"), identity: [] }), [], "no file, no identity: nothing");
  // A real address is private in full and by its local part; a placeholder identity (the gate runner's
  // own gates.gitconfig) names no one and must not turn an ordinary word private.
  assert.deepEqual(localIdentity({ username: "", email: join("jdoe42", "@", "mail.", "co") }), [join("jdoe42", "@", "mail.", "co"), "jdoe42"]);
  for (const placeholder of ["gates@localhost", "gates@example.invalid", "lab@example.com", "bot@users.noreply.github.com"]) {
    assert.deepEqual(localIdentity({ username: "", email: placeholder }), [], `${placeholder} is not a private identity`);
  }
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
const allowlist = [new RegExp("alibabagroup\\.com/en-US/document-\\d+", "gi")];
assert.deepEqual(rules(join("https://www.alibabagroup.com/en-US/document-", "2021044", "032125272064"), { allowlist }), [], "an allowlisted public URL");

// --- the real tracked tree --------------------------------------------------------------------------
// Ignoring a file is insufficient if it is already tracked (or force-added). Refuse runtime paths
// before reading their contents, including binary keys and neutral-looking state.
for (const file of ["server/.env", "server/.env.production", "relay/.env.backup", "server/data/state.json", "relay/data/members.json", "data/history.json", "server/.privacy-terms", "relay/deploy.env", ".claude/settings.local.json", "server/certs/cert.pfx", "state.sqlite-wal", "state.sqlite-journal"]) {
  assert.equal(protectedFile(file), true, `${file} must stay untracked`);
}
for (const file of ["server/.env.example", "relay/deploy.env.example", "README.md", "server/src/config.ts"]) {
  assert.equal(protectedFile(file), false, `${file} is publishable`);
}
const neutralState = "server/data/qa-privacy-neutral-state.png";
const root = path.resolve(__dirname, "../..");
fs.mkdirSync(path.join(root, "server/data"), { recursive: true });
try {
  fs.writeFileSync(path.join(root, neutralState), Buffer.from([0, 1, 2]));
  assert.deepEqual(scanTree({ files: [neutralState], privateTerms: [], allowlist: [] }).map((f) => f.rule), ["runtime data or credential file must not be tracked"]);
} finally {
  fs.unlinkSync(path.join(root, neutralState));
}

// Exercise the secret audit's real reporting path with a planted secret and a personal commit subject.
// Git output stays inside this sandbox; assertions prove neither value is copied to the log.
const secret = join("synthetic-", "credential-value");
const subject = join("synthetic-", "private-subject");
const sha = "a".repeat(40);
const auditOutput = [];
let auditExit;
vm.runInNewContext(fs.readFileSync(path.join(__dirname, "audit-secrets.cjs"), "utf8"), {
  __dirname,
  console: { log: (value) => auditOutput.push(value) },
  process: { argv: ["node", "audit-secrets.cjs"], exit: (code) => { auditExit = code; } },
  require: (name) => {
    if (name === "node:fs") return { existsSync: () => true, readFileSync: () => `AUTH_PASSWORD=${secret}` };
    if (name === "node:child_process") return { execFileSync: (_bin, args) => {
      if (args[0] === "ls-files") return "README.md\n";
      if (args[0] === "grep" && args.includes("-F")) return `README.md:7:${secret}\n`;
      if (args[0] === "log" && args.includes("-S")) {
        return args.includes("--format=%H") ? sha : `${sha} ${subject}`;
      }
      return "";
    } };
    return require(name);
  },
});
const reported = auditOutput.join("\n");
assert.equal(auditExit, 1, "the planted secret still fails the audit");
assert.ok(reported.includes("README.md:7") && reported.includes(sha), "locations remain actionable");
assert.ok(!reported.includes(secret) && !reported.includes(subject), "audit evidence must not repeat private values");
const findings = scanTree();
assert.deepEqual(
  findings.map((f) => `${f.file}:${f.line}:${f.column} ${f.rule}`),
  [],
  "the tracked tree carries a personal detail. Run `npm run privacy:check --prefix server` for the list, replace each with a neutral example, or allowlist a legitimate public value in .claude/personalization-allowlist.txt.",
);

console.log("privacy guard gate: all checks passed");
