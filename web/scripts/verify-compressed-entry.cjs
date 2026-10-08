const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { brotliDecompressSync, gunzipSync } = require("node:zlib");

function verifyCompressedFile(dist, name) {
  const entry = path.join(dist, name);
  const plain = fs.readFileSync(entry);
  for (const [suffix, decode] of [[".br", brotliDecompressSync], [".gz", gunzipSync]]) {
    if (!fs.existsSync(entry + suffix)) continue;
    assert.deepEqual(decode(fs.readFileSync(entry + suffix)), plain,
      `${name}${suffix} differs from the emitted file; compressed clients would load another build`);
  }
  return plain;
}

function verifyCompressedEntry(dist) {
  const html = verifyCompressedFile(dist, "index.html").toString("utf8");
  const assets = new Set(Array.from(html.matchAll(
    /(?:src|href)=["'](?:\.\/|\/)?(assets\/[^"'?#]+\.(?:js|css))(?:[?#][^"']*)?["']/g,
  ), (match) => match[1]));
  for (const asset of assets) verifyCompressedFile(dist, asset);
}

if (require.main === module) {
  verifyCompressedEntry(path.resolve(process.argv[2] || path.join(__dirname, "../dist")));
  console.log("Compressed entry and referenced JavaScript/CSS match emitted files.");
}
module.exports = { verifyCompressedEntry };
