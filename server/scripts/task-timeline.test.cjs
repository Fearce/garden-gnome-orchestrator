// Gate for the control-flow join behind `probe:task-runs`. Replays the timestamps from the Android
// capacity incident: a boot interrupts QA, an owner message returns work to implementation, Claude caps,
// and Codex is selected later. The value of the probe is the ORDER across those separate stores.

const assert = require("node:assert/strict");
const { collectTaskTimeline, localStamp, renderTaskTimeline, utcStamp } = require("./task-timeline.cjs");

const at = (iso) => Date.parse(iso);
const thread = {
  id: "fe529d83",
  title: "Retrieve bearer token and configure keyboard input",
  state: "implementing",
  created_at: at("2026-08-28T12:40:00.000Z"),
  updated_at: at("2026-08-28T13:20:00.000Z"),
};
const runs = [
  {
    role: "qa",
    model: "gpt-5.5",
    account: "codex:gpt-5.5",
    effort: "high",
    session_id: "qa-session",
    state: "interrupted",
    cap_flagged: 0,
    started_at: at("2026-08-28T12:46:16.000Z"),
    ended_at: at("2026-08-28T13:17:35.000Z"),
  },
  {
    role: "implementor",
    model: "claude-sonnet-5",
    account: "personal",
    effort: "xhigh",
    session_id: "claude-session",
    state: "error",
    cap_flagged: 1,
    error: "You've hit your session limit · resets 3:30pm (Europe/Copenhagen)",
    started_at: at("2026-08-28T13:17:39.400Z"),
    ended_at: at("2026-08-28T13:17:49.400Z"),
  },
  {
    role: "implementor",
    model: "gpt-5.6-terra",
    account: "codex:gpt-5.6-terra",
    effort: "high",
    session_id: "codex-session",
    state: "running",
    cap_flagged: null,
    started_at: at("2026-08-28T13:19:31.500Z"),
    ended_at: null,
  },
];
const findings = [
  {
    from_role: "qa",
    kind: "finding",
    summary: "QA was interrupted by the owner - returning to the implementor",
    detail: "Use the normal messages app and Discord.",
    created_at: at("2026-08-28T13:17:39.381Z"),
  },
  {
    from_role: "director",
    kind: "finding",
    summary: "Usage-aware routing chose Codex — enough quota runway",
    detail: "Codex general pool: 5h meter unknown · weekly 67% free — enough runway.",
    created_at: at("2026-08-28T13:19:31.340Z"),
  },
  {
    from_role: "director",
    kind: "finding",
    summary: "Supervisor checked this task much later",
    detail: "A late note must not turn the gap into a server-wide restart log.",
    created_at: at("2026-08-28T22:10:35.000Z"),
  },
];
const messages = [
  {
    role: "director",
    kind: "system",
    content: "↪ interrupt requested (QA is stopping; returning to the implementor)",
    created_at: at("2026-08-28T13:17:39.376Z"),
  },
  {
    role: "assistant",
    kind: "message",
    content: "ordinary agent prose must not flood the control-flow timeline",
    created_at: at("2026-08-28T13:17:40.000Z"),
  },
];
const entry = (iso, label, body = "") =>
  `[${iso}] ${label}\nmem rss=100MB heapUsed=30MB heapTotal=64MB ext=4MB uptime=1s pid=123${body ? `\n${body}` : ""}\n`;
const crashText = [
  entry("2026-08-28T12:00:00.000Z", "boot — build too-old"),
  entry("2026-08-28T13:17:30.000Z", "boot — build f5ef0842"),
  entry("2026-08-28T13:17:30.200Z", "restart reconcile — runs=6 resumed=4 handedBack=2"),
  entry("2026-08-28T13:18:30.000Z", "memory high-water rss=232MB"),
  entry("2026-08-28T13:40:00.000Z", "boot — build too-new"),
  entry("2026-08-28T16:00:00.000Z", "boot — build unrelated-middle"),
].join("\n");

const events = collectTaskTimeline({
  thread,
  runs,
  findings,
  messages,
  crashText,
});
const rendered = renderTaskTimeline(events, "Europe/Copenhagen").join("\n");

assert.equal(
  utcStamp(at("2026-08-28T13:17:39.376Z")),
  "2026-08-28 13:17:39.376Z",
  "UTC stamps are explicit instead of looking like ambiguous local time",
);
assert.equal(
  localStamp(at("2026-08-28T13:17:39.376Z"), "Europe/Copenhagen"),
  "2026-08-28 15:17:39.376 Europe/Copenhagen (2026-08-28 13:17:39.376Z)",
  "the owner's 15:17 clock is shown beside SQLite's 13:17Z clock",
);

const serverEvents = events.filter((event) => event.kind === "server");
assert.deepEqual(
  serverEvents.map((event) => event.summary),
  [
    "server lifecycle · boot — build f5ef0842",
    "server lifecycle · restart reconcile — runs=6 resumed=4 handedBack=2",
  ],
  "only control-plane lifecycle records near this task's persisted events are correlated",
);
assert.ok(!rendered.includes("memory high-water"), "routine memory notes do not drown the incident trace");
assert.ok(!rendered.includes("unrelated-middle"), "a late supervisor note does not pull every intervening boot into the task");
assert.ok(!rendered.includes("ordinary agent prose"), "ordinary agent output is not duplicated in the control-flow trace");
assert.match(rendered, /run start · implementor · claude-sonnet-5 · personal/, "the selected account is visible");
assert.match(rendered, /run end · implementor · claude-sonnet-5 · personal · error · CAP/, "the runner's cap verdict is visible");
assert.match(rendered, /Codex general pool: 5h meter unknown · weekly 67% free/, "capacity reservation detail survives the join");

const bootAt = rendered.indexOf("boot — build f5ef0842");
const interruptAt = rendered.indexOf("interrupt requested");
const claudeCapAt = rendered.indexOf("claude-sonnet-5 · personal · error · CAP");
const codexRouteAt = rendered.indexOf("Usage-aware routing chose Codex");
assert.ok(
  bootAt >= 0 && bootAt < interruptAt && interruptAt < claudeCapAt && claudeCapAt < codexRouteAt,
  "the exact restart → QA interruption → capped Claude → viable Codex sequence is ordered on one clock",
);

console.log("taskTimeline: all assertions passed");
