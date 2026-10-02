// Lab for what a restart does to every kind of in-flight task (`npm run restart-resume-lab`). The unit
// gate (`test:restart-revival`) drives markInterrupted inside one process with a stubbed pipeline; this
// boots a REAL throwaway instance, seeds tasks in each state a restart can catch, kills the process the
// way a crash or deploy bounce does, boots it again, and reads what the new process did to them: the
// waiting ones keep their controls, the working ones are actually auto-resumed, and an answer to a
// question the dead process left open resumes its task.
//
// Every provider is pointed at nothing (bogus Claude token, empty Codex/Grok homes, no z.ai key), so a
// resumed agent fails at auth without spending anything; a resume that FIRED is what is being proven.
// Not in GATES: it boots an instance, like the other labs.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { randomUUID } = require("node:crypto");
const WebSocket = require("ws");
const { SERVER_ROOT, authPassword, requireBuild, boot, killInstance, createChecks } = require("./lab-harness.cjs");
const Database = require(path.join(SERVER_ROOT, "node_modules", "better-sqlite3"));

const PORT = 4397;
const check = createChecks();
const AUTO_RESUMING = "interrupted by a server restart — auto-resuming…";
const AWAITING_ANSWER = "interrupted by a server restart while it was waiting for your answer";
const ANSWER = "Use the blue palette.";

const TASKS = {
  paused: { id: randomUUID(), title: "lab: paused at a Proceed gate", state: "paused" },
  asking: { id: randomUUID(), title: "lab: waiting on an ask_user answer", state: "awaiting_user" },
  approval: { id: randomUUID(), title: "lab: waiting for plan approval", state: "awaiting_approval" },
  intake: { id: randomUUID(), title: "lab: dispatched but never queued", state: "intake" },
  working: { id: randomUUID(), title: "lab: implementing", state: "implementing" },
};
const QUESTION_ID = randomUUID();

function isolatedProviders(scratch) {
  const empty = (name) => {
    const dir = path.join(scratch, name);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  };
  return {
    CODEX_HOME_DIR: empty("codex-home"),
    GROK_HOME_DIR: empty("grok-home"),
    GROK_BIN: path.join(scratch, "no-grok.exe"),
    ZAI_API_KEY: "",
    ANTHROPIC_API_KEY: "",
  };
}

function gitWorkspace(dir) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "README.md"), "restart-resume lab workspace\n");
  const git = (...args) => execFileSync("git", ["-C", dir, ...args], { stdio: "ignore", windowsHide: true });
  git("init", "-q", "-b", "master");
  git("add", "README.md");
  git("-c", "user.name=lab", "-c", "user.email=lab@example.invalid", "commit", "-q", "-m", "init");
}

/** What the dead process left behind, written the way the server writes it. */
function seed(dbPath, workspace) {
  const db = new Database(dbPath);
  const now = Date.now() - 120_000;
  const thread = db.prepare(
    `INSERT INTO threads(id, title, state, workspace, home_workspace, brief, raw_prompt, stage_outputs, latest_message_preview, created_at, updated_at)
     VALUES(?, ?, ?, ?, ?, 'lab brief', 'lab prompt', ?, '', ?, ?)`,
  );
  const stages = {
    paused: { kickoff: "lab kickoff", planDone: true, approved: true },
    asking: { kickoff: "lab kickoff", planDone: true, approved: true },
    approval: { kickoff: "lab kickoff", planDone: true, plan: { summary: "lab plan", steps: [{ title: "one", detail: "one" }], risks: [], openQuestions: [] } },
    intake: null,
    working: { kickoff: "lab kickoff", planDone: true, approved: true },
  };
  // Plan approval on, so the approval task's resume has to raise its gate again rather than run past it.
  db.prepare("INSERT OR REPLACE INTO kv(key, value) VALUES('require_plan_approval', '1')").run();
  for (const [key, t] of Object.entries(TASKS)) {
    thread.run(t.id, t.title, t.state, workspace, workspace, stages[key] ? JSON.stringify(stages[key]) : null, now, now);
  }
  const run = db.prepare(
    `INSERT INTO agent_runs(id, thread_id, role, model, account, session_id, state, started_at) VALUES(?, ?, 'implementor', 'claude-opus-5-5', 'lab', ?, 'running', ?)`,
  );
  const askingRun = randomUUID();
  run.run(askingRun, TASKS.asking.id, "lab-session-asking", now);
  run.run(randomUUID(), TASKS.working.id, "lab-session-working", now);
  db.prepare(
    `INSERT INTO questions(id, thread_id, run_id, header, question, options, multi_select, created_at) VALUES(?, ?, ?, 'Palette', 'Which palette should the header use?', '[]', 0, ?)`,
  ).run(QUESTION_ID, TASKS.asking.id, askingRun, now);
  db.close();
}

function read(dbPath) {
  const db = new Database(dbPath, { readonly: true });
  const threads = Object.fromEntries(Object.entries(TASKS).map(([k, t]) => [k, db.prepare("SELECT state, error FROM threads WHERE id = ?").get(t.id)]));
  const question = db.prepare("SELECT answer FROM questions WHERE id = ?").get(QUESTION_ID);
  const runsSince = (id, at) => db.prepare("SELECT COUNT(*) AS n FROM agent_runs WHERE thread_id = ? AND started_at >= ?").get(id, at).n;
  const messages = (id) => db.prepare("SELECT content FROM messages WHERE thread_id = ? ORDER BY created_at").all(id).map((m) => m.content);
  const out = { threads, question, runsSince, messages, close: () => db.close() };
  return out;
}

async function waitFor(fn, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = fn();
    if (value) return value;
    if (Date.now() > deadline) {
      console.log(`  (gave up waiting for ${label})`);
      return value;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
}

async function answerOverSocket(questionId, answer) {
  const res = await fetch(`http://127.0.0.1:${PORT}/api/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password: authPassword() }),
  });
  if (!res.ok) throw new Error(`login failed: ${res.status}`);
  const cookie = res.headers.getSetCookie().map((v) => v.split(";", 1)[0]).join("; ");
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`, { headers: { cookie } });
  await new Promise((resolve, reject) => {
    ws.on("message", (raw) => {
      if (JSON.parse(String(raw)).type === "hello") resolve();
    });
    ws.on("error", reject);
  });
  ws.send(JSON.stringify({ type: "question.answer", questionId, answer }));
  await new Promise((r) => setTimeout(r, 1000));
  ws.close();
}

function reconcileLine(dataDir) {
  const log = path.join(dataDir, "crash.log");
  if (!fs.existsSync(log)) return "";
  return fs.readFileSync(log, "utf8").split(/\r?\n/).filter((l) => l.includes("restart reconcile —")).pop() ?? "";
}

async function main() {
  requireBuild();
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "ggo-restart-lab-"));
  const dataDir = path.join(scratch, "data");
  const workspace = path.join(scratch, "workspace");
  fs.mkdirSync(dataDir);
  gitWorkspace(workspace);
  const env = isolatedProviders(scratch);
  const dbPath = path.join(dataDir, "orchestrator.sqlite");
  killInstance(PORT);
  console.log(`lab data: ${dataDir}`);
  let child = null;
  try {
    // The first boot only lays down the schema; seeding a running instance would not be seen.
    child = await boot({ dataDir, port: PORT, env });
    child.kill();
    killInstance(PORT);
    await new Promise((r) => setTimeout(r, 1500));
    seed(dbPath, workspace);

    console.log("\nThe restart: a fresh process boots over the dead one's work");
    const bootedAt = Date.now();
    child = await boot({ dataDir, port: PORT, env });
    let s = read(dbPath);
    check("a task paused at a Proceed gate is still paused", s.threads.paused.state === "paused", JSON.stringify(s.threads.paused));
    check(
      "the ask_user task is held for its answer, not handed a generic click-Resume",
      s.threads.asking.state === "failed" && (s.threads.asking.error ?? "").startsWith(AWAITING_ANSWER),
      JSON.stringify(s.threads.asking),
    );
    check("…its question is still open", s.question && s.question.answer == null, JSON.stringify(s.question));
    check("…and its history says why it is waiting", s.messages(TASKS.asking.id).some((m) => m.includes("answering it resumes the task")));
    const line = reconcileLine(dataDir);
    check("the boot's reconcile line counts what it kept, held and re-queued", /kept=1/.test(line) && /awaitingAnswer=1/.test(line) && /requeued=1/.test(line), line);
    s.close();

    console.log("\nThe working tasks are actually resumed, not just promised");
    const fired = (key) => {
      const r = read(dbPath);
      const t = r.threads[key];
      const started = r.runsSince(TASKS[key].id, bootedAt) > 0;
      r.close();
      return started && t.error !== AUTO_RESUMING ? t : null;
    };
    const reAsked = await waitFor(
      () => {
        const t = read(dbPath).threads.approval;
        return t.state === "awaiting_approval" && !t.error;
      },
      60_000,
      "the approval gate to be raised again",
    );
    check("the awaiting_approval task is resumed and asks for approval again", reAsked, JSON.stringify(read(dbPath).threads.approval));
    const working = await waitFor(() => fired("working"), 60_000, "the implementing task to start");
    check("the implementing task started an agent after the restart", !!working, JSON.stringify(read(dbPath).threads.working));
    // Re-queued, it runs the normal pipeline from the top: it gets as far as an agent or its own gate.
    const entered = await waitFor(
      () => {
        const t = read(dbPath).threads.intake;
        return !["intake", "queued", "failed"].includes(t.state) || fired("intake");
      },
      60_000,
      "the intake task to enter its pipeline",
    );
    check("the intake task was re-queued and entered its pipeline", entered, JSON.stringify(read(dbPath).threads.intake));
    s = read(dbPath);
    check("the paused task was not started", s.runsSince(TASKS.paused.id, bootedAt) === 0);
    check("the ask_user task was not started before its answer", s.runsSince(TASKS.asking.id, bootedAt) === 0);
    s.close();

    console.log("\nAnswering the question the dead process left open resumes the task");
    const answeredAt = Date.now();
    await answerOverSocket(QUESTION_ID, ANSWER);
    const resumed = await waitFor(
      () => {
        const r = read(dbPath);
        const ok = r.runsSince(TASKS.asking.id, answeredAt) > 0;
        r.close();
        return ok;
      },
      60_000,
      "the answered task to start",
    );
    s = read(dbPath);
    check("the answer started an agent on the asking task", resumed, JSON.stringify(s.threads.asking));
    check("…the question is closed with the owner's answer", s.question?.answer === ANSWER, JSON.stringify(s.question));
    check("…and the task no longer claims to be waiting for it", !(s.threads.asking.error ?? "").startsWith(AWAITING_ANSWER), JSON.stringify(s.threads.asking));
    s.close();
  } finally {
    child?.kill();
    killInstance(PORT);
  }
  process.exit(check.summary());
}

main().catch((e) => {
  console.error(e);
  killInstance(PORT);
  process.exit(1);
});
