const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { brotliCompressSync, gzipSync } = require("node:zlib");
const { verifyCompressedEntry } = require("./verify-compressed-entry.cjs");

const dist = fs.mkdtempSync(path.join(os.tmpdir(), "compressed-entry-"));
try {
  const current = Buffer.from('<script src="./assets/current.js"></script>');
  const stale = Buffer.from('<script src="./assets/previous.js"></script>');
  fs.writeFileSync(path.join(dist, "index.html"), current);
  verifyCompressedEntry(dist); // Small entries may intentionally have no compressed variant.
  for (const [suffix, encode] of [[".br", brotliCompressSync], [".gz", gzipSync]]) {
    const target = path.join(dist, "index.html" + suffix);
    fs.writeFileSync(target, encode(stale));
    assert.throws(() => verifyCompressedEntry(dist), /compressed clients would load another build/);
    fs.writeFileSync(target, encode(current));
    verifyCompressedEntry(dist);
  }
  console.log("Compressed entry regression: stale Brotli/gzip rejected; matching and uncompressed entries pass.");
} finally {
  fs.rmSync(dist, { recursive: true, force: true });
}
