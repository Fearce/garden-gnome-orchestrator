// Can script-hub actually STOP this server, or only see it?
//
// The two questions have different answers and only one of them is ever asked. `/api/status` finds a
// registered script by cmdline pattern OR by listening port, so an entry whose `processMatchers` no
// longer match its live command line still reads `running`. `/api/restart` cannot use the port half: it
// seeds its stop with an empty process list on purpose and re-finds the target by pattern alone. So it
// kills nothing, answers `ok:false`, and the restart coordinator files a refused attempt.
//
// That is not hypothetical. GGO's own entry carried four backslash-only matchers while the process ran
// as `node.exe" dist/index.js` — all four missed, 13 restarts were refused across two days, and the
// server sat 11 commits behind with staged builds it could not land. Everything looked green: the hub
// reported it running, health reported the coordinator waiting, and the one line that mentioned the
// refusals guessed "the listener is probably elevated" (it was not).
//
// The matcher class already had FOUR memories when this happened. What it did not have was anything
// that RUNS. This is that: nightly health calls it every sweep, so the next drift is one red line on
// the first night instead of a two-day outage nobody can see.
//
// Read-only: one GET against the hub plus one command-line read. Never restarts or kills anything.

const { execFileSync } = require("node:child_process");

/**
 * Which of a script's `processMatchers` actually match a live command line.
 *
 * Mirrors the hub's own matching: it compiles each pattern with `new RegExp(pattern, 'i')` in
 * `buildScriptStatus`, and its stop sweep uses PowerShell `-match`, which is also case-insensitive.
 * .NET and JS regex differ in corners no registry pattern here uses (character classes, escaped dots
 * and quotes); a pattern exotic enough to diverge would be a bug in the registry entry either way.
 *
 * Pure — this is the half the gate pins.
 */
function matcherReach(matchers, commandLine) {
  const tested = Array.isArray(matchers) ? matchers.filter((m) => typeof m === "string" && m.length) : [];
  if (!tested.length) return { reachable: false, matched: null, tested, reason: "the entry declares no processMatchers" };
  if (typeof commandLine !== "string" || !commandLine.length) {
    return { reachable: false, matched: null, tested, reason: "the live command line could not be read" };
  }
  for (const pattern of tested) {
    let re;
    try {
      re = new RegExp(pattern, "i");
    } catch {
      // An unparseable pattern is dead weight in the registry, not a match. Keep going: a sibling
      // pattern may still cover the process, and the caller reports what actually matched.
      continue;
    }
    if (re.test(commandLine)) return { reachable: true, matched: pattern, tested, reason: `matched by ${pattern}` };
  }
  return {
    reachable: false,
    matched: null,
    tested,
    reason: `none of ${tested.length} processMatcher(s) match the live command line`,
  };
}

/** The command line of a live PID, or null. Windows-only by design — the hub is a Windows deployment. */
function commandLineOf(pid) {
  if (!Number.isFinite(pid) || pid <= 0) return null;
  try {
    const out = execFileSync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CommandLine`],
      { encoding: "utf8", windowsHide: true, timeout: 15_000 },
    );
    const line = String(out).trim();
    return line.length ? line : null;
  } catch {
    return null;
  }
}

/** The registered entry for `hubId`, straight from the hub — so this needs no registry path and no
 *  assumption about where script-hub is checked out. `/api/scripts` carries the CONFIGURED
 *  `status.processMatchers`, unlike `/api/status`, whose `status` is the runtime snapshot. */
async function fetchScriptEntry(hubUrl, hubId) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 5000);
  try {
    const r = await fetch(`${hubUrl}/api/scripts`, { signal: ctrl.signal });
    if (!r.ok) return { error: `hub answered HTTP ${r.status}` };
    const body = await r.json();
    const list = Array.isArray(body) ? body : Array.isArray(body?.scripts) ? body.scripts : [];
    const entry = list.find((s) => s && s.id === hubId);
    return entry ? { entry } : { error: `no script-hub entry with id '${hubId}'` };
  } catch (e) {
    return { error: `hub unreachable: ${e instanceof Error ? e.message : String(e)}` };
  } finally {
    clearTimeout(t);
  }
}

/**
 * Whether the hub could stop the process at `pid`. Resolves to one of:
 *   { state: "reachable", matched, commandLine }
 *   { state: "unreachable", reason, tested, commandLine }   <- the deploy-blocking case
 *   { state: "unknown", reason }                            <- never call this green
 */
async function checkHubStopReach({ hubUrl, hubId, pid } = {}) {
  const url = (hubUrl || process.env.SCRIPT_HUB_URL || "http://127.0.0.1:3939").replace(/\/$/, "");
  const id = hubId || process.env.SCRIPT_HUB_ID || "claude-orchestrator";
  if (!Number.isFinite(pid) || pid <= 0) return { state: "unknown", reason: "no live listener pid to check" };
  const found = await fetchScriptEntry(url, id);
  if (found.error) return { state: "unknown", reason: found.error };
  const commandLine = commandLineOf(pid);
  if (!commandLine) return { state: "unknown", reason: `could not read the command line of pid ${pid}` };
  const reach = matcherReach(found.entry?.status?.processMatchers, commandLine);
  if (reach.reachable) return { state: "reachable", matched: reach.matched, commandLine };
  return { state: "unreachable", reason: reach.reason, tested: reach.tested, commandLine };
}

/** The operator-facing remedy. Says which file to edit and what the process actually looks like,
 *  because "restarts are being refused" on its own sends the next reader to the wrong cause. */
function unreachableRemedy(result, hubId) {
  const id = hubId || process.env.SCRIPT_HUB_ID || "claude-orchestrator";
  return (
    `script-hub cannot STOP this process — ${result.reason}, so \`/api/restart\` kills nothing and ` +
    `answers ok:false while \`/api/status\` still reads it running via portMatchers. Every planned ` +
    `deploy will be refused until this is fixed. Live command line: ${result.commandLine} · tested: ` +
    `${result.tested.join(" | ")}. Fix the '${id}' entry's status.processMatchers in script-hub's ` +
    `registry/scripts.json (readRegistry() reads from disk per call, so no hub restart is needed).`
  );
}

module.exports = { matcherReach, commandLineOf, checkHubStopReach, unreachableRemedy };

if (require.main === module) {
  const pid = Number(process.argv[2]);
  checkHubStopReach({ pid })
    .then((r) => {
      console.log(JSON.stringify(r, null, 2));
      process.exit(r.state === "unreachable" ? 1 : 0);
    })
    .catch((e) => {
      console.error(String(e));
      process.exit(2);
    });
}
