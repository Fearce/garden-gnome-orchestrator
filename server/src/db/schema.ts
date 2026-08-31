// SQLite schema, inlined so it survives the tsc build with no copy step.

export const SCHEMA = /* sql */ `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS threads (
  id            TEXT PRIMARY KEY,
  title         TEXT NOT NULL,
  state         TEXT NOT NULL,
  workspace     TEXT NOT NULL,
  brief         TEXT NOT NULL DEFAULT '',
  raw_prompt    TEXT NOT NULL DEFAULT '',
  error         TEXT,
  effort_override TEXT,
  stage_outputs TEXT,
  closed_at         INTEGER,
  closed_prev_state TEXT,
  -- Dispatch lane. NULL = the normal task-aware implementation route (planner/QA optional); 'read' = the cheap single-agent
  -- read-only reader lane (dispatch_read) — one Sonnet reader that answers a lookup and escalates
  -- rather than half-answering, no QA. Drives the card's READ badge and runPipeline's short-circuit.
  lane          TEXT,
  -- HEAD sha of the task's repo captured at dispatch — the "before" point for scoping the Changes
  -- chip to THIS task's own diff (baseline_head..HEAD + the task's written files), excluding foreign WIP.
  baseline_head TEXT,
  -- TIMED task: the wall-clock work window. duration_ms is what the owner ASKED for (kept so the UI can
  -- still say "an 8h task" after the fact); deadline_at is the absolute instant it closes, which is what
  -- is actually enforced. Absolute rather than derived, so a restart, a provider hand-off or a cap park
  -- resumes the SAME clock instead of restarting the window. NULL on an ordinary task.
  duration_ms   INTEGER,
  deadline_at   INTEGER,
  -- Operator-appointed HARD stop for an existing task. Separate from the timed-task work window above:
  -- this deadline stops a busy agent at the instant, parks the task, and blocks automatic resurrection.
  active_deadline_at INTEGER,
  -- SHOTGUN task: how many agents the owner asked to work this objective at once. NULL/1 = ordinary.
  -- Kept even after the split is decided so the card can show what was requested vs. what ran.
  agent_count   INTEGER,
  -- Set on a COLLABORATOR thread: the lead task it belongs to. No FK on purpose — the lead may be purged
  -- while a collaborator is still being read, and a dangling parent just means the UI shows it standalone
  -- (the same reasoning as director_messages.thread_id). Collaborators are hidden from the main board and
  -- rendered inside the lead's detail panel instead.
  parent_id     TEXT,
  -- A collaborator's owned share, as JSON ({title, objective, files[]}). The file list is the OWNERSHIP
  -- CONTRACT that keeps parallel agents from overwriting each other in the one shared working tree, so it
  -- is persisted rather than held in memory: a resumed collaborator must be handed the same share.
  assignment    TEXT,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS agent_runs (
  id          TEXT PRIMARY KEY,
  thread_id   TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  role        TEXT NOT NULL,
  model       TEXT NOT NULL,
  account     TEXT,
  effort      TEXT,
  session_id  TEXT,
  state       TEXT NOT NULL,
  cost_usd    REAL,
  num_turns   INTEGER,
  input_tokens INTEGER,
  output_tokens INTEGER,
  cache_read_input_tokens INTEGER,
  cache_creation_input_tokens INTEGER,
  reasoning_output_tokens INTEGER,
  total_tokens INTEGER,
  error       TEXT,
  cap_flagged INTEGER,
  started_at  INTEGER NOT NULL,
  ended_at    INTEGER
);

CREATE TABLE IF NOT EXISTS findings (
  id          TEXT PRIMARY KEY,
  thread_id   TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  from_run_id TEXT,
  from_role   TEXT,
  kind        TEXT NOT NULL DEFAULT 'finding',
  summary     TEXT NOT NULL,
  detail      TEXT,
  path        TEXT,
  label       TEXT,
  severity    TEXT NOT NULL DEFAULT 'note',
  routed      INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS questions (
  id           TEXT PRIMARY KEY,
  thread_id    TEXT,
  run_id       TEXT,
  header       TEXT NOT NULL,
  question     TEXT NOT NULL,
  options      TEXT NOT NULL DEFAULT '[]',
  multi_select INTEGER NOT NULL DEFAULT 0,
  answer       TEXT,
  answered_at  INTEGER,
  created_at   INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS messages (
  id          TEXT PRIMARY KEY,
  thread_id   TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  run_id      TEXT,
  role        TEXT NOT NULL,
  kind        TEXT NOT NULL,
  content     TEXT NOT NULL,
  attachments TEXT NOT NULL DEFAULT '[]',
  created_at  INTEGER NOT NULL
);

-- Substring index over messages.content, so the console's search stops being a full table scan of
-- ~105 MB of tool output. Trigram is the only tokenizer that can serve the LIKE '%q%' semantics the
-- search has always had — a word tokenizer measured 3.5x smaller but silently lost results ("shake"
-- found 19 of the 479 messages containing it). contentless (content='') keeps only the index, adding
-- no second copy of the text; detail=none drops the position lists, which is the difference between
-- 1.35x and 3.57x the size of the indexed text for identical answers.
--
-- contentless_delete is load-bearing, not a tuning knob: it makes "delete rowid N" a tombstone rather
-- than a subtraction of N's tokens, so removing a row the backfill has not reached yet is harmless.
-- The external-content form would corrupt the index in exactly that window. Deletes are therefore
-- safe from the first boot, which is why this trigger ships here while the two that ADD rows are
-- installed only once the backfill is complete (searchIndex.ts) — an insert during the backfill
-- would race the walk and double-index the row. (columnsize=0 would shrink it further but SQLite
-- refuses it alongside contentless_delete.)
CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
  content, content='', contentless_delete=1, tokenize='trigram', detail='none'
);

-- Fires for the thread-purge path too: a FK ON DELETE CASCADE does run delete triggers on the child.
CREATE TRIGGER IF NOT EXISTS messages_fts_ad AFTER DELETE ON messages BEGIN
  DELETE FROM messages_fts WHERE rowid = old.rowid;
END;

-- thread_id links a message's conversation turn to the task it dispatched (for the search's "go to
-- task" jump). Nullable, and deliberately NO FK: the director conversation is durable, so a message
-- survives its task's purge — a dangling link just means the UI hides the jump.
CREATE TABLE IF NOT EXISTS director_messages (
  id          TEXT PRIMARY KEY,
  role        TEXT NOT NULL,
  kind        TEXT NOT NULL,
  content     TEXT NOT NULL,
  attachments TEXT NOT NULL DEFAULT '[]',
  thread_id   TEXT,
  created_at  INTEGER NOT NULL
);

-- sha256 of the data column, so the same bytes are stored once however many messages reference them: an
-- image dropped into the director is attached to BOTH the director message and the dispatched task's.
CREATE TABLE IF NOT EXISTS attachments (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  media_type  TEXT NOT NULL,
  data        TEXT NOT NULL,
  sha256      TEXT,
  created_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS kv (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Recurring dispatches: one row per schedule. Each fire creates a normal thread via the standard
-- pipeline (so it uses whatever provider/model is active), then next_run_at is recomputed from the
-- cron string. No FK: last_thread_id is a soft jump-target link that's allowed to dangle if the task
-- it points at is purged.
CREATE TABLE IF NOT EXISTS scheduled_tasks (
  id             TEXT PRIMARY KEY,
  title          TEXT NOT NULL,
  workspace      TEXT NOT NULL,
  prompt         TEXT NOT NULL,
  cron           TEXT NOT NULL,
  enabled        INTEGER NOT NULL DEFAULT 1,
  effort         TEXT,
  last_run_at    INTEGER,
  next_run_at    INTEGER,
  last_thread_id TEXT,
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL
);

-- The operator's note list: short pointers agents leave for the owner — a branch to review, a PR to
-- merge — that they click and then delete. Deliberately NOT keyed to a task: the note outlives the
-- work (a PR waits for the owner long after the task closes), so thread_id has NO FK and the task's
-- title/workspace are SNAPSHOT here rather than joined, keeping the note readable after a purge.
-- seq is the ORDER; created_at is only what the list displays. A burst of posts lands inside one
-- millisecond, so ordering on the timestamp leaves ties that the random id then breaks arbitrarily —
-- which is also the order the per-task cap evicts in, so it would drop the wrong note. Bumped on insert
-- AND on a refresh, so a re-posted link floats to the top of the owner's list the way a new one does.
CREATE TABLE IF NOT EXISTS operator_notes (
  id           TEXT PRIMARY KEY,
  seq          INTEGER NOT NULL,
  body         TEXT NOT NULL,
  url          TEXT,
  thread_id    TEXT,
  thread_title TEXT,
  workspace    TEXT,
  from_role    TEXT,
  from_name    TEXT,
  created_at   INTEGER NOT NULL
);

-- The office: cross-agent chat. A row is one message in a room ('general' or 'repo:<normalized>').
-- thread_id is nullable (room-level system notices), with NO FK so a row survives its task's purge —
-- the conversation is the durable record of a collaboration, kept even after the tasks close.
CREATE TABLE IF NOT EXISTS chat_messages (
  id          TEXT PRIMARY KEY,
  room        TEXT NOT NULL,
  scope       TEXT NOT NULL,
  workspace   TEXT,
  thread_id   TEXT,
  run_id      TEXT,
  role        TEXT NOT NULL,
  kind        TEXT NOT NULL DEFAULT 'chat',
  body        TEXT NOT NULL,
  sender_name TEXT,
  remote_instance TEXT,
  created_at  INTEGER NOT NULL
);

-- Auto model selection's memory: one row per task whose implementor model was auto-picked, holding the
-- pick and — once the task settles — how the work turned out. NO FK to threads on purpose: a closed task
-- is purged after 30 days, and the lesson has to outlive it (same reasoning as chat_messages). Keyed by
-- thread_id so a retry's fresh pick replaces the old record rather than double-counting the task.
CREATE TABLE IF NOT EXISTS model_grades (
  thread_id    TEXT PRIMARY KEY,
  workspace    TEXT NOT NULL,
  title        TEXT NOT NULL DEFAULT '',
  provider     TEXT NOT NULL,
  model        TEXT NOT NULL,
  effort       TEXT NOT NULL,
  reason       TEXT NOT NULL DEFAULT '',
  outcome      TEXT,
  score        INTEGER,
  qa_rounds    INTEGER,
  cost_usd     REAL,
  num_turns    INTEGER,
  input_tokens INTEGER,
  output_tokens INTEGER,
  cache_read_input_tokens INTEGER,
  cache_creation_input_tokens INTEGER,
  reasoning_output_tokens INTEGER,
  total_tokens INTEGER,
  token_usage_complete INTEGER,
  duration_ms  INTEGER,
  ran_models   TEXT,
  graded_model TEXT,
  created_at   INTEGER NOT NULL,
  graded_at    INTEGER
);

-- Director Supervisor: a lightweight watchdog over active tasks (Settings, off by default). One row per
-- check/skip/action pass, so the console can show not just current state but WHY it acted or didn't --
-- the feature's transparency requirement. Cascades with its thread like findings/agent_runs: this is
-- task-scoped observability, not a ledger meant to outlive a purge. thread_id is nullable for a pass
-- with no single task to point at.
CREATE TABLE IF NOT EXISTS supervisor_events (
  id               TEXT PRIMARY KEY,
  thread_id        TEXT REFERENCES threads(id) ON DELETE CASCADE,
  thread_title     TEXT,
  workspace        TEXT,
  trigger          TEXT NOT NULL,
  kind             TEXT NOT NULL,
  action           TEXT,
  summary          TEXT NOT NULL,
  detail           TEXT,
  used_agent       INTEGER NOT NULL DEFAULT 0,
  cost_usd         REAL,
  total_tokens     INTEGER,
  model            TEXT,
  notified_discord INTEGER NOT NULL DEFAULT 0,
  created_at       INTEGER NOT NULL
);

-- Explicit owner conversation with the Supervisor. One row is one request/reply turn so the pending
-- lifecycle and its eventual execution results update atomically. Targets/results are compact JSON
-- snapshots. There is deliberately NO FK to threads: this is the owner's durable supervision audit and
-- must remain intelligible after a task is purged (the same lifetime rule as director_messages).
CREATE TABLE IF NOT EXISTS supervisor_chat_turns (
  id             TEXT PRIMARY KEY,
  content        TEXT NOT NULL,
  targets        TEXT NOT NULL DEFAULT '[]',
  status         TEXT NOT NULL,
  response       TEXT,
  action_results TEXT NOT NULL DEFAULT '[]',
  used_agent     INTEGER NOT NULL DEFAULT 0,
  cost_usd       REAL,
  total_tokens   INTEGER,
  model          TEXT,
  provider       TEXT,
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_runs_thread     ON agent_runs(thread_id);
CREATE INDEX IF NOT EXISTS idx_grades_model    ON model_grades(graded_model);
CREATE INDEX IF NOT EXISTS idx_findings_thread ON findings(thread_id);
CREATE INDEX IF NOT EXISTS idx_messages_thread ON messages(thread_id);
CREATE INDEX IF NOT EXISTS idx_questions_thread ON questions(thread_id);
CREATE INDEX IF NOT EXISTS idx_chat_room       ON chat_messages(room, created_at);
CREATE INDEX IF NOT EXISTS idx_notes_thread    ON operator_notes(thread_id);
CREATE INDEX IF NOT EXISTS idx_supervisor_events_thread  ON supervisor_events(thread_id);
CREATE INDEX IF NOT EXISTS idx_supervisor_events_created ON supervisor_events(created_at);
CREATE INDEX IF NOT EXISTS idx_supervisor_chat_created   ON supervisor_chat_turns(created_at);
`;
