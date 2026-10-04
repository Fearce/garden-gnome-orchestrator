// Playwright's inspector-driven quit can be slow under load. Both real-app probes use the same
// finite budget and release the timeout on success as well as failure.
const APP_SHUTDOWN_TIMEOUT_MS = 60_000;

async function waitForAppClose(app, timeoutMs = APP_SHUTDOWN_TIMEOUT_MS) {
  let timer;
  try {
    await Promise.race([
      app.close(),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Desktop app did not exit within ${timeoutMs / 1000} seconds; refusing to measure it as closed.`)), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { waitForAppClose };
