// Gate for the failover-ladder readout in probe-accounts.cjs — the nightly sweep's "backend headroom"
// step. The ladder is Claude subs → Codex → Grok → z.ai, and every rung below the subs lives outside the
// account_usage_* blobs: in kv keys AND in each backend's own usage-cache file. A misread is expensive in
// one direction: reporting a capped, spent or disabled backend as an available rung makes a one-rung ladder
// look healthy, which is the blind spot this readout was added to close — and which has now bitten twice
// (Grok sat cap-latched for days; then Codex and z.ai sat at 100% weekly with no latch to give them away).
// Run: node scripts/failover-ladder.test.cjs

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  backendState,
  claudeHasHeadroom,
  spentWindow,
  spentCredits,
  BACKENDS,
  HARD_LIMIT_PCT,
  MIRRORED_HEADROOM_TERMS,
} = require("./probe-accounts.cjs");

const NOW = Date.parse("2026-07-28T00:00:00.000Z");
const HOUR = 3_600_000;
// A kv stub: absent keys read null, exactly like the real `SELECT value FROM kv` lookup.
const kvOf = (map) => (key) => (key in map ? map[key] : null);
// A meters stub, standing in for reading data/<file>. Absent file ⇒ null, exactly like a missing cache.
const usageOf = (meters) => () => meters ?? null;
const CODEX = { enabledKey: "setting_codex_enabled", capKey: "codex_cap_until", usageFile: "codex-usage-cache.json" };

// --- backendState: enabled + not cap-latched is the ONLY available state ---------------------------
assert.deepEqual(
  backendState(CODEX, kvOf({ setting_codex_enabled: "1", codex_cap_until: "" }), NOW),
  { available: true, reason: "ready", meters: null },
  "enabled with an empty cap latch is a live rung",
);
assert.deepEqual(
  backendState(CODEX, kvOf({ setting_codex_enabled: "1" }), NOW),
  { available: true, reason: "ready", meters: null },
  "enabled with NO cap key ever written is a live rung",
);
assert.deepEqual(
  backendState(CODEX, kvOf({ setting_codex_enabled: "1", codex_cap_until: String(NOW - HOUR) }), NOW),
  { available: true, reason: "ready", meters: null },
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

// --- a SPENT window takes the rung out even with no latch -------------------------------------------
// The second door into the same blind spot: a backend nobody rejected has no cap latch, so a latch-only
// read called an exhausted Codex and z.ai live rungs and reported a 3-rung ladder over a 1-rung reality.
const spent = backendState(CODEX, kvOf({ setting_codex_enabled: "1" }), NOW, usageOf({ fiveHour: 0, sevenDay: 100, sevenDayReset: NOW + 5 * HOUR }));
assert.equal(spent.available, false, "a spent weekly window is not a live rung, latch or no latch");
assert.equal(spent.reason, "spent", "reported apart from 'capped' — a spent window waits for a real reset, not a cooldown");
assert.equal(spent.window, "7d", "names WHICH window is out, so the readout isn't a mystery outage");
assert.equal(spent.pct, 100);
assert.equal(spent.until, NOW + 5 * HOUR, "carries the window reset so the line can count down to it");

assert.equal(
  backendState(CODEX, kvOf({ setting_codex_enabled: "1" }), NOW, usageOf({ fiveHour: 0, sevenDay: 40 })).available,
  true,
  "a metered backend with room stays a rung",
);
assert.equal(
  backendState(CODEX, kvOf({ setting_codex_enabled: "1" }), NOW, usageOf(null)).available,
  true,
  "no usage cache yet ⇒ fall back to the latch-only verdict, never invent a cap",
);
// The latch owns the reset-unknown case and carries the deadline routing waits on, so it outranks meters.
assert.equal(
  backendState(CODEX, kvOf({ setting_codex_enabled: "1", codex_cap_until: String(NOW + HOUR) }), NOW, usageOf({ sevenDay: 100 })).reason,
  "capped",
  "an explicit latch outranks the meters",
);
assert.equal(
  backendState(CODEX, kvOf({ setting_codex_enabled: "0" }), NOW, usageOf({ sevenDay: 100 })).reason,
  "disabled",
  "disabled still outranks everything",
);

// spentWindow: mirrors routing's `>= PROVIDER_HARD_LIMIT` with a reset that hasn't passed.
assert.equal(spentWindow({ fiveHour: 100, fiveHourReset: NOW + HOUR }, NOW).window, "5h", "either window can be the spent one");
assert.equal(spentWindow({ sevenDay: HARD_LIMIT_PCT, sevenDayReset: NOW + HOUR }, NOW)?.window, "7d", "AT the limit is spent (>= check)");
assert.equal(spentWindow({ sevenDay: HARD_LIMIT_PCT - 1, sevenDayReset: NOW + HOUR }, NOW), null, "just under the limit has room");
assert.equal(spentWindow({ sevenDay: 100, sevenDayReset: NOW - HOUR }, NOW), null, "a window whose reset already passed is free again");
assert.equal(spentWindow({ sevenDay: 100 }, NOW)?.pct, 100, "a full window with an UNKNOWN reset is still spent — routing refuses it too");
assert.equal(spentWindow({ sevenDay: null, fiveHour: null }, NOW), null, "an unmetered backend is not 'spent'");
// Grok reports no 5h window at all; a missing meter must not read as 0% room or as spent.
assert.equal(spentWindow({ sevenDay: 20, sevenDayReset: NOW + HOUR }, NOW), null, "Grok's absent 5h meter doesn't fabricate a cap");

// A reset too distant to belong to its window is a backend sentinel, not an outage length. z.ai's quota
// endpoint was seen returning 1799999999000 (Jan 2027) as a 5-HOUR window's nextResetTime, which rendered
// as "resets in 169d" — a number a reader would act on. The verdict must not move (routing reads the same
// meters and refuses the rung either way); only the countdown is withheld, with the raw value kept so the
// line can say where it came from.
const sentinel = spentWindow({ fiveHour: 100, fiveHourReset: Date.parse("2027-01-15T07:59:59.000Z") }, NOW);
assert.equal(sentinel.window, "5h", "an implausible reset does not un-spend the window");
assert.equal(sentinel.reset, null, "no countdown is printed for a reset that can't be this window's");
assert.equal(sentinel.reportedReset, Date.parse("2027-01-15T07:59:59.000Z"), "keeps the raw value so the readout can name it");
assert.equal(
  spentWindow({ fiveHour: 100, fiveHourReset: NOW + 9 * HOUR }, NOW).reset,
  NOW + 9 * HOUR,
  "a late-but-believable 5h reset (under 2× the window) still counts down — the clamp must not eat real outages",
);
assert.equal(
  spentWindow({ sevenDay: 100, sevenDayReset: NOW + 6 * 24 * HOUR }, NOW).reset,
  NOW + 6 * 24 * HOUR,
  "the bound scales with the window: 6 days is nonsense for 5h but ordinary for a weekly",
);
assert.equal(
  backendState(CODEX, kvOf({ setting_codex_enabled: "1" }), NOW, usageOf({ sevenDay: 100, sevenDayReset: NOW + 400 * 24 * HOUR })).until,
  null,
  "backendState passes the withheld reset through as unknown, so the ladder line can't print a fake countdown",
);

// --- Grok's monthly credit pool is a third exhaustion door ------------------------------------------
// Routing refuses Grok on three conditions, not two (grokProviderCandidate): the cap latch, the weekly
// window, and the SuperGrok plan's MONTHLY credit pool. Credits run out while the weekly still reads
// room, so a windows-only read prints "available" for a rung routing will not send work to — the same
// overstated-depth blind spot as the un-latched spent window, through the one door left open.
const GROK = { enabledKey: "setting_grok_enabled", capKey: "grok_cap_until", usageFile: "grok-usage-cache.json" };
const noCredits = backendState(
  GROK,
  kvOf({ setting_grok_enabled: "1" }),
  NOW,
  usageOf({ sevenDay: 40, sevenDayReset: NOW + 3 * 24 * HOUR, monthlyUsed: 15000, monthlyLimit: 15000, monthlyReset: NOW + 5 * 24 * HOUR }),
);
assert.equal(noCredits.available, false, "a spent monthly credit pool is not a live rung, even with weekly room");
assert.equal(noCredits.reason, "spent", "reported like any other spent meter — it waits for a real reset, not a cooldown");
assert.equal(noCredits.window, "monthly credits", "names the pool, so the line isn't read as a weekly outage");
assert.equal(noCredits.pct, 100);
assert.equal(noCredits.until, NOW + 5 * 24 * HOUR, "carries the billing-period end so the line can count down");

assert.equal(spentCredits({ monthlyUsed: 9231, monthlyLimit: 15000, monthlyReset: NOW + HOUR }, NOW), null, "credits left is not spent");
assert.equal(spentCredits({ monthlyUsed: 15001, monthlyLimit: 15000 }, NOW)?.pct, 100, "over the cap with an unknown reset is still spent");
assert.equal(
  spentCredits({ monthlyUsed: 15000, monthlyLimit: 15000, monthlyReset: NOW - HOUR }, NOW),
  null,
  "a billing period that already ended has refilled — mirrors routing's `monthlyReset > now` guard",
);
assert.equal(spentCredits({ sevenDay: 100 }, NOW), null, "a backend that meters no credits at all never reads as credit-spent");
assert.equal(spentCredits({ monthlyUsed: 5, monthlyLimit: 0 }, NOW), null, "a zero/absent limit is no information, not a full pool");
assert.equal(
  spentCredits({ monthlyUsed: 15000, monthlyLimit: 15000, monthlyReset: Date.parse("2027-06-01T00:00:00.000Z") }, NOW).reset,
  null,
  "a reset too far out to be a billing period is withheld from the countdown, like the window sentinel",
);
// The weekly window still wins the report when both are out — it is the one that resets sooner.
assert.equal(
  backendState(GROK, kvOf({ setting_grok_enabled: "1" }), NOW, usageOf({ sevenDay: 100, sevenDayReset: NOW + HOUR, monthlyUsed: 15000, monthlyLimit: 15000 })).window,
  "7d",
  "a spent window outranks spent credits in the readout",
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

// --- the usage-cache file names must still match the modules that WRITE them ------------------------
// Same drift guard as the kv keys above, for the same reason: the probe opens these files by literal name,
// so a rename in agents/<x>Usage.ts would leave it reading a file nobody writes — silently back to the
// latch-only view that reported a 3-rung ladder over a 1-rung reality.
const usageModules = { Codex: "codexUsage.ts", Grok: "grokUsage.ts", "z.ai": "zaiUsage.ts" };
for (const b of BACKENDS) {
  assert.ok(b.usageFile, `BACKENDS entry '${b.name}' has no usageFile — its windows would be invisible to the ladder`);
  const mod = usageModules[b.name];
  assert.ok(mod, `no usage module mapped for backend '${b.name}'`);
  const src = fs.readFileSync(path.resolve(__dirname, "..", "src", "agents", mod), "utf8");
  assert.ok(
    src.includes(`"${b.usageFile}"`),
    `probe reads meters from '${b.usageFile}', which agents/${mod} no longer writes`,
  );
  assert.ok(src.includes("writeFileSync"), `agents/${mod} must persist its reading, or the ladder has no meters to read`);
}

// --- the ladder must mirror EVERY door routing gates a backend on ------------------------------------
// The load-bearing structural check. Everything above verifies the doors this readout already knows
// about; this one is about the door it does NOT. The ladder re-implements `hasHeadroom` by hand, and an
// unmirrored term fails silently and in the flattering direction — the rung keeps printing "available",
// so the sweep reports more failover depth than exists. Three separate shipped instances (08d743b,
// 707cc13, a523668) were each found by reading the two sources side by side, months apart. So: parse the
// real `hasHeadroom` expressions out of threadManager.ts and require the probe to have declared each
// term, with the mirror that implements it. Adding a door on the routing side now fails this gate the
// same day, instead of quietly inflating the number the sweep is supposed to act on.
{
  const tmSrc = fs.readFileSync(path.resolve(__dirname, "..", "src", "orchestrator", "threadManager.ts"), "utf8");
  // Not identifiers of the decision — the receiver, the usage local, and literals. Everything else in a
  // hasHeadroom expression is a door: a guard call (`grokCapActive`) or a predicate local (`nearWeekly`).
  const NOISE = new Set(["this", "u", "null", "undefined", "true", "false"]);

  /** The identifiers a candidate's `hasHeadroom` actually gates on, read from the source of truth.
   *  `\r?\n` because a clone with `core.autocrlf=true` checks the source out CRLF, and a bare `\n`
   *  then matches nothing, so the gate fails on the checkout instead of on the code. */
  function headroomTerms(method) {
    const body = new RegExp(`private ${method}\\(\\)[\\s\\S]*?hasHeadroom:([\\s\\S]*?),\\r?\\n\\s*[a-zA-Z]\\w*:`).exec(tmSrc);
    assert.ok(body, `no ${method}() with a hasHeadroom property in threadManager.ts — the ladder mirrors a method that moved`);
    const expr = body[1]
      .replace(/this\./g, "") // `this.grokCapActive()` → `grokCapActive()`: the guard IS the term
      .replace(/\??\.\w+/g, ""); // `u?.fiveHour` → `u`: a field read is not a door, the predicate around it is
    return new Set((expr.match(/[A-Za-z_$][\w$]*/g) ?? []).filter((id) => !NOISE.has(id)));
  }

  for (const [method, mirrors] of Object.entries(MIRRORED_HEADROOM_TERMS)) {
    const live = headroomTerms(method);
    for (const term of live) {
      assert.ok(
        term in mirrors,
        `${method} gates headroom on '${term}', which probe-accounts.cjs does not mirror — the ladder would ` +
          `keep reporting this backend as an available rung while routing refuses it. Implement the check, ` +
          `then declare it in MIRRORED_HEADROOM_TERMS.`,
      );
    }
    for (const term of Object.keys(mirrors)) {
      assert.ok(
        live.has(term),
        `probe-accounts.cjs claims to mirror '${term}' for ${method}, but routing no longer gates on it — ` +
          `a stale mirror hides the next real change. Re-read the method and correct the map.`,
      );
    }
  }
  // The map is only a guard while it covers every backend the ladder reports on.
  assert.equal(
    Object.keys(MIRRORED_HEADROOM_TERMS).length,
    BACKENDS.length,
    "every BACKENDS rung needs its *ProviderCandidate mirrored in MIRRORED_HEADROOM_TERMS, or its doors go unchecked",
  );
}

console.log("failoverLadder: all assertions passed");
