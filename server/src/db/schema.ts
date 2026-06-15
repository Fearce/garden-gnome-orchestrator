// SQLite schema, inlined so it survives the tsc build with no copy step.

export const SCHEMA = /* sql */ `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS threads (
  id          TEXT PRIMARY KEY,
  title       TEXT NOT NULL,
  state       TEXT NOT NULL,
  workspace   TEXT NOT NULL,
  brief       TEXT NOT NULL DEFAULT '',
  raw_prompt  TEXT NOT NULL DEFAULT '',
  error       TEXT,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
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
  error       TEXT,
  started_at  INTEGER NOT NULL,
  ended_at    INTEGER
);

CREATE TABLE IF NOT EXISTS findings (
  id          TEXT PRIMARY KEY,
  thread_id   TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  from_run_id TEXT,
  from_role   TEXT,
  summary     TEXT NOT NULL,
  detail      TEXT,
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
  created_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS director_messages (
  id          TEXT PRIMARY KEY,
  role        TEXT NOT NULL,
  kind        TEXT NOT NULL,
  content     TEXT NOT NULL,
  attachments TEXT NOT NULL DEFAULT '[]',
  created_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS attachments (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  media_type  TEXT NOT NULL,
  data        TEXT NOT NULL,
  created_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS kv (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_runs_thread     ON agent_runs(thread_id);
CREATE INDEX IF NOT EXISTS idx_findings_thread ON findings(thread_id);
CREATE INDEX IF NOT EXISTS idx_messages_thread ON messages(thread_id);
CREATE INDEX IF NOT EXISTS idx_questions_thread ON questions(thread_id);
`;
