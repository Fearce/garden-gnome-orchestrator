// Pre-publish secret/hygiene audit for garden-gnome orchestrator.
// Read-only. Answers "is this repo safe to make public?" in one command.
//
//   npm run audit:secrets --prefix server
//   node scripts/audit-secrets.cjs
//   node scripts/audit-secrets.cjs --no-history   (skip the full-history scan; faster)
//
// Why this exists: the live AUTH_PASSWORD once got hardcoded into CLAUDE.md and
// leaked through git HISTORY (an agent pasted it in "for convenience"). A generic
// pattern can't catch an arbitrary password literal — so this tool reads the REAL
// secret values out of the gitignored server/.env and asserts none of them appear
// in tracked files OR any commit's history. That makes the un-patternable secret
// detectable. It ALSO scans for known token shapes (sk-ant, GOCSPX, AWS/GitHub/
// Slack/Google keys, private-key blocks), refuses tracked secret-type files, and
// flags machine-specific paths / real emails.
//
// Exit: 0 = clean (safe to publish).
//       1 = a secret value or token shape is present in the tree or history, or a
//           secret-type file is tracked. (Personal paths / emails / missing
//           LICENSE/README are WARN only — reported but do not fail the exit code.)

const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const args = process.argv.slice(2);
const SCAN_HISTORY = !args.includes("--no-history");

const SERVER = path.resolve(__dirname, "..");
const ROOT = path.resolve(SERVER, "..");
const ENV_PATH = path.join(SERVER, ".env");
const SELF_REL = "server/scripts/audit-secrets.cjs";

// Pathspecs excluded from every scan: built output, deps, and THIS file (it
// contains the token patterns + key names as literals, which would self-match).
const EXCLUDES = [":!*/dist/*", ":!*/node_modules/*", `:!${SELF_REL}`];

let hardFail = false;
const notes = [];
const section = (t) => console.log(`\n=== ${t} ===`);
const ok = (m) => console.log(`  ✓ ${m}`);
const warn = (m) => {
  console.log(`  ⚠ ${m}`);
  notes.push(m);
};
const fail = (m) => {
  console.log(`  ✗ ${m}`);
  hardFail = true;
};

function git(argv) {
  try {
    return execFileSync("git", argv, { cwd: ROOT, encoding: "utf8", maxBuffer: 1 << 28 });
  } catch (e) {
    // git grep / git log exit 1 when there are simply no matches — that's not an
    // error for us; return whatever it printed to stdout.
    return e.stdout ? String(e.stdout) : "";
  }
}

/** Tracked files containing a FIXED string, as "file:line: text" rows. */
function grepLiteral(value) {
  return git(["grep", "-n", "-F", "-e", value, "--", ".", ...EXCLUDES]).trim();
}

/** Tracked files matching an extended-regex, as "file:line: text" rows. */
function grepRegex(re) {
  return git(["grep", "-nI", "-E", "-e", re, "--", ".", ...EXCLUDES]).trim();
}

/** Commits whose diff ever added/removed a FIXED string (pickaxe). */
function historyLiteral(value) {
  return git(["log", "--all", "--oneline", "-S", value, "--", ".", ...EXCLUDES]).trim();
}

/** Commits whose diff ever added/removed a regex match. */
function historyRegex(re) {
  return git(["log", "--all", "--oneline", "-G", re, "--", ".", ...EXCLUDES]).trim();
}

// ---- 1. Real secret values from server/.env must not appear anywhere ---------

// KEY name → severity. FAIL = catastrophic if leaked; WARN = identity/path, not a
// credential but shouldn't ship in a public repo. Matched case-insensitively and
// with a trailing digit-suffix allowance (ACCOUNT_1_TOKEN, ACCOUNT_2_TOKEN, ...).
const SECRET_KEYS = [
  /^AUTH_PASSWORD$/i,
  /^SESSION_SECRET$/i,
  /^GOOGLE_CLIENT_SECRET$/i,
  /^GOOGLE_CLIENT_ID$/i,
  /^ACCOUNT_\d+_TOKEN$/i,
  /^CLAUDE_CODE_OAUTH_TOKEN$/i,
  /^HTTPS_PFX_PASSPHRASE$/i,
  /^NOTIFY_WEBHOOK_URL$/i,
];
const IDENTITY_KEYS = [
  /^OWNER_NAME$/i,
  /^ALLOWED_EMAIL$/i,
  /^DEFAULT_WORKSPACE$/i,
  /^MEMORY_DIR$/i,
  /^HTTPS_PFX_PATH$/i,
  /^PLAYWRIGHT_RUNTIME_DEPS_DIR$/i,
];

function parseEnv(text) {
  const out = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const m = line.match(/^([A-Z0-9_]+)\s*=\s*(.*)$/i);
    if (!m) continue;
    let value = m[2].trim().replace(/^['"]|['"]$/g, "");
    if (value) out.push({ key: m[1], value });
  }
  return out;
}

function classify(key) {
  if (SECRET_KEYS.some((re) => re.test(key))) return "secret";
  if (IDENTITY_KEYS.some((re) => re.test(key))) return "identity";
  return null;
}

section("live secret values (from server/.env) must not appear in tree or history");
if (!fs.existsSync(ENV_PATH)) {
  warn("no server/.env present — skipping value-based scan (pattern checks below still run)");
} else {
  const entries = parseEnv(fs.readFileSync(ENV_PATH, "utf8"));
  let checked = 0;
  for (const { key, value } of entries) {
    const kind = classify(key);
    // Skip too-short / obviously-placeholder values that would false-positive
    // (e.g. HOST=0.0.0.0, PORT=4317 aren't in the key lists anyway, but guard).
    if (!kind || value.length < 6) continue;
    if (/^(changeit|changeme|your|you@|example|placeholder)/i.test(value)) continue;
    checked++;
    const inTree = grepLiteral(value);
    const inHist = SCAN_HISTORY ? historyLiteral(value) : "";
    const report = kind === "secret" ? fail : warn;
    if (inTree) report(`${key} value leaks into TRACKED files:\n${indent(inTree)}`);
    if (inHist) report(`${key} value leaks into git HISTORY:\n${indent(inHist)}`);
    if (!inTree && !inHist) ok(`${key} value not found in tree${SCAN_HISTORY ? " or history" : ""}`);
  }
  if (!checked) warn("server/.env had no scannable secret/identity values");
}

// ---- 2. Known credential token shapes ---------------------------------------

const TOKEN_PATTERNS = [
  ["Anthropic API key", "sk-ant-[A-Za-z0-9_-]{20,}"],
  ["Generic OpenAI-style key", "sk-[A-Za-z0-9]{32,}"],
  ["Google OAuth client secret", "GOCSPX-[A-Za-z0-9_-]{20,}"],
  ["Google API key", "AIza[0-9A-Za-z_-]{35}"],
  ["AWS access key id", "AKIA[0-9A-Z]{16}"],
  ["GitHub token", "gh[posru]_[A-Za-z0-9]{30,}"],
  ["Slack token", "xox[baprs]-[A-Za-z0-9-]{10,}"],
  ["Private key block", "-----BEGIN [A-Z ]*PRIVATE KEY-----"],
];

section("known credential token shapes");
{
  let clean = true;
  for (const [label, re] of TOKEN_PATTERNS) {
    const inTree = grepRegex(re);
    const inHist = SCAN_HISTORY ? historyRegex(re) : "";
    if (inTree) {
      fail(`${label} in TRACKED files:\n${indent(inTree)}`);
      clean = false;
    }
    if (inHist) {
      fail(`${label} in git HISTORY:\n${indent(inHist)}`);
      clean = false;
    }
  }
  if (clean) ok(`none of ${TOKEN_PATTERNS.length} token shapes found in tree${SCAN_HISTORY ? " or history" : ""}`);
}

// ---- 3. No secret-type files tracked ----------------------------------------

section("secret-type files must not be tracked");
{
  const tracked = git(["ls-files"]).split(/\r?\n/).filter(Boolean);
  const bad = tracked.filter((f) =>
    /(^|\/)\.env(\.local)?$/.test(f) || /\.(sqlite|pfx|pem|p12|key|crt|keystore)$/i.test(f),
  );
  if (bad.length) bad.forEach((f) => fail(`tracked secret-type file: ${f}`));
  else ok("no .env / .sqlite / cert / key files tracked");
}

// ---- 4. Machine-specific paths & real emails (informational) ----------------

section("machine-specific paths & real emails (WARN only)");
{
  // Real home-dir paths only — drop the doc placeholders (/Users/you, C:\Users\name, ~).
  const paths = grepRegex("Users[\\\\/][A-Za-z0-9._-]+[\\\\/]|/home/[A-Za-z0-9._-]+/")
    .split(/\r?\n/)
    .filter((l) => l && !/Users[\\/](you|your|name|username|me|dev|user)\b|\/home\/(you|user|username)\//i.test(l));
  if (paths.length) warn(`personal absolute path(s) in tracked files:\n${indent(paths.join("\n"))}`);
  else ok("no personal home-dir paths in tracked files (placeholders excluded)");

  // Emails, minus the obvious placeholders and dependency-maintainer addresses in lockfiles.
  const emails = grepRegex("[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\\.[A-Za-z]{2,}")
    .split(/\r?\n/)
    .filter((l) => l && !/example\.com|you@|your-|@types|@anthropic|@fastify|@vitejs|noreply|package-lock\.json|user@|name@/.test(l));
  if (emails.length) warn(`real-looking email(s) in tracked files:\n${indent(emails.join("\n"))}`);
  else ok("no real-looking emails in tracked files (placeholders/lockfile excluded)");
}

// ---- 5. Repo essentials ------------------------------------------------------

section("open-source essentials");
for (const f of ["LICENSE", "README.md"]) {
  if (fs.existsSync(path.join(ROOT, f))) ok(`${f} present`);
  else warn(`${f} missing`);
}

function indent(block) {
  return block
    .split(/\r?\n/)
    .slice(0, 20)
    .map((l) => `      ${l}`)
    .join("\n");
}

// ---- summary -----------------------------------------------------------------

section("summary");
if (hardFail) {
  console.log("  ✗ NOT publish-safe — a secret value / token / secret-file was found above. Fix before going public.");
} else if (notes.length) {
  console.log("  ✓ No secrets found. Publish-safe, with informational notes:");
  notes.forEach((n) => console.log(`     - ${n.split("\n")[0]}`));
} else {
  console.log("  ✓ Clean — safe to make public.");
}
process.exit(hardFail ? 1 : 0);
