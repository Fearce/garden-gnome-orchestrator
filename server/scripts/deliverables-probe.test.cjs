// Gate for probe-deliverables.cjs, the only check that a card the console renders can actually be
// clicked. Free: real temp files, no database, no agent, no network, no quota.
//
// Run: node scripts/deliverables-probe.test.cjs
//
// The failure mode being guarded is the one every "is it broken?" tool has: reporting GREEN over a real
// problem. So every assertion below builds a deliverable that IS broken in one specific way and requires
// the probe to name that exact way. Asserting only the happy path would have passed against a classifier
// that returned "ok" unconditionally, which is precisely the state the world was in before this probe
// existed: 32 dead cards in the live store and nothing that could say so.
//
// The second thing it pins is the verdict POLICY, because that is what decides whether the nightly sweep
// goes red. A missing file must never be fatal (the owner deleting an old screenshot is not a defect, and
// a permanently red probe stops being read), while a recent escape must always be fatal (that card was
// never serveable, so something is still emitting bad paths right now). Those two live one field apart in
// the same function and are easy to swap, so both directions are asserted.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  classifyDeliverable,
  suggestWorkspaceRelativeFix,
  looksLikeAgentScratch,
  verdictFor,
  MAX_DELIVERABLE_BYTES,
  LIVE_WINDOW_DAYS,
} = require("./probe-deliverables.cjs");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "gg-deliv-"));
const ws = path.join(root, "workspace");
const outside = path.join(root, "elsewhere");
const repo = path.join(ws, "checkout");
fs.mkdirSync(repo, { recursive: true });
fs.mkdirSync(outside, { recursive: true });

const write = (p, body = "report") => {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, body);
  return p;
};
const row = (over) => ({ workspace: ws, createdAt: Date.now(), ...over });
const classOf = (over) => classifyDeliverable(row(over)).class;

// ---- the shape that must serve: an absolute path inside the workspace --------------------------------
const good = write(path.join(ws, "report.md"), "# findings");
assert.equal(classOf({ path: good }), "ok", "an absolute in-workspace file must serve");
assert.equal(classOf({ path: "report.md" }), "ok", "a workspace-relative path must serve");
assert.equal(classOf({ path: path.join("checkout", "nested.md") && "checkout/nested.md" }), "missing");
write(path.join(repo, "nested.md"));
assert.equal(classOf({ path: "checkout/nested.md" }), "ok", "a relative path into a nested checkout must serve");

// ---- every way a rendered card can be dead -----------------------------------------------------------
assert.equal(classOf({ path: path.join(ws, "never-written.md") }), "missing", "a deleted file must not read as ok");
assert.equal(
  classOf({ path: write(path.join(outside, "leaked.md")) }),
  "escapes",
  "a file outside the workspace must be caught, which is the 403 the route returns",
);
assert.equal(classOf({ path: "../elsewhere/leaked.md" }), "escapes", "a relative path may not climb out either");
assert.equal(classOf({ path: ws }), "escapes", "the workspace root itself is not contained in the workspace");
assert.equal(classOf({ path: repo }), "not-a-file", "a directory must not be offered as a download");
assert.equal(classOf({ path: "" }), "no-path");
assert.equal(classOf({ path: null }), "no-path");
assert.equal(classifyDeliverable({ workspace: null, path: good }).class, "no-task", "a deliverable whose task is gone");
assert.equal(
  classifyDeliverable({ workspace: path.join(root, "vanished"), path: "x.md" }).class,
  "workspace-gone",
  "a workspace that no longer exists is not the same failure as a missing file",
);

// The cap is the route's, and a file one byte over it 413s while the card still renders.
const big = path.join(ws, "build.zip");
fs.writeFileSync(big, "");
fs.truncateSync(big, MAX_DELIVERABLE_BYTES + 1);
assert.equal(classOf({ path: big }), "too-large");
fs.truncateSync(big, MAX_DELIVERABLE_BYTES);
assert.equal(classOf({ path: big }), "ok", "exactly at the cap still serves, so the boundary is not off by one");

// A symlink inside the workspace pointing out of it is the containment check's whole reason for
// resolving both sides. Windows refuses the link without privilege, so prove it only where it can exist.
try {
  const link = path.join(ws, "link.md");
  fs.symlinkSync(path.join(outside, "leaked.md"), link);
  assert.equal(classOf({ path: link }), "escapes", "a symlink out of the workspace must not defeat containment");
} catch (err) {
  if (!["EPERM", "EACCES", "ENOSYS"].includes(err.code)) throw err;
  console.log("  (symlink case skipped: this box does not allow creating one)");
}

// ---- the documented recurring 404: a relative path resolving against the PARENT of the checkout -------
// The task workspace is routinely the parent of the git repo, so a file saved into the repo is not found
// by a repo-relative path. The probe has to name the absolute path that would have worked, not just 404.
write(path.join(repo, "docs", "summary.md"));
const suggestion = suggestWorkspaceRelativeFix(row({ path: "docs/summary.md" }));
assert.equal(suggestion, path.join(repo, "docs", "summary.md"), "the nested-checkout fix must be found and named");
assert.equal(suggestWorkspaceRelativeFix(row({ path: good })), null, "an absolute path needs no such suggestion");
assert.equal(suggestWorkspaceRelativeFix(row({ path: "docs/absent.md" })), null, "no guess when nothing matches");

// ---- the scratch-area tell, which is what turned 12 mystery rows into one actionable sentence ---------
assert.equal(looksLikeAgentScratch("C:\\Users\\x\\AppData\\Local\\Temp\\claude\\abc\\scratchpad\\shot.png"), true);
assert.equal(looksLikeAgentScratch("/tmp/claude/abc/scratchpad/shot.png"), true);
assert.equal(looksLikeAgentScratch("C:\\Users\\x\\projects\\app\\docs\\report.md"), false, "a normal path is not scratch");

// ---- the verdict policy: what may turn the nightly sweep red -----------------------------------------
const NOW = 1_800_000_000_000;
const at = (days) => NOW - days * 86_400_000;
const seen = (cls, days, over = {}) => ({ class: cls, createdAt: at(days), ...over });

const clean = verdictFor([seen("ok", 1), seen("ok", 400)], { now: NOW });
assert.equal(clean.ok, true, "an all-serving store must be quiet");
assert.equal(clean.fatal, false);
assert.equal(clean.servable, 2);

const rot = verdictFor([seen("missing", 200), seen("workspace-gone", 90), seen("too-large", 1)], { now: NOW });
assert.equal(rot.fatal, false, "deleted files and oversized files are the owner's business, never a red sweep");
assert.equal(rot.ok, false, "but they are still reported");
assert.equal(rot.broken, 3);

const liveEscape = verdictFor([seen("escapes", 1)], { now: NOW });
assert.equal(liveEscape.fatal, true, "a card born broken in the last week must fail the probe");

const oldEscape = verdictFor([seen("escapes", LIVE_WINDOW_DAYS + 1)], { now: NOW });
assert.equal(oldEscape.fatal, false, "the same defect already in history must not hold the sweep red forever");
assert.match(oldEscape.problems[0].text, /already in history/);

assert.equal(verdictFor([seen("no-path", 500)], { now: NOW }).fatal, true, "a pathless card is a code defect at any age");
assert.equal(verdictFor([seen("no-task", 500)], { now: NOW }).fatal, true, "an orphaned card is a code defect at any age");

// The scratch count is what tells the reader WHERE the bad paths come from, so it has to survive into
// the fatal line rather than only appearing in the per-row detail.
const scratchVerdict = verdictFor(
  [seen("escapes", 1, { resolved: "/tmp/claude/x/scratchpad/a.png" }), seen("escapes", 2, { resolved: "/home/u/other/b.png" })],
  { now: NOW },
);
assert.match(scratchVerdict.problems[0].text, /1 of them from an agent's own scratch area/);

fs.rmSync(root, { recursive: true, force: true });
console.log("deliverables probe: all checks passed");
