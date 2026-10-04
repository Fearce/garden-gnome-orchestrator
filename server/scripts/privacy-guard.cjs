#!/usr/bin/env node
// Personal-data guard for the tracked tree of this PUBLIC repository.
//
//   npm run privacy:check --prefix server      # scan every tracked file, exit 1 on a finding
//
// The repo is published, and nearly every leak it ever had arrived the same way: an agent pasted a real
// detail from the machine it ran on into a doc, a comment or a test fixture — a home-directory path, a
// LAN or server address, a Discord id, a private project or person's name. Generic shapes are checked
// here; the operator's own private words live in the gitignored `server/.privacy-terms` (one
// case-insensitive regex per line, `#` comments), so the guard never has to publish what it protects.
// The local OS user and git e-mail are added automatically, so every contributor's copy catches the leak
// *they* are able to introduce.
//
// A legitimate hit is declared in `.claude/personalization-allowlist.txt` (one regex per line; matches
// are removed before scanning), or the line carries `personalization-ok`. Findings name the file, line
// and rule — never the matched text, so the gate log does not become a copy of the leak.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { withoutSshRemotes, withoutUrlUserinfo } = require("./email-hygiene.cjs");

const ROOT = path.resolve(__dirname, "..", "..");
const TERMS_FILE = path.join(ROOT, "server", ".privacy-terms");
const ALLOWLIST_FILE = path.join(ROOT, ".claude", "personalization-allowlist.txt");
const SKIP_LINE_MARKER = "personalization-ok";

const SKIP_PATHS = [/(^|\/)LICENSE$/, /(^|\/)package-lock\.json$/, /\.(png|jpe?g|gif|webp|ico|pdf|zip|gz|woff2?|ttf|otf|mp4)$/i];

/** Home-directory user names used by fixtures and docs on purpose. */
const NEUTRAL_USERS = new Set([
  "alex", "sam", "you", "user", "username", "me", "name", "someone", "operator", "runner", "runneradmin",
  "dev", "test", "tester", "lab", "u", "x", "public", "default", "shared", "all users", "node", "deploy",
]);

const HOME_PATH = /(?:\b[A-Za-z]:[\\/]+Users[\\/]+|(?<![\w.])\/home\/|(?<![\w.])\/Users\/)([A-Za-z0-9._-]+)/g;
// A version string (`Chrome/141.0.0.0`, `v1.2.3.4`) is preceded by a letter or a letter and a slash.
const IPV4 = /(?<![\w.-])(?<![A-Za-z]\/)(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})(?![\w.])/g;
const SNOWFLAKE = /(?<!\d)\d{17,19}(?!\d)/g;
const TAILNET = /\b[a-z0-9-]+\.(tail[0-9a-f]+)\.ts\.net\b/gi;
const PLACEHOLDER_TAILNETS = new Set(["tail0000", "tail1234"]);
const EMAIL = /[A-Za-z0-9._%+-]+@([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,})/g;
// Service and placeholder local parts (`someone@github.com` in a URL-parsing test names no one).
const SERVICE_MAILBOXES = /^(no-?reply|git|security|support|someone|user|owner|name|you|me)$/i;
// SVG path data (`d="M8 0C3.58 0 0 3.58 …"`) is a run of decimals that reads as dotted quads.
const SVG_PATH = /<path\b|\bd="[Mm]/;

/** RFC 2606/6761 reserved names and the shapes package metadata uses. */
function reservedDomain(domain) {
  const d = domain.toLowerCase();
  return (
    /(^|\.)example(\.|$)/.test(d) ||
    /\.(test|invalid|localhost|example|local)$/.test(d) ||
    d === "users.noreply.github.com"
  );
}

/** 10/8, 172.16/12, 192.168/16, loopback, link-local, 0/8, the RFC 5737 documentation nets, and toy
 *  all-single-digit addresses (`1.2.3.4`, `9.9.9.9`) that no real host is identified by. */
function harmlessIp(octets) {
  const [a, b, c] = octets;
  if (octets.some((o) => o > 255)) return true;
  if (octets.every((o) => o <= 9)) return true;
  if (a === 10 || a === 127 || a === 0 || a >= 224) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 169 && b === 254) return true;
  if (a === 192 && b === 0 && c === 2) return true;
  if (a === 198 && b === 51 && c === 100) return true;
  if (a === 203 && b === 0 && c === 113) return true;
  return false;
}

/** An obviously made-up id: few distinct digits (`100000000000000001`) or a counting run (`123456789012345678`). */
function fakeSnowflake(digits) {
  if (new Set(digits).size <= 3) return true;
  for (let i = 1; i < digits.length; i++) {
    if ((Number(digits[i - 1]) + 1) % 10 !== Number(digits[i])) return false;
  }
  return true;
}

/** Private words: the gitignored terms file plus this machine's own identity. */
function loadPrivateTerms({ termsFile = TERMS_FILE, identity = localIdentity() } = {}) {
  const terms = [];
  if (fs.existsSync(termsFile)) {
    for (const raw of fs.readFileSync(termsFile, "utf8").split(/\r?\n/)) {
      const line = raw.trim();
      if (line && !line.startsWith("#")) terms.push(new RegExp(line, "i"));
    }
  }
  for (const token of identity) terms.push(new RegExp(escapeRegex(token), "i"));
  return terms;
}

function localIdentity() {
  const tokens = new Set();
  const add = (t) => {
    const v = String(t || "").trim();
    if (v.length >= 4 && !NEUTRAL_USERS.has(v.toLowerCase())) tokens.add(v);
  };
  try {
    add(os.userInfo().username);
  } catch {
    /* no OS user in this sandbox */
  }
  const email = gitConfig("user.email");
  if (email && !/noreply/i.test(email)) {
    add(email);
    add(email.split("@")[0]);
  }
  return [...tokens];
}

function gitConfig(key) {
  try {
    return execFileSync("git", ["config", "--get", key], { cwd: ROOT, encoding: "utf8", windowsHide: true }).trim();
  } catch {
    return "";
  }
}

function loadAllowlist(file = ALLOWLIST_FILE) {
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, "utf8")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"))
    .map((l) => new RegExp(l, "gi"));
}

const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Every rule that fires on one line, after allowlisted spans are removed. */
function lineFindings(rawLine, { privateTerms = [], allowlist = [] } = {}) {
  if (rawLine.includes(SKIP_LINE_MARKER)) return [];
  let line = rawLine;
  for (const re of allowlist) line = line.replace(re, " ");
  const found = [];
  for (const m of line.matchAll(HOME_PATH)) {
    if (!NEUTRAL_USERS.has(m[1].toLowerCase())) found.push({ rule: "home-directory path", column: m.index + 1 });
  }
  for (const m of SVG_PATH.test(line) ? [] : line.matchAll(IPV4)) {
    if (!harmlessIp(m.slice(1, 5).map(Number))) found.push({ rule: "public IPv4 address", column: m.index + 1 });
  }
  for (const m of line.matchAll(SNOWFLAKE)) {
    if (!fakeSnowflake(m[0])) found.push({ rule: "real-looking account id (17-19 digits)", column: m.index + 1 });
  }
  for (const m of line.matchAll(TAILNET)) {
    if (!PLACEHOLDER_TAILNETS.has(m[1].toLowerCase())) found.push({ rule: "tailnet hostname", column: m.index + 1 });
  }
  for (const m of withoutUrlUserinfo(withoutSshRemotes(line)).matchAll(EMAIL)) {
    const local = m[0].slice(0, m[0].indexOf("@"));
    if (!reservedDomain(m[1]) && !SERVICE_MAILBOXES.test(local)) found.push({ rule: "e-mail address", column: m.index + 1 });
  }
  for (const re of privateTerms) {
    const m = re.exec(line);
    if (m) found.push({ rule: "private term (server/.privacy-terms or local identity)", column: m.index + 1 });
  }
  return found;
}

function trackedFiles() {
  return execFileSync("git", ["ls-files", "-z"], { cwd: ROOT, encoding: "utf8", maxBuffer: 1 << 26, windowsHide: true })
    .split("\0")
    .filter((f) => f && !SKIP_PATHS.some((re) => re.test(f)));
}

/** Findings across the tracked tree as `{ file, line, column, rule }`. */
function scanTree({ files = trackedFiles(), privateTerms = loadPrivateTerms(), allowlist = loadAllowlist() } = {}) {
  const findings = [];
  for (const file of files) {
    const abs = path.join(ROOT, file);
    let text;
    try {
      text = fs.readFileSync(abs, "utf8");
    } catch {
      continue; // deleted in the working tree
    }
    if (text.includes("\0")) continue;
    text.split(/\r?\n/).forEach((l, i) => {
      for (const f of lineFindings(l, { privateTerms, allowlist })) findings.push({ file, line: i + 1, ...f });
    });
  }
  return findings;
}

if (require.main === module) {
  const privateTerms = loadPrivateTerms();
  const findings = scanTree({ privateTerms });
  const termsNote = fs.existsSync(TERMS_FILE) ? "with server/.privacy-terms" : "no server/.privacy-terms on this machine";
  if (!findings.length) {
    console.log(`privacy guard: tracked tree clean (${privateTerms.length} private terms, ${termsNote}).`);
    process.exit(0);
  }
  for (const f of findings) console.log(`  ✗ ${f.file}:${f.line}:${f.column}  ${f.rule}`);
  console.log(
    `\nprivacy guard: ${findings.length} finding(s). Replace the value with a neutral example (alex/sam, example.com, ` +
      "192.0.2.x, 100000000000000001), or declare a legitimate public value in .claude/personalization-allowlist.txt.",
  );
  process.exit(1);
}

module.exports = { lineFindings, scanTree, loadPrivateTerms, loadAllowlist, harmlessIp, fakeSnowflake, reservedDomain, NEUTRAL_USERS };
