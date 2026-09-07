#!/usr/bin/env node
// Verify that the running server is on the current HEAD commit.
// Fast read-only check after a server restart to confirm the new code is live.
//
//   npm run verify:deployment --prefix server
//   node scripts/verify-deployment.cjs [--port 4317]
//

const { execSync } = require("child_process");
const http = require("http");

const port = process.argv.includes("--port")
  ? parseInt(process.argv[process.argv.indexOf("--port") + 1])
  : 4317;

function getHeadCommit() {
  try {
    return execSync("git rev-parse HEAD", { encoding: "utf-8", windowsHide: true }).trim();
  } catch (e) {
    console.error("Failed to get HEAD commit:", e.message);
    process.exit(1);
  }
}

function getRunningCommit(callback) {
  const req = http.get(`http://127.0.0.1:${port}/api/health`, (res) => {
    let data = "";
    res.on("data", chunk => data += chunk);
    res.on("end", () => {
      try {
        const health = JSON.parse(data);
        callback(null, health.build?.commit);
      } catch (e) {
        callback(e);
      }
    });
  });

  req.on("error", callback);
  req.setTimeout(5000, () => {
    req.destroy();
    callback(new Error(`Timeout connecting to http://127.0.0.1:${port}/api/health`));
  });
}

const headCommit = getHeadCommit();

getRunningCommit((err, runningCommit) => {
  if (err) {
    console.error(`✗ Server not responding on :${port}`);
    console.error(`  Error: ${err.message}`);
    process.exit(1);
  }

  if (!runningCommit) {
    console.error("✗ Server returned no build commit (unstamped build?)");
    process.exit(1);
  }

  const match = headCommit.startsWith(runningCommit) || runningCommit.startsWith(headCommit);

  if (match) {
    console.log(`✅ Deployment is live`);
    console.log(`   HEAD commit: ${headCommit}`);
    console.log(`   Running:     ${runningCommit}`);
    process.exit(0);
  } else {
    console.error(`✗ Deployment out of date`);
    console.error(`  HEAD:    ${headCommit}`);
    console.error(`  Running: ${runningCommit}`);
    console.error(`\n  Run: npm run deploy --prefix server`);
    process.exit(1);
  }
});
