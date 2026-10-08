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
  fs.mkdirSync(path.join(dist, "assets"));
  fs.writeFileSync(path.join(dist, "assets/current.js"), "console.log('current');");
  fs.writeFileSync(path.join(dist, "index.html"), current);
  verifyCompressedEntry(dist); // Small entries may intentionally have no compressed variant.
  for (const [suffix, encode] of [[".br", brotliCompressSync], [".gz", gzipSync]]) {
    const target = path.join(dist, "index.html" + suffix);
    fs.writeFileSync(target, encode(stale));
    assert.throws(() => verifyCompressedEntry(dist), /compressed clients would load another build/);
    fs.writeFileSync(target, encode(current));
    verifyCompressedEntry(dist);
  }
  const cssEntry = Buffer.from('<script src="./assets/current.js"></script><link href="/assets/current.css?v=1" rel="stylesheet">');
  fs.writeFileSync(path.join(dist, "index.html"), cssEntry);
  fs.writeFileSync(path.join(dist, "index.html.br"), brotliCompressSync(cssEntry));
  fs.writeFileSync(path.join(dist, "index.html.gz"), gzipSync(cssEntry));
  fs.writeFileSync(path.join(dist, "assets/current.css"), "body { color: blue; }");
  for (const asset of ["current.js", "current.css"]) {
    for (const [suffix, encode] of [[".br", brotliCompressSync], [".gz", gzipSync]]) {
      const target = path.join(dist, "assets", asset);
      fs.writeFileSync(target + suffix, encode("stale asset"));
      assert.throws(() => verifyCompressedEntry(dist), /compressed clients would load another build/);
      fs.writeFileSync(target + suffix, encode(fs.readFileSync(target)));
      verifyCompressedEntry(dist);
    }
  }
  console.log("Compressed entry regression: stale HTML/JavaScript/CSS Brotli/gzip rejected; matching and uncompressed files pass.");
} finally {
  fs.rmSync(dist, { recursive: true, force: true });
}
