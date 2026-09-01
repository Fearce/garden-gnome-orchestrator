// Durable Co-work session diagnostics, shared by probe:cowork and its gate.
//
// Co-work has no thread, no agent_runs row, no QA and no supervisor, so every task-side probe is blind
// to it: a wedged Co-work session shows up nowhere at all. What can actually go wrong is durable-state
// incoherence — a turn claim nothing is able to release, a partial reply left mid-stream by a restart,
// an explicit model pin that was silently substituted, or one provider session shared by two
// conversations. Classify all of that here, once, instead of hand-writing SQLite joins per incident.

const SESSION_STATES = new Set(["idle", "running", "stopping", "error"]);
const ACTIVE_SESSION_STATES = new Set(["running", "stopping"]);
const TERMINAL_TURN_STATES = new Set(["done", "error", "cancelled", "interrupted"]);
const FAILED_TURN_STATES = new Set(["error", "interrupted"]);

function coworkTablesExist(db) {
  const names = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('cowork_sessions','cowork_turns','cowork_messages')")
    .all()
    .map((row) => row.name);
  return names.length === 3;
}

/** Every session, newest activity first, each with its full turn trail and message tallies. A board
 * holds a handful of sessions, so per-session queries stay clearer than one wide join. */
function selectCoworkRows(db, query = null) {
  const sessions = db
    .prepare("SELECT * FROM cowork_sessions ORDER BY updated_at DESC, id")
    .all()
    .filter((row) => matchesQuery(row, query))
    .map((row) => normalizeSession(db, row));
  return sessions;
}

function matchesQuery(row, query) {
  if (!query) return true;
  const needle = String(query).toLowerCase();
  return row.id.toLowerCase().startsWith(needle) || String(row.name ?? "").toLowerCase().includes(needle);
}

function normalizeSession(db, row) {
  const turns = db
    .prepare("SELECT * FROM cowork_turns WHERE session_id=? ORDER BY started_at ASC, rowid ASC")
    .all(row.id)
    .map((turn) => ({
      id: turn.id,
      state: turn.state,
      provider: turn.provider,
      model: turn.model,
      effort: turn.effort,
      account: turn.account,
      agentSessionId: turn.agent_session_id,
      error: turn.error,
      costUsd: turn.cost_usd == null ? null : Number(turn.cost_usd),
      numTurns: turn.num_turns == null ? null : Number(turn.num_turns),
      totalTokens: turn.total_tokens == null ? null : Number(turn.total_tokens),
      startedAt: Number(turn.started_at),
      endedAt: turn.ended_at == null ? null : Number(turn.ended_at),
    }));
  const messages = db
    .prepare(
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN role='user' THEN 1 ELSE 0 END) AS owner,
              SUM(CASE WHEN role='coworker' AND kind='text' THEN 1 ELSE 0 END) AS replies,
              SUM(CASE WHEN role='system' THEN 1 ELSE 0 END) AS system,
              MAX(created_at) AS lastAt
         FROM cowork_messages WHERE session_id=?`,
    )
    .get(row.id);
  const danglingPartials = db
    .prepare(
      `SELECT m.id AS id, m.turn_id AS turnId
         FROM cowork_messages m
         LEFT JOIN cowork_turns t ON t.id = m.turn_id
        WHERE m.session_id=? AND m.partial=1
          AND (m.turn_id IS NULL OR m.turn_id <> COALESCE(?, '') OR t.state <> 'running')`,
    )
    .all(row.id, row.active_turn_id);
  return {
    id: row.id,
    name: row.name,
    autoNamed: Number(row.auto_named) === 1,
    workspace: row.workspace,
    state: row.state,
    requestedProvider: row.requested_provider,
    requestedModel: row.requested_model,
    provider: row.provider,
    model: row.model,
    effort: row.effort,
    account: row.account,
    agentSessionId: row.agent_session_id,
    activeTurnId: row.active_turn_id,
    error: row.error,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    turns,
    messages: {
      total: Number(messages?.total ?? 0),
      owner: Number(messages?.owner ?? 0),
      replies: Number(messages?.replies ?? 0),
      system: Number(messages?.system ?? 0),
      lastAt: messages?.lastAt == null ? null : Number(messages.lastAt),
    },
    danglingPartials,
  };
}

function activeTurn(session) {
  return session.activeTurnId ? session.turns.find((turn) => turn.id === session.activeTurnId) ?? null : null;
}

function lastTurn(session) {
  return session.turns.length ? session.turns[session.turns.length - 1] : null;
}

function checkClaimCoherence(session, issues) {
  const claimed = session.activeTurnId != null;
  const running = ACTIVE_SESSION_STATES.has(session.state);
  if (claimed && !running) {
    issues.push(`state '${session.state}' still holds active_turn_id ${session.activeTurnId}`);
  }
  if (running && !claimed) {
    // beginCoworkTurn only claims from idle/error, so this session can never accept another prompt.
    issues.push(`state '${session.state}' has no active turn — the session cannot accept another prompt`);
  }
  if (!claimed) return;
  const turn = activeTurn(session);
  if (!turn) issues.push(`active_turn_id ${session.activeTurnId} has no cowork_turns row`);
  else if (turn.state !== "running") issues.push(`the active turn is '${turn.state}', not running`);
  else if (turn.endedAt != null) issues.push("the active turn is running but already has ended_at");
}

function checkTurnTrail(session, issues) {
  for (const turn of session.turns) {
    if (turn.id === session.activeTurnId) continue;
    if (turn.state === "running") {
      issues.push(`turn ${turn.id.slice(0, 8)} is still 'running' but is not the active turn — a restart left it unreconciled`);
    } else if (!TERMINAL_TURN_STATES.has(turn.state)) {
      issues.push(`turn ${turn.id.slice(0, 8)} has unknown state '${turn.state}'`);
    } else if (turn.endedAt == null) {
      issues.push(`terminal turn ${turn.id.slice(0, 8)} ('${turn.state}') has no ended_at`);
    }
    if (FAILED_TURN_STATES.has(turn.state) && !nonBlank(turn.error)) {
      issues.push(`turn ${turn.id.slice(0, 8)} failed with no owner-visible reason`);
    }
  }
}

/** An explicitly requested provider/model is a strict pin: prepareCoworkerRun must fail the turn rather
 * than substitute. A turn that ran on anything else is a silent substitution, not a routing detail. */
function checkPin(session, issues) {
  if (!session.requestedProvider && !session.requestedModel) return;
  if (!session.requestedProvider || !session.requestedModel) {
    issues.push("the saved target is half-set (provider without model, or the reverse)");
    return;
  }
  for (const turn of session.turns) {
    if (turn.provider == null && turn.model == null) continue;
    if (turn.provider !== session.requestedProvider || turn.model !== session.requestedModel) {
      issues.push(
        `turn ${turn.id.slice(0, 8)} ran on ${turn.provider}/${turn.model} despite the pin ${session.requestedProvider}/${session.requestedModel}`,
      );
    }
  }
}

function checkPartials(session, issues) {
  if (!session.danglingPartials.length) return;
  issues.push(
    `${session.danglingPartials.length} message(s) are still partial=1 outside a running turn — the reload path will render a truncated reply`,
  );
}

function nonBlank(value) {
  return typeof value === "string" && value.trim().length > 0;
}

/** Classify one session. `attention` is reserved for durable invariant violations — a plain failed turn
 * is a normal, recoverable outcome the owner clears by sending the next prompt. */
function coworkReading(session) {
  const issues = [];
  const notes = [];

  if (!SESSION_STATES.has(session.state)) issues.push(`unknown session state '${session.state}'`);
  checkClaimCoherence(session, issues);
  checkTurnTrail(session, issues);
  checkPin(session, issues);
  checkPartials(session, issues);

  const last = lastTurn(session);
  if (session.state === "error" && !nonBlank(session.error) && last && FAILED_TURN_STATES.has(last.state)) {
    issues.push("the session is in error with no owner-visible reason");
  }
  if (!session.agentSessionId && session.turns.some((turn) => turn.state === "done")) {
    notes.push("no provider session is linked — the next turn replays the transcript into a fresh agent session");
  }
  if (session.requestedProvider && session.requestedModel) {
    notes.push(`pinned to ${session.requestedProvider}/${session.requestedModel}; a turn fails rather than substituting`);
  }

  let disposition = "idle";
  if (issues.length) disposition = "attention";
  else if (ACTIVE_SESSION_STATES.has(session.state)) disposition = "active";
  else if (session.state === "error") disposition = "recoverable";
  else if (!session.turns.length) disposition = "empty";

  return {
    session,
    disposition,
    attention: issues.length > 0,
    issues,
    notes,
    lastTurn: last,
    costUsd: session.turns.reduce((sum, turn) => sum + (turn.costUsd ?? 0), 0),
  };
}

/** Invariants that only exist ACROSS sessions: one provider session must never be shared by two
 * conversations, and the lane must never have persisted a task row for a Co-work session. */
function coworkBoardIssues(db, readings) {
  const issues = [];
  const byAgentSession = new Map();
  for (const reading of readings) {
    const id = reading.session.agentSessionId;
    if (!id) continue;
    const seen = byAgentSession.get(id) ?? [];
    seen.push(reading.session);
    byAgentSession.set(id, seen);
  }
  for (const [agentSessionId, sessions] of byAgentSession) {
    if (sessions.length > 1) {
      issues.push(
        `provider session ${agentSessionId} is shared by ${sessions.length} Co-work sessions (${sessions
          .map((session) => session.id.slice(0, 8))
          .join(", ")}) — one conversation's context can reach another`,
      );
    }
  }
  const leaked = db.prepare("SELECT COUNT(*) AS n FROM threads WHERE id LIKE 'cowork:%'").get();
  if (Number(leaked?.n ?? 0) > 0) {
    issues.push(
      `${leaked.n} task row(s) exist with a cowork: id — the strict-capacity Thread is synthetic and must never be persisted`,
    );
  }
  return issues;
}

module.exports = {
  coworkBoardIssues,
  coworkReading,
  coworkTablesExist,
  selectCoworkRows,
};
