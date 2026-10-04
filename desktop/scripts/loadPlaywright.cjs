// Playwright for the desktop scripts. It is installed globally rather than as a dependency here,
// because only `_electron` is needed and the browsers it downloads are shared with the server's labs.
const fs = require("node:fs");
const path = require("node:path");
const { globalModuleRoots } = require("../../server/scripts/findPlaywright.cjs");

function loadPlaywright() {
  for (const root of globalModuleRoots()) {
    const candidate = path.join(root, "playwright");
    if (fs.existsSync(path.join(candidate, "package.json"))) return require(candidate);
  }
  const fallback = path.join(process.env.APPDATA ?? "", "npm", "node_modules", "playwright");
  if (fs.existsSync(fallback)) return require(fallback);
  throw new Error("Playwright not found in any global module root (npm install -g playwright)");
}

module.exports = { loadPlaywright };
