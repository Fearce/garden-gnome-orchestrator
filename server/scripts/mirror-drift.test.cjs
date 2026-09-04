// Enforce every "mirrored byte-for-byte" claim this repo makes about a copied file or declaration.
//
// Three packages deliberately copy code instead of importing it — `relay/src/protocol.ts` into
// `server/src/office/onlineProtocol.ts` (the relay ships as a one-dependency container, the server
// carries the Agent SDK and a native sqlite build), and parts of `server/src/types.ts` into
// `web/src/types.ts` (one bundle, no shared package). Each copy says so in a comment, and until now that
// comment was the ONLY thing holding the pair together: nothing failed if you edited one side.
//
// That is the exact shape of a defect that ships green. A protocol constant added on one end and not the
// other typechecks on both, passes every gate, and then two machines disagree about a room at runtime;
// a grouping function that drifts puts the server and the console in different rooms for one workspace.
// Kevin's own memory on knowingly-duplicated helpers is blunt about the odds: of the mirrored pairs
// audited there, exactly one had a lockstep test and every other had already drifted.
//
// So this gate reads the CLAIMS rather than a hardcoded list — a new mirror written anywhere under
// server/src, web/src or relay/src is enforced the moment its comment says "byte-for-byte", and a claim
// that names a file or symbol which no longer exists fails loudly instead of decaying into a lie.
//
// Run: npm run test:mirror-drift --prefix server

const fs = require("node:fs");
const path = require("node:path");

const REPO = path.resolve(__dirname, "..", "..");
const ROOTS = ["server/src", "web/src", "relay/src"];
const CLAIM = /mirror(?:s|ed|ing)?\b[^\n]{0,60}?byte[- ]for[- ]byte/i;
const PATH_TOKEN = /\b((?:server|web|relay)\/src\/[\w./-]+\.tsx?)\b/;
const DECL = /^\s*export\s+(?:default\s+)?(?:abstract\s+)?(interface|function|const|type|class|enum)\s+([A-Za-z_$][\w$]*)/;

let failures = 0;
let checked = 0;
const fail = (what, detail) => {
  failures++;
  console.log(`  ✗ ${what}`);
  for (const line of String(detail).split("\n")) console.log(`      ${line}`);
};
const pass = (what) => {
  checked++;
  console.log(`  ✓ ${what}`);
};

const read = (rel) => fs.readFileSync(path.join(REPO, rel), "utf8");
const exists = (rel) => fs.existsSync(path.join(REPO, rel));

function sourceFiles(root) {
  const dir = path.join(REPO, root);
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = `${root}/${entry.name}`;
    if (entry.isDirectory()) out.push(...sourceFiles(rel));
    else if (/\.tsx?$/.test(entry.name)) out.push(rel);
  }
  return out;
}

/** The contiguous comment block a claim line sits in, plus the line index just past it. */
function commentBlock(lines, at) {
  const isComment = (l) => /^\s*(\/\/|\/\*|\*)/.test(l) || /^\s*$/.test(l) === false && /^\s*\*\//.test(l);
  let start = at;
  while (start > 0 && isComment(lines[start - 1])) start--;
  let end = at;
  while (end + 1 < lines.length && isComment(lines[end + 1])) end++;
  return { text: lines.slice(start, end + 1).join("\n"), start, after: end + 1 };
}

/**
 * The file a claim is about. Named explicitly whenever the comment carries a path — which is what a
 * claim SHOULD do, so the guard can check it. The one inference kept is the "mirrors the server's X"
 * wording used on the web side, because `types.ts` is the only shared contract file there.
 */
function counterpartOf(file, block) {
  const named = block.match(PATH_TOKEN);
  if (named) return named[1];
  if (file.startsWith("web/") && /\bserver'?s\b/i.test(block)) return "server/src/types.ts";
  if (file.startsWith("server/") && /\b(client|web|console)'?s\b/i.test(block)) return "web/src/types.ts";
  return null;
}

/** Strip comments so a claim about a DECLARATION is judged on the declaration, not on either side's
 *  prose. Only whole-line and unambiguous trailing comments go: a `//` inside a string or a regex
 *  literal (`.replace(/\\/g, "/")`) must survive, so a trailing comment is cut only when the code
 *  before it has balanced quotes and no slash-delimited literal in flight. */
function stripComments(src) {
  const out = [];
  let inBlock = false;
  for (const raw of src.split("\n")) {
    let line = raw;
    if (inBlock) {
      const close = line.indexOf("*/");
      if (close < 0) continue;
      line = line.slice(close + 2);
      inBlock = false;
    }
    const open = line.indexOf("/*");
    if (open >= 0 && !line.slice(0, open).includes("//")) {
      const close = line.indexOf("*/", open + 2);
      if (close < 0) {
        inBlock = true;
        line = line.slice(0, open);
      } else line = line.slice(0, open) + line.slice(close + 2);
    }
    const cut = trailingCommentAt(line);
    if (cut >= 0) line = line.slice(0, cut);
    if (line.trim()) out.push(line);
  }
  return out.join("\n").replace(/[ \t]+/g, " ").replace(/\s*\n\s*/g, "\n").trim();
}

/** Index of a `//` that really starts a comment on this line, or -1. */
function trailingCommentAt(line) {
  let quote = null;
  for (let i = 0; i < line.length - 1; i++) {
    const c = line[i];
    if (quote) {
      if (c === "\\") i++;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      quote = c;
      continue;
    }
    if (c === "/" && line[i + 1] === "/") return i;
    // A regex literal: skip to its end so `/[\\/]+$/` can never look like a comment.
    if (c === "/" && /[=(,:[!&|?{;]\s*$/.test(line.slice(0, i))) {
      let j = i + 1;
      let inClass = false;
      for (; j < line.length; j++) {
        if (line[j] === "\\") j++;
        else if (line[j] === "[") inClass = true;
        else if (line[j] === "]") inClass = false;
        else if (line[j] === "/" && !inClass) break;
      }
      i = j;
    }
  }
  return -1;
}

/** The complete source of one exported declaration, or null when the file doesn't declare it. */
function declarationOf(src, name) {
  const lines = src.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(DECL);
    if (!m || m[2] !== name) continue;
    let depth = 0;
    let seen = false;
    for (let j = i; j < lines.length; j++) {
      for (const c of lines[j]) {
        if (c === "{" || c === "[" || c === "(") {
          depth++;
          seen = true;
        } else if (c === "}" || c === "]" || c === ")") depth--;
      }
      const done = seen ? depth <= 0 : /;\s*$/.test(lines[j]);
      if (done) return lines.slice(i, j + 1).join("\n");
    }
    return lines.slice(i).join("\n");
  }
  return null;
}

/** A whole-file mirror: identical, except that each copy names the other in its header line. */
function checkWholeFile(a, b) {
  const left = read(a).split("\n");
  const right = read(b).split("\n");
  const label = `${a} ≡ ${b}`;
  if (left.length !== right.length) {
    return fail(label, `line counts differ: ${left.length} vs ${right.length} — the copies have diverged`);
  }
  const diffs = [];
  for (let i = 0; i < left.length; i++) {
    if (left[i] === right[i]) continue;
    // The one licensed difference: the header line in which each copy points at the other.
    if (CLAIM.test(left[i]) && CLAIM.test(right[i])) continue;
    diffs.push(`line ${i + 1}:\n        ${a}: ${left[i].trim()}\n        ${b}: ${right[i].trim()}`);
  }
  if (diffs.length) return fail(label, diffs.join("\n"));
  pass(`${label} (whole file, ${left.length} lines)`);
}

function checkDeclaration(file, counterpart, name) {
  const label = `${name}: ${file} ≡ ${counterpart}`;
  const mine = declarationOf(read(file), name);
  const theirs = declarationOf(read(counterpart), name);
  if (!mine) return fail(label, `${file} no longer declares ${name} — the claim outlived what it described`);
  if (!theirs) {
    return fail(label, `${counterpart} does not declare ${name}: it was renamed or dropped on that side, and the mirror is now a lie`);
  }
  const a = stripComments(mine);
  const b = stripComments(theirs);
  if (a !== b) return fail(label, `the two declarations differ (comments ignored):\n  ${file}:\n    ${a}\n  ${counterpart}:\n    ${b}`);
  pass(label);
}

console.log("=== mirrored-source drift ===");
const claims = [];
for (const root of ROOTS) {
  for (const file of sourceFiles(root)) {
    const lines = read(file).split("\n");
    for (let i = 0; i < lines.length; i++) {
      if (!CLAIM.test(lines[i])) continue;
      const block = commentBlock(lines, i);
      if (claims.some((c) => c.file === file && c.start === block.start)) continue;
      claims.push({ file, lines, ...block });
    }
  }
}

if (!claims.length) {
  console.log("  ✗ no byte-for-byte claims found at all — the scanner is looking in the wrong place");
  process.exit(1);
}

for (const claim of claims) {
  const counterpart = counterpartOf(claim.file, claim.text);
  const where = `${claim.file}:${claim.start + 1}`;
  if (!counterpart) {
    fail(where, "the claim names no counterpart file, so nothing can check it — name the path in the comment");
    continue;
  }
  if (!exists(counterpart)) {
    fail(where, `it claims to mirror ${counterpart}, which does not exist`);
    continue;
  }
  if (claim.start === 0) {
    checkWholeFile(claim.file, counterpart);
    continue;
  }
  const decl = claim.lines.slice(claim.after).find((l) => DECL.test(l));
  const name = decl && decl.match(DECL)[2];
  if (!name) {
    fail(where, "the claim is not a file header and no exported declaration follows it — move it above what it describes");
    continue;
  }
  checkDeclaration(claim.file, counterpart, name);
}

console.log(`\n=== ${checked} mirror(s) verified, ${failures} drifted ===`);
process.exit(failures ? 1 : 0);
