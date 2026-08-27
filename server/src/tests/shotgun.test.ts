/**
 * Unit gate — SHOTGUN tasks: the ownership rules that decide whether a split is safe.
 *
 * `validateDecomposition` is the safety gate of the whole feature. Collaborators work ONE checkout on
 * ONE branch (the no-worktrees convention), so nothing merges their changes and two agents editing the
 * same file silently destroy each other's work. There is no recovery from that and no signal that it
 * happened — so a decomposition whose file sets intersect must be REFUSED, not warned about.
 *
 * The bias runs one way on purpose: a false "unsafe" costs a degrade to one agent (a complete task,
 * just slower), while a false "safe" costs lost work. Every case below is written from that asymmetry.
 *
 * Free: pure functions, no DB, no agent.
 * Run:  npm run test:shotgun   (from server/)
 */

import {
  MAX_AGENTS,
  MIN_AGENTS,
  clampAgentCount,
  collaboratorSettled,
  findCollision,
  integrationBrief,
  isShotgun,
  normalizeOwnedPath,
  ownershipBlock,
  pathsCollide,
  validateDecomposition,
  type ShotgunAssignment,
  type ShotgunPlan,
} from "../orchestrator/shotgun.js";

let passed = 0;
let failed = 0;
const failures: string[] = [];
function check(label: string, cond: boolean, detail?: string): void {
  if (cond) {
    passed++;
    console.log(`  ✅ ${label}`);
  } else {
    failed++;
    failures.push(label + (detail ? ` — ${detail}` : ""));
    console.log(`  ❌ ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

const A = (title: string, files: string[]): ShotgunAssignment => ({ title, objective: `build ${title}`, files });
const PLAN = (assignments: ShotgunAssignment[], over: Partial<ShotgunPlan> = {}): ShotgunPlan => ({
  parallelizable: true,
  reason: "independent areas",
  assignments,
  ...over,
});

console.log("\n=== shotgun tasks — ownership + decomposition validation ===\n");

// -- 1. agent-count bounds --------------------------------------------------------------------------
console.log("1 — the requested agent count is bounded at the boundary, never trusted from a client");
check("below the floor clamps up", clampAgentCount(0) === MIN_AGENTS);
check("a negative clamps up", clampAgentCount(-4) === MIN_AGENTS);
check("above the ceiling clamps down", clampAgentCount(50) === MAX_AGENTS);
check("a normal value passes through", clampAgentCount(3) === 3);
check("a fraction rounds", clampAgentCount(3.4) === 3);
check("NaN falls to the floor rather than poisoning arithmetic", clampAgentCount(Number.NaN) === MIN_AGENTS);
check("1 is not a shotgun", !isShotgun(1));
check("null is not a shotgun", !isShotgun(null));
check("undefined is not a shotgun", !isShotgun(undefined));
check("2 is a shotgun", isShotgun(2));

// -- 2. path collision, which IS the safety mechanism -----------------------------------------------
console.log("\n2 — path collision (a directory owns everything beneath it)");
check("identical paths collide", pathsCollide("src/a.ts", "src/a.ts"));
check("Windows vs POSIX spelling of one path collides", pathsCollide("src\\a.ts", "src/a.ts"));
check("case differences collide", pathsCollide("SRC/A.ts", "src/a.ts"));
check("a leading ./ is the same path", pathsCollide("./src/a.ts", "src/a.ts"));
check("a trailing slash is the same path", pathsCollide("src/api/", "src/api"));
check("a directory collides with a file inside it", pathsCollide("src/api", "src/api/routes.ts"));
check("...and in the other order", pathsCollide("src/api/routes.ts", "src/api"));
check("siblings do NOT collide", !pathsCollide("src/api", "src/web"));
// The boundary check: without requiring the '/' these would read as nested and force a needless degrade.
check("a shared PREFIX is not nesting (src/apidocs is not inside src/api)", !pathsCollide("src/api", "src/apidocs"));
check("unrelated files do not collide", !pathsCollide("a.ts", "b.ts"));
check("an empty path never collides", !pathsCollide("", "src/a.ts"));
check("normalizeOwnedPath is idempotent", normalizeOwnedPath(normalizeOwnedPath("./Src/Api/")) === normalizeOwnedPath("./Src/Api/"));

console.log("\n3 — collisions between two shares");
check("overlapping shares report the offending pair", !!findCollision(A("x", ["src/a.ts"]), A("y", ["src/a.ts"])));
check("disjoint shares report none", findCollision(A("x", ["src/a.ts"]), A("y", ["src/b.ts"])) === null);
check("the collision is found anywhere in the lists", !!findCollision(A("x", ["p", "q", "src/a.ts"]), A("y", ["r", "src/a.ts"])));
// The validator's own pairwise sweep must catch a NON-ADJACENT collision, not just neighbours.
const nonAdjacent = validateDecomposition(PLAN([A("a", ["src/a"]), A("b", ["src/b"]), A("c", ["src/a/deep.ts"])]), 3);
check("a collision between non-adjacent shares is caught", !nonAdjacent.ok, nonAdjacent.ok ? "" : nonAdjacent.reason);

// -- 4. validateDecomposition — the gate ------------------------------------------------------------
console.log("\n4 — the decomposition gate: refuse anything that could collide");
const ok = validateDecomposition(PLAN([A("api", ["src/api"]), A("web", ["src/web"])]), 2);
check("a genuinely disjoint 2-way split is accepted", ok.ok);
check("the accepted split keeps both shares", ok.ok && ok.assignments.length === 2);

const collide = validateDecomposition(PLAN([A("api", ["src/api"]), A("also-api", ["src/api/routes.ts"])]), 2);
check("an OVERLAPPING split is refused", !collide.ok);
check("the refusal names both shares", !collide.ok && collide.reason.includes("api") && collide.reason.includes("also-api"), !collide.ok ? collide.reason : "");
check("the refusal names the colliding path", !collide.ok && collide.reason.includes("src/api"), !collide.ok ? collide.reason : "");
check(
  "the refusal explains the CONSEQUENCE, not just the rule",
  !collide.ok && collide.reason.includes("overwrite each other"),
  !collide.ok ? collide.reason : "",
);

const declined = validateDecomposition(PLAN([], { parallelizable: false, reason: "the work is sequential" }), 3);
check("parallelizable:false is refused", !declined.ok);
check("...carrying the planner's own reason", !declined.ok && declined.reason === "the work is sequential");

check("a null plan is refused (an absent verdict is never consent)", !validateDecomposition(null, 3).ok);
check("undefined is refused", !validateDecomposition(undefined, 3).ok);
check("one share is not a split", !validateDecomposition(PLAN([A("only", ["src"])]), 3).ok);
check("zero shares is not a split", !validateDecomposition(PLAN([]), 3).ok);
// Without a declared file set there is no ownership contract at all, which is the one thing keeping
// two agents apart in a shared tree — so it is refused rather than treated as "owns nothing".
const noFiles = validateDecomposition(PLAN([A("api", ["src/api"]), A("mystery", [])]), 2);
check("a share with NO declared files is refused", !noFiles.ok);
check("...and says which one", !noFiles.ok && noFiles.reason.includes("mystery"), !noFiles.ok ? noFiles.reason : "");
check(
  "a share with a blank title is dropped, and dropping it below 2 refuses the split",
  !validateDecomposition(PLAN([A("api", ["src/api"]), { title: "  ", objective: "x", files: ["src/web"] }]), 2).ok,
);
check(
  "a share with a blank objective is dropped too",
  !validateDecomposition(PLAN([A("api", ["src/api"]), { title: "web", objective: "   ", files: ["src/web"] }]), 2).ok,
);
check(
  "whitespace-only file entries are stripped, so a share of blanks reads as no files",
  !validateDecomposition(PLAN([A("api", ["src/api"]), { title: "web", objective: "do it", files: ["  ", ""] }]), 2).ok,
);
const canonical = validateDecomposition(PLAN([A("api", ["./src/api/"]), A("web", ["src/./web"])]), 2);
check("safe dot aliases are canonicalized before assignment", canonical.ok && canonical.assignments.map((a) => a.files.join(",")).join("|") === "src/api|src/web");
for (const [label, path, clue] of [
  ["repository root", ".", "repository root"],
  ["Unix absolute path", "/tmp/outside", "absolute"],
  ["Windows drive path", "C:" + "\\repo\\src\\web", "drive-qualified"],
  ["parent traversal", "src/api/../web", "traversal"],
] as const) {
  const unsafe = validateDecomposition(PLAN([A("bounded", ["src/api"]), A("unsafe", [path])]), 2);
  check(`${label} is rejected before collaborators can spawn`, !unsafe.ok && unsafe.reason.includes(clue), unsafe.ok ? "" : unsafe.reason);
}
const traversalAlias = validateDecomposition(PLAN([A("api", ["src/api"]), A("web", ["src/api/../web"])]), 2);
check("a traversal alias cannot masquerade as a disjoint sibling share", !traversalAlias.ok && traversalAlias.reason.includes("traversal"), traversalAlias.ok ? "" : traversalAlias.reason);

// Trimming: the planner is asked to rank shares, so asking for fewer agents keeps the leading ones.
const five = PLAN([A("a", ["1"]), A("b", ["2"]), A("c", ["3"]), A("d", ["4"]), A("e", ["5"])]);
const trimmed = validateDecomposition(five, 3);
check("more shares than agents ⇒ trimmed to the agent count", trimmed.ok && trimmed.assignments.length === 3);
check("...keeping the highest-ranked ones", trimmed.ok && trimmed.assignments.map((a) => a.title).join(",") === "a,b,c");
check("fewer shares than agents is fine (it runs with what it has)", validateDecomposition(PLAN([A("a", ["1"]), A("b", ["2"])]), 6).ok);
// The overlap check runs BEFORE the trim, so a collision outside the kept window still refuses. That is
// deliberate: a planner that produced overlapping shares has misunderstood the constraint, and trusting
// the part of its answer we happened to keep is exactly the optimistic reading this gate exists to deny.
const lateCollision = validateDecomposition(PLAN([A("a", ["1"]), A("b", ["2"]), A("c", ["1/deep.ts"])]), 2);
check("a collision among the TRIMMED-AWAY shares still refuses the whole split", !lateCollision.ok);

// -- 5. the barrier's terminal set -------------------------------------------------------------------
console.log("\n5 — which collaborator states end the lead's wait");
for (const st of ["done", "review", "failed", "cancelled", "closed"]) {
  check(`'${st}' is settled`, collaboratorSettled(st));
}
for (const st of ["implementing", "queued", "planning", "qa", "paused", "reviewing"]) {
  check(`'${st}' is NOT settled (the lead keeps waiting)`, !collaboratorSettled(st));
}

// -- 6. the text the agents actually receive ---------------------------------------------------------
console.log("\n6 — the ownership contract an agent is handed");
const block = ownershipBlock(A("api", ["src/api", "src/db"]), [{ title: "web", files: ["src/web"] }]);
check("names the agent's own paths", block.includes("src/api") && block.includes("src/db"));
check("names the peer's paths as off-limits", block.includes("src/web"));
check("forbids editing outside the share", block.toLowerCase().includes("only inside your share"));
// The specific mechanism by which a shared tree loses work: a broad `git add` sweeps a teammate's
// uncommitted hunks into your commit. Naming it is the difference between a rule and an instruction.
check("forbids a broad `git add`", block.includes("git add -A") && block.includes("never"));
check("tells it not to declare the whole task done", block.toLowerCase().includes("do not declare the overall task finished"));
check("points at the office for cross-share issues", block.includes('chat_post(scope:"team")'));
check("degrades cleanly when no peers are known yet", ownershipBlock(A("api", ["src/api"]), []).includes("still starting"));

console.log("\n7 — the integration brief the lead receives");
const brief = integrationBrief([
  { title: "api", state: "done", files: ["src/api"] },
  { title: "web", state: "review", files: ["src/web"], error: "needs a human" },
]);
check("lists every share and its verdict", brief.includes("api") && brief.includes("web"));
check("flags the share that did not finish", brief.includes("STOPPED"));
check("carries that share's error", brief.includes("needs a human"));
check("warns that an unfinished share's objective may NOT be met", brief.includes("do not assume their objective was met"));
check("requires the whole tree to build and pass tests", brief.toLowerCase().includes("make it build") && brief.toLowerCase().includes("tests"));
check("points at the seams as the likely problem", brief.toLowerCase().includes("seams"));
const allGood = integrationBrief([{ title: "api", state: "done", files: ["src/api"] }]);
check("an all-clean run says so instead of warning", allGood.includes("All shares finished cleanly"));
check("...and still directs attention at the seams", allGood.toLowerCase().includes("seams"));

console.log(`\n=== RESULT: ${failed === 0 ? "PASS ✅" : "FAIL ❌"} — ${passed} passed, ${failed} failed ===`);
if (failed > 0) {
  console.log("Failures:");
  for (const f of failures) console.log(`  - ${f}`);
}
process.exit(failed === 0 ? 0 : 1);
