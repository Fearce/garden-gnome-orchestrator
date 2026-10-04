// The Electron executable for the desktop scripts. Electron's package has no install script: requiring
// it returns the binary's path and downloads the binary first if a fresh install lacks it.
function electronBinary() {
  try {
    return require("electron");
  } catch (error) {
    console.error(`no Electron binary (${error.message}) — run \`npm run desktop:install\` from the repository root.`);
    process.exit(2);
  }
}

module.exports = { electronBinary };
