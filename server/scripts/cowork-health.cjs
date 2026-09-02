// Durable Co-work session diagnostics, shared by probe:cowork and its gate.
//
// Co-work has no thread, no agent_runs row, no QA and no supervisor, so every task-side probe is blind
// to it: a wedged Co-work session shows up nowhere at all. What can actually go wrong is durable-state
// incoherence — a turn claim nothing is able to release, a partial reply left mid-stream by a restart,
// an explicit model pin that was silently substituted, one provider session shared by two
// conversations, live steering whose delivery outcome is unclear, or an attachment reference that no
// longer resolves to the bytes/name/type shown in history. Classify all of that here, once, instead of
// hand-writing SQLite joins per incident.

const SESSION_STATES = new Set(["idle", "running", "stopping", "error"]);
const ACTIVE_SESSION_STATES = new Set(["running", "stopping"]);
const TERMINAL_TURN_STATES = new Set(["done", "error", "cancelled", "interrupted", "timeboxed"]);
const FAILED_TURN_STATES = new Set(["error", "interrupted"]);
const STEERING_MODES = new Set(["queue", "append", "interrupt"]);
const STEERING_DELIVERIES = new Set(["delivered", "pending", "failed"]);

function coworkSchemaIssue(db) {
  const required = ["cowork_sessions", "cowork_turns", "cowork_messages", "attachments"];
  const names = new Set(
    db
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name IN (${required.map(() => "?").join(",")})`)
      .all(...required)
      .map((row) => row.name),
  );
  const missing = required.filter((name) => !names.has(name));
  if (missing.length) return `missing table(s): ${missing.join(", ")}`;
  const messageColumns = new Set(db.prepare("PRAGMA table_info(cowork_messages)").all().map((row) => row.name));
  if (!messageColumns.has("attachments")) return "cowork_messages has no attachments column";
  return null;
}

function coworkTablesExist(db) {
  return coworkSchemaIssue(db) == null;
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

function parseSteeringMessage(row) {
  const base = {
    id: row.id,
    turnId: row.turn_id,
    content: row.content,
    createdAt: Number(row.created_at),
  };
  let meta;
  try {
    meta = JSON.parse(row.meta);
  } catch {
    return { ...base, mode: "unknown", delivery: "unknown", error: null, metaError: "meta is not valid JSON" };
  }
  if (!meta || typeof meta !== "object" || typeof meta.steeringMode !== "string") {
    return { ...base, mode: "unknown", delivery: "unknown", error: null, metaError: "meta has no steeringMode" };
  }
  // The first steering build called a successful delivery `accepted`; normalize those durable rows
  // so an upgrade does not make old conversations look broken.
  const delivery = meta.delivery === "accepted"
    ? "delivered"
    : typeof meta.delivery === "string"
      ? meta.delivery
      : "unknown";
  return {
    ...base,
    mode: meta.steeringMode,
    delivery,
    error: typeof meta.error === "string" ? meta.error : null,
    metaError: null,
  };
}

function steeringSummary(messages) {
  const byMode = { queue: 0, append: 0, interrupt: 0, unknown: 0 };
  const byDelivery = { delivered: 0, pending: 0, failed: 0, unknown: 0 };
  for (const message of messages) {
    const mode = STEERING_MODES.has(message.mode) ? message.mode : "unknown";
    const delivery = STEERING_DELIVERIES.has(message.delivery) ? message.delivery : "unknown";
    byMode[mode] += 1;
    byDelivery[delivery] += 1;
  }
  return { total: messages.length, byMode, byDelivery, messages };
}

function parseAttachmentPayload(row) {
  let value;
  try {
    value = JSON.parse(row.attachments);
  } catch {
    return { refs: [], errors: ["attachments is not valid JSON"] };
  }
  if (!Array.isArray(value)) return { refs: [], errors: ["attachments is not a JSON array"] };

  const refs = [];
  const errors = [];
  for (let index = 0; index < value.length; index++) {
    const ref = value[index];
    if (
      !ref ||
      typeof ref !== "object" ||
      !nonBlank(ref.id) ||
      !nonBlank(ref.name) ||
      !nonBlank(ref.mediaType)
    ) {
      errors.push(`attachment ${index + 1} is not a complete {id,name,mediaType} reference`);
      continue;
    }
    refs.push({ id: ref.id, name: ref.name, mediaType: ref.mediaType });
  }
  return { refs, errors };
}

/** The attachment cache under data/cowork-attachments is deliberately disposable and rebuilt before a
 * turn. This checks the durable half only: every message ref must parse, resolve, and describe the same
 * blob row. A missing cache file is rehydratable; a missing blob row is permanent conversation loss. */
function attachmentSummary(db, sessionId) {
  const rows = db
    .prepare("SELECT id, attachments FROM cowork_messages WHERE session_id=? ORDER BY created_at ASC, rowid ASC")
    .all(sessionId);
  const readBlob = db.prepare("SELECT id, name, media_type FROM attachments WHERE id=?");
  const blobs = new Map();
  const ids = new Set();
  const storedIds = new Set();
  const malformed = [];
  const missing = [];
  const metadataMismatches = [];
  let messageRows = 0;
  let refs = 0;

  for (const row of rows) {
    const parsed = parseAttachmentPayload(row);
    if (parsed.refs.length || parsed.errors.length) messageRows += 1;
    for (const error of parsed.errors) malformed.push({ messageId: row.id, error });
    for (const ref of parsed.refs) {
      refs += 1;
      ids.add(ref.id);
      if (!blobs.has(ref.id)) blobs.set(ref.id, readBlob.get(ref.id) ?? null);
      const blob = blobs.get(ref.id);
      if (!blob) {
        missing.push({ messageId: row.id, ref });
        continue;
      }
      storedIds.add(ref.id);
      if (blob.name !== ref.name || blob.media_type !== ref.mediaType) {
        metadataMismatches.push({
          messageId: row.id,
          ref,
          stored: { name: blob.name, mediaType: blob.media_type },
        });
      }
    }
  }

  return {
    messageRows,
    refs,
    unique: ids.size,
    stored: storedIds.size,
    malformed,
    missing,
    metadataMismatches,
  };
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
  const steering = steeringSummary(
    db
      .prepare(
        `SELECT id, turn_id, content, meta, created_at
           FROM cowork_messages
          WHERE session_id=? AND role='user' AND kind='text' AND meta IS NOT NULL
          ORDER BY created_at ASC, rowid ASC`,
      )
      .all(row.id)
      .map(parseSteeringMessage),
  );
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
    attachments: attachmentSummary(db, row.id),
    steering,
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

function checkAttachments(session, issues) {
  for (const problem of session.attachments.malformed) {
    issues.push(`message ${problem.messageId.slice(0, 8)} has invalid attachment data: ${problem.error}`);
  }
  for (const problem of session.attachments.missing) {
    issues.push(
      `message ${problem.messageId.slice(0, 8)} references missing attachment ${problem.ref.id} (${JSON.stringify(problem.ref.name)})`,
    );
  }
  for (const problem of session.attachments.metadataMismatches) {
    issues.push(
      `message ${problem.messageId.slice(0, 8)} attachment ${problem.ref.id} metadata differs from storage ` +
        `(ref ${JSON.stringify(problem.ref.name)}/${problem.ref.mediaType}; stored ${JSON.stringify(problem.stored.name)}/${problem.stored.mediaType})`,
    );
  }
}

function checkSteering(session, issues, notes) {
  const turnIds = new Set(session.turns.map((turn) => turn.id));
  let failed = 0;
  let unconfirmed = 0;
  for (const message of session.steering.messages) {
    if (message.metaError) {
      issues.push(`steering message ${message.id.slice(0, 8)} has invalid metadata: ${message.metaError}`);
    } else {
      if (!STEERING_MODES.has(message.mode)) {
        issues.push(`steering message ${message.id.slice(0, 8)} has unknown mode '${message.mode}'`);
      }
      if (!STEERING_DELIVERIES.has(message.delivery)) {
        issues.push(`steering message ${message.id.slice(0, 8)} has unknown delivery state '${message.delivery}'`);
      }
    }
    if (!message.turnId || !turnIds.has(message.turnId)) {
      issues.push(`steering message ${message.id.slice(0, 8)} is not attached to one of this session's turns`);
    }
    if (message.delivery === "failed") {
      failed += 1;
      if (!nonBlank(message.error)) {
        issues.push(`steering message ${message.id.slice(0, 8)} failed delivery with no owner-visible reason`);
      }
    }
    if (
      message.delivery === "pending" &&
      (session.activeTurnId !== message.turnId || !ACTIVE_SESSION_STATES.has(session.state))
    ) {
      unconfirmed += 1;
    }
  }
  if (failed) {
    notes.push(`${failed} live direction(s) failed provider delivery; retained in history but excluded from fresh-session replay`);
  }
  if (unconfirmed) {
    notes.push(`${unconfirmed} live direction(s) have unconfirmed delivery after their turn closed; review and resend deliberately if still needed`);
  }
  return failed > 0 || unconfirmed > 0;
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
  checkAttachments(session, issues);
  const deliveryConcern = checkSteering(session, issues, notes);

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
  else if (session.state === "error" || deliveryConcern) disposition = "recoverable";
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
  coworkSchemaIssue,
  coworkTablesExist,
  selectCoworkRows,
};
