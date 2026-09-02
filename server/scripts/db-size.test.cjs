// Gate for the analysis in probe-db-size.cjs — the sweep's only measurement of what the database is
// actually made of, and the standing regression check on the attachment store.
//
// The failure mode it guards is that this probe reports GREEN over a real problem. That is not
// hypothetical: the thing it exists to catch (75 MB of duplicated pictures) sat undetected for months
// precisely because the only "measurement" was a row count, which is green by construction. So every
// assertion below builds a database that HAS the defect and requires the probe to see it.
//
// Free (no agents, no network, no quota): a throwaway SQLite file in a temp dir.
//
// Run: node scripts/db-size.test.cjs

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Database = require("better-sqlite3");

const { tableSizes, attachmentRedundancy, growthPerDay, headroomDays, verdictFor } = require("./probe-db-size.cjs");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gg-dbsize-"));
const dbPath = path.join(dir, "t.sqlite");
const db = new Database(dbPath);

db.exec(`
  CREATE TABLE attachments (id TEXT PRIMARY KEY, name TEXT, media_type TEXT, data TEXT, sha256 TEXT, created_at INTEGER);
  CREATE TABLE messages (id TEXT PRIMARY KEY, content TEXT, attachments TEXT NOT NULL DEFAULT '[]', created_at INTEGER);
  CREATE TABLE director_messages (id TEXT PRIMARY KEY, content TEXT, attachments TEXT NOT NULL DEFAULT '[]', created_at INTEGER);
  CREATE TABLE cowork_messages (id TEXT PRIMARY KEY, content TEXT, attachments TEXT NOT NULL DEFAULT '[]', created_at INTEGER);
  CREATE INDEX idx_messages_created ON messages(created_at);
`);

const sha = (s) => crypto.createHash("sha256").update(s).digest("hex");
const now = Date.now();
const addBlob = (id, name, data, { hashed = true, mediaType = "image/png" } = {}) =>
  db
    .prepare("INSERT INTO attachments(id, name, media_type, data, sha256, created_at) VALUES(?,?,?,?,?,?)")
    .run(id, name, mediaType, data, hashed ? sha(data) : null, now);
const addMessage = (id, refIds, at = now) =>
  db
    .prepare("INSERT INTO messages(id, content, attachments, created_at) VALUES(?,?,?,?)")
    .run(id, "x".repeat(100), JSON.stringify(refIds.map((r) => ({ id: r, name: "image.png", mediaType: "image/png" }))), at);
const addCoworkMessage = (id, refIds, at = now) =>
  db
    .prepare("INSERT INTO cowork_messages(id, content, attachments, created_at) VALUES(?,?,?,?)")
    .run(id, "pair on this", JSON.stringify(refIds.map((r) => ({ id: r, name: "notes.txt", mediaType: "text/plain" }))), at);

// ---- a healthy store: one row per attachment, every row referenced ----------------------------------
const PIC = "A".repeat(4096);
const OTHER = "B".repeat(4096);
const COWORK_FILE = "C".repeat(4096);
addBlob("keep-1", "image.png", PIC);
addBlob("keep-2", "other.png", OTHER);
addBlob("keep-cowork", "notes.txt", COWORK_FILE, { mediaType: "text/plain" });
addMessage("m1", ["keep-1"]);
db.prepare("INSERT INTO director_messages(id, content, attachments, created_at) VALUES(?,?,?,?)").run(
  "d1",
  "drop",
  JSON.stringify([{ id: "keep-1", name: "image.png", mediaType: "image/png" }]),
  now,
);
addMessage("m2", ["keep-2"]);
addCoworkMessage("cm1", ["keep-cowork"]);

let r = attachmentRedundancy(db);
assert.equal(r.duplicateRows, 0, "one row per attachment is not a duplicate");
assert.equal(r.orphanRows, 0, "every blob is referenced");
assert.equal(r.unhashedRows, 0);
assert.equal(r.referenced, 3, "counts DISTINCT attachments, not refs — keep-1 is referenced twice and Co-work-only bytes count");
assert.deepEqual(r.referenceTables, ["messages", "director_messages", "cowork_messages"]);
assert.equal(verdictFor(r).ok, true, "a healthy store is green");
assert.equal(verdictFor(r).fatal, false);

// ---- the regression this probe exists for: the same picture stored per reference --------------------
addBlob("dup-1", "image.png", PIC); // identical bytes AND name => what addAttachment must never create
r = attachmentRedundancy(db);
assert.equal(r.duplicateRows, 1, "a second row with identical content+name is a duplicate");
assert.ok(r.duplicateBytes >= 4096, `duplicate bytes should count the wasted copy, got ${r.duplicateBytes}`);
let v = verdictFor(r);
assert.equal(v.ok, false);
assert.equal(v.fatal, true, "a dedupe regression is a code defect and must fail the sweep");
assert.match(v.problems[0].text, /content-addressing/, "the message must name the code that regressed");

// ---- the same bytes deliberately kept under another name is NOT waste -------------------------------
db.prepare("DELETE FROM attachments WHERE id = 'dup-1'").run();
addBlob("renamed", "screenshot.png", PIC); // same bytes, different filename => its own row, by design
addMessage("m3", ["renamed"]);
r = attachmentRedundancy(db);
assert.equal(r.duplicateRows, 0, "keyed on name+type like addAttachment — a distinct filename is not a duplicate");
assert.equal(verdictFor(r).ok, true, "…so it must not be reported as waste");

// ---- an orphan is a warning, not a failure (a crash can leave one legitimately) ---------------------
addBlob("orphan-1", "image.png", "C".repeat(2048));
r = attachmentRedundancy(db);
assert.equal(r.orphanRows, 1);
v = verdictFor(r);
assert.equal(v.ok, false, "an orphan is reported");
assert.equal(v.fatal, false, "…but does not fail the sweep — a crash mid-write can produce one");
assert.match(v.problems[0].text, /deleteThread|resetThreadForRetry/, "the warning must name where pruning happens");

// ---- a row that never went through addAttachment is fatal ------------------------------------------
db.prepare("DELETE FROM attachments WHERE id = 'orphan-1'").run();
addBlob("raw-1", "raw.png", "D".repeat(2048), { hashed: false });
addMessage("m4", ["raw-1"]);
r = attachmentRedundancy(db);
assert.equal(r.unhashedRows, 1);
assert.equal(verdictFor(r).fatal, true, "an unhashed row means an insert path bypassed the dedupe entirely");
db.prepare("DELETE FROM attachments WHERE id = 'raw-1'").run();
db.prepare("DELETE FROM messages WHERE id = 'm4'").run();

// ---- sizes are reported by BYTES, with indexes folded into the table they serve ---------------------
const sizes = tableSizes(db);
const names = sizes.map((s) => s.table);
assert.ok(names.includes("messages") && names.includes("attachments"), `expected the real tables, got ${names}`);
assert.equal(
  names.includes("idx_messages_created"),
  false,
  "an index must be folded into its table, not listed as its own line — that is what hides where the weight is",
);
const messages = sizes.find((s) => s.table === "messages");
assert.ok(messages.indexBytes > 0, "the folded index bytes are still reported, so the cost stays visible");

// The whole point: a table with FEW rows but MANY bytes must outrank a table with many rows.
for (let i = 0; i < 200; i++) addMessage(`bulk-${i}`, []);
addBlob("big-1", "big.png", "E".repeat(400_000));
addMessage("m-big", ["big-1"]);
const ranked = tableSizes(db);
assert.equal(
  ranked[0].table,
  "attachments",
  `bytes must rank above row count — 3 blobs outweigh 200+ messages, got ${ranked.map((s) => s.table)}`,
);

// ---- growth + headroom -----------------------------------------------------------------------------
const growth = growthPerDay(db, 7);
assert.ok(growth.messagesPerDay > 0, "recent rows are counted as growth");
assert.ok(growth.bytesPerDay > 0, "content bytes are counted, not just rows");
const old = now - 30 * 86400_000;
assert.equal(growthPerDay(db, 7).days, 7, "the window is what the caller asked for");
addMessage("ancient", [], old);
assert.equal(
  growthPerDay(db, 7).messagesPerDay,
  growth.messagesPerDay,
  "a row older than the window must not count toward the rate",
);

assert.equal(headroomDays(1000, 100), 10, "headroom is free space divided by the daily burn");
assert.equal(headroomDays(1000, 0), null, "an idle DB has no projectable headroom — never report Infinity");
assert.equal(headroomDays(0, 100), 0, "no free space means the file grows on the next write");

db.close();
fs.rmSync(dir, { recursive: true, force: true });
console.log("PASS — db-size probe analysis");
