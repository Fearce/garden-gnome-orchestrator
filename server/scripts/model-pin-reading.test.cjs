const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Database = require("better-sqlite3");
const { modelPinReading, parseProbeArgs } = require("./model-pin-reading.cjs");

const SPARK = "gpt-5.3-codex-spark";
const SOL = "gpt-5.6-sol";
const request = { requested: "spark", provider: "codex", model: SPARK, strict: true };
const run = (model, account = `codex:${model}`, startedAt = 1, role = "implementor") => ({
  role,
  model,
  account,
  state: "running",
  started_at: startedAt,
});

let passed = 0;
function check(name, fn) {
  fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

console.log("\n=== strict model-pin probe reading ===\n");

check("matching persisted intent, provider, and latest run pass", () => {
  const reading = modelPinReading({ modelRequest: request, runs: [run(SPARK)], expectedModel: SPARK });
  assert.equal(reading.ok, true);
  assert.equal(reading.actualProvider, "codex");
});

check("the latest implementor row wins over a stale wrong-model session", () => {
  const reading = modelPinReading({ modelRequest: request, runs: [run(SPARK, undefined, 20), run(SOL, undefined, 10)] });
  assert.equal(reading.ok, true);
  assert.equal(reading.actualModel, SPARK);
});

check("non-implementor rows cannot satisfy the runtime check", () => {
  const reading = modelPinReading({ modelRequest: request, runs: [run(SPARK, undefined, 10, "qa")] });
  assert.equal(reading.ok, false);
  assert.match(reading.errors.join("\n"), /no implementor agent_run/);
});

for (const [name, modelRequest, runs, pattern] of [
  ["a missing request fails closed", null, [run(SPARK)], /no persisted model request/],
  ["a malformed request fails closed", { invalid: "{" }, [run(SPARK)], /malformed/],
  ["a non-strict request fails closed", { ...request, strict: false }, [run(SPARK)], /not strict/],
  ["an unresolved request fails closed", { requested: "spark", provider: "codex", strict: true }, [run(SPARK)], /no resolved canonical model/],
  ["a wrong runtime model fails closed", request, [run(SOL)], /latest implementor model is gpt-5\.6-sol, requested/],
  ["a wrong runtime provider fails closed", request, [run(SPARK, "personal")], /provider is claude, requested codex/],
]) {
  check(name, () => {
    const reading = modelPinReading({ modelRequest, runs });
    assert.equal(reading.ok, false);
    assert.match(reading.errors.join("\n"), pattern);
  });
}

check("an explicit expected model checks both persistence and runtime", () => {
  const reading = modelPinReading({ modelRequest: request, runs: [run(SPARK)], expectedModel: SOL });
  assert.equal(reading.ok, false);
  assert.match(reading.errors.join("\n"), /persisted requested model .* expected gpt-5\.6-sol/);
  assert.match(reading.errors.join("\n"), /latest implementor model .* expected gpt-5\.6-sol/);
});

check("CLI parsing keeps multi-word title lookup and enables verification", () => {
  assert.deepEqual(
    parseProbeArgs(["overnight", "Bobfish", "--prompt", "--verify-model-pin", "--expect-model", SPARK]),
    {
      query: "overnight Bobfish",
      showPrompt: true,
      verifyModelPin: true,
      expectedModel: SPARK,
    },
  );
});

check("--expect-model implies verification", () => {
  assert.equal(parseProbeArgs(["5279e6ec", "--expect-model", SPARK]).verifyModelPin, true);
});

check("unknown and incomplete options are usage errors", () => {
  assert.throws(() => parseProbeArgs(["5279e6ec", "--bogus"]), /unknown option/);
  assert.throws(() => parseProbeArgs(["5279e6ec", "--expect-model"]), /requires a canonical model id/);
  assert.throws(() => parseProbeArgs(["--prompt"]), /thread id or title substring/);
});

check("the read-only CLI exits green on a match and red on a real runtime mismatch", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "model-pin-probe-"));
  const dbPath = path.join(dir, "orchestrator.sqlite");
  const script = path.join(__dirname, "probe-model-pin.cjs");
  try {
    const db = new Database(dbPath);
    db.exec(`
      CREATE TABLE threads (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        state TEXT NOT NULL,
        model_request TEXT,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE agent_runs (
        thread_id TEXT NOT NULL,
        role TEXT NOT NULL,
        model TEXT NOT NULL,
        account TEXT,
        state TEXT NOT NULL,
        started_at INTEGER NOT NULL
      );
    `);
    db.prepare("INSERT INTO threads VALUES (?, ?, ?, ?, ?)").run(
      "task-1",
      "Synthetic Spark task",
      "implementing",
      JSON.stringify(request),
      1,
    );
    db.prepare("INSERT INTO agent_runs VALUES (?, ?, ?, ?, ?, ?)").run(
      "task-1",
      "implementor",
      SPARK,
      `codex:${SPARK}`,
      "running",
      2,
    );
    db.close();

    const invoke = () => spawnSync(process.execPath, [script, "task-1", "--expect-model", SPARK], {
      encoding: "utf8",
      env: { ...process.env, ORCH_DB: dbPath },
    });
    const green = invoke();
    assert.equal(green.status, 0, green.stderr || green.stdout);
    assert.match(green.stdout, /strict model pin: PASS/);

    const changed = new Database(dbPath);
    changed.prepare("UPDATE agent_runs SET model = ?, account = ?").run(SOL, `codex:${SOL}`);
    changed.close();
    const red = invoke();
    assert.equal(red.status, 1, red.stderr || red.stdout);
    assert.match(red.stdout, /strict model pin: FAIL/);
    assert.match(red.stdout, /latest implementor model is gpt-5\.6-sol, requested/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

console.log(`\n${passed} passed, 0 failed`);
