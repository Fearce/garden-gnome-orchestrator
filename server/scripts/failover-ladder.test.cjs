// Gate for the failover-ladder readout in probe-accounts.cjs — the nightly sweep's "backend headroom"
// step. The ladder is Claude subs → Codex → Grok → z.ai, and every rung below the subs lives in kv keys
// the account_usage_* blobs know nothing about. A misread is expensive in one direction: reporting a
// CAPPED or disabled backend as an available rung makes a one-rung ladder look healthy, which is exactly
// the blind spot this readout was added to close (Grok sat cap-latched for days, invisible to the sweep).
// Run: node scripts/failover-ladder.test.cjs

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { backendState, claudeHasHeadroom, BACKENDS, HARD_LIMIT_PCT } = require("./probe-accounts.cjs");

const NOW = Date.parse("2026-07-28T00:00:00.000Z");
const HOUR = 3_600_000;
// A kv stub: absent keys read null, exactly like the real `SELECT value FROM kv` lookup.
const kvOf = (map) => (key) => (key in map ? map[key] : null);
const CODEX = { enabledKey: "setting_codex_enabled", capKey: "codex_cap_until" };

// --- backendState: enabled + not cap-latched is the ONLY available state ---------------------------
assert.deepEqual(
  backendState(CODEX, kvOf({ setting_codex_enabled: "1", codex_cap_until: "" }), NOW),
  { available: true, reason: "ready" },
  "enabled with an empty cap latch is a live rung",
);
assert.deepEqual(
  backendState(CODEX, kvOf({ setting_codex_enabled: "1" }), NOW),
  { available: true, reason: "ready" },
  "enabled with NO cap key ever written is a live rung",
);
assert.deepEqual(
  backendState(CODEX, kvOf({ setting_codex_enabled: "1", codex_cap_until: String(NOW - HOUR) }), NOW),
  { available: true, reason: "ready" },
  "a lapsed latch frees the rung (threadManager clears it on boot; we must not out-live that)",
);

const capped = backendState(CODEX, kvOf({ setting_codex_enabled: "1", codex_cap_until: String(NOW + 5 * HOUR) }), NOW);
assert.equal(capped.available, false, "a future cap latch takes the rung out of the ladder");
assert.equal(capped.reason, "capped");
assert.equal(capped.until, NOW + 5 * HOUR, "carries the epoch so the readout can count down to the reset");

// Disabled outranks everything — an off backend is not a rung even with no cap latch, and a backend
// left disabled WITH a stale future latch must still read "disabled", never "available".
assert.equal(backendState(CODEX, kvOf({ setting_codex_enabled: "0" }), NOW).reason, "disabled", "'0' is off");
assert.equal(backendState(CODEX, kvOf({}), NOW).reason, "disabled", "an unset flag defaults to off");
assert.equal(
  backendState(CODEX, kvOf({ setting_codex_enabled: "", codex_cap_until: "" }), NOW).reason,
  "disabled",
  "only the literal '1' enables a backend (settingBool semantics)",
);
assert.equal(
  backendState(CODEX, kvOf({ setting_codex_enabled: "0", codex_cap_until: String(NOW + HOUR) }), NOW).reason,
  "disabled",
  "disabled wins over a cap latch — never reported as an available rung",
);
// A garbage latch must not silently park a healthy backend out of the ladder.
assert.equal(
  backendState(CODEX, kvOf({ setting_codex_enabled: "1", codex_cap_until: "not-a-number" }), NOW).reason,
  "ready",
  "an unparseable latch is treated as no latch, not as a permanent cap",
);

// --- claudeHasHeadroom: BOTH windows gate the rung --------------------------------------------------
assert.equal(claudeHasHeadroom({ fiveHour: 43, sevenDay: 32 }), true, "both windows under the limit");
assert.equal(claudeHasHeadroom({}), true, "a sub with no usage read yet is assumed free");
// The real case that motivated this: a sub showing 5h 0% but 99% weekly looks idle and cannot take work.
assert.equal(claudeHasHeadroom({ fiveHour: 0, sevenDay: 99 }), false, "an exhausted WEEKLY window is not a rung");
assert.equal(claudeHasHeadroom({ fiveHour: 99, sevenDay: 10 }), false, "an exhausted 5h window is not a rung");
assert.equal(
  claudeHasHeadroom({ fiveHour: 0, sevenDay: HARD_LIMIT_PCT }),
  false,
  "AT the hard limit is not headroom (mirrors PROVIDER_HARD_LIMIT's >= check)",
);
assert.equal(claudeHasHeadroom({ fiveHour: 0, sevenDay: HARD_LIMIT_PCT - 1 }), true, "just under the limit is a rung");

// --- the kv key names must still match threadManager.ts ---------------------------------------------
// This is the load-bearing check. The probe reads these keys by literal name, so a rename on the server
// side would leave it reading a key nobody writes — reporting every backend "available" forever, silently.
const tm = fs.readFileSync(path.resolve(__dirname, "..", "src", "orchestrator", "threadManager.ts"), "utf8");
const capKeys = [...tm.matchAll(/_CAP_KV_KEY = "([a-z_]+)"/g)].map((m) => m[1]);
assert.equal(capKeys.length, 3, `expected 3 *_CAP_KV_KEY constants in threadManager.ts, found ${capKeys.length}`);
for (const key of capKeys) {
  assert.ok(
    BACKENDS.some((b) => b.capKey === key),
    `threadManager writes cap latch '${key}' but no BACKENDS entry reads it — the ladder readout would miss it`,
  );
}
for (const b of BACKENDS) {
  assert.ok(capKeys.includes(b.capKey), `BACKENDS reads cap key '${b.capKey}', which threadManager.ts no longer writes`);
  assert.ok(
    tm.includes(`this.settingBool("${b.enabledKey}"`),
    `BACKENDS reads enabled flag '${b.enabledKey}', which threadManager.ts no longer writes`,
  );
}

console.log("failoverLadder: all assertions passed");
