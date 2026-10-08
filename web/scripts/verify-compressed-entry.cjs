const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { brotliDecompressSync, gunzipSync } = require("node:zlib");

function verifyCompressedEntry(dist) {
  const entry = path.join(dist, "index.html");
  const plain = fs.readFileSync(entry);
  for (const [suffix, decode] of [[".br", brotliDecompressSync], [".gz", gunzipSync]]) {
    if (!fs.existsSync(entry + suffix)) continue;
    assert.deepEqual(decode(fs.readFileSync(entry + suffix)), plain,
      `index.html${suffix} differs from the emitted entry; compressed clients would load another build`);
  }
}

if (require.main === module) {
  verifyCompressedEntry(path.resolve(process.argv[2] || path.join(__dirname, "../dist")));
  console.log("Compressed entry matches the emitted HTML.");
}
module.exports = { verifyCompressedEntry };
