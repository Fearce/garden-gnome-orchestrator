// Gate for `deploy.cjs`'s build decision. Run: `npm run test:deploy-plan`.
//
// This is the half of the deploy that can do damage, and it is invisible until it has: choose "plain"
// while a sibling has half a runner rewritten and their un-QA'd code is live in prod under your deploy;
// choose "head-only" on a clean tree and you have paid ten tool calls and a junction dance for nothing.
// Both happened on 2026-08-24 in the same afternoon. `planBuild` is pure, so the whole decision is held
// here without a build, a temp tree, or a restart.
const assert = require("node:assert/strict");
const { planBuild, porcelainPath, restartLookedLikeANoop } = require("./deploy.cjs");

let checks = 0;
const check = (name, cond) => {
  checks++;
  if (!cond) {
    console.error(`  ✗ ${name}`);
    process.exitCode = 1;
  } else console.log(`  ✓ ${name}`);
};

console.log("deploy plan: a clean tree takes the fast path");
{
  const p = planBuild([]);
  check("clean tree builds plainly", p.server === "plain" && p.web === "plain");
  check("nothing is reported as excluded", p.serverBlockers.length === 0 && p.webBlockers.length === 0);
}

console.log("deploy plan: anything that COMPILES into dist forces the HEAD-only build");
{
  for (const line of [" M server/src/agents/runner.ts", "?? server/src/tools/newThing.ts", "M  server/tsconfig.json"]) {
    const p = planBuild([line]);
    check(`${line.trim()} → head-only`, p.server === "head-only");
    check("...and is named as excluded", p.serverBlockers.length === 1);
  }
}

console.log("deploy plan: a dirty file that cannot reach dist must NOT cost the slow path");
{
  // The whole point of the predicate. `git status` is noisy in this checkout — labs, probes, rules,
  // scratch — and treating all of it as "dirty" would make the expensive path the permanent default,
  // which is how a correct-but-unusable check gets bypassed by hand.
  const noise = [
    " M server/scripts/notes-lab.cjs",
    " M server/package.json",
    " M CLAUDE.md",
    " M .claude/rules/office-bridge.md",
    "?? server/data/gates-last.log",
    " M docs/DECISIONS.md",
  ];
  const p = planBuild(noise);
  check("none of it forces head-only", p.server === "plain");
  check("and none of it blocks the web build", p.web === "plain");
}

console.log("deploy plan: the two halves are judged separately");
{
  const p = planBuild([" M web/src/components/Board.tsx"]);
  check("a dirty web source skips the web build", p.web === "skip" && p.webBlockers.length === 1);
  check("...without dragging the server onto the slow path", p.server === "plain");

  const q = planBuild([" M server/src/db/db.ts", " M web/src/store.ts"]);
  check("both dirty → head-only server, skipped web", q.server === "head-only" && q.web === "skip");
}

console.log("deploy plan: porcelain shapes that would otherwise read as a different file");
{
  check("a rename reports its NEW path", porcelainPath('R  server/src/a.ts -> server/src/b.ts') === "server/src/b.ts");
  check("a renamed source still forces head-only", planBuild(['R  docs/a.md -> server/src/b.ts']).server === "head-only");
  check("a quoted path is unquoted", porcelainPath('?? "server/src/a b.ts"') === "server/src/a b.ts");
  check("backslashes normalize to forward", porcelainPath(" M server\\src\\a.ts") === "server/src/a.ts");
  check("a quoted dirty source still forces head-only", planBuild(['?? "server/src/new file.ts"']).server === "head-only");
  check("a blank line is ignored", planBuild([""]).server === "plain");
}

console.log("deploy: a restart that killed nothing is not a deploy");
{
  // The documented elevated-listener case: HTTP 200, no `errors`, nothing actually bounced. Reading that
  // as success is how a deploy gets reported done while prod keeps serving the old build.
  check("ok:false is a no-op", restartLookedLikeANoop({ ok: false, stop: { killed: [1234] } }));
  check("an empty kill list is a no-op", restartLookedLikeANoop({ ok: true, stop: { killed: [] } }));
  check("a real kill is not", !restartLookedLikeANoop({ ok: true, stop: { killed: [4242] } }));
  check("an unparseable reply is not assumed broken", !restartLookedLikeANoop(null));
}

if (process.exitCode) {
  console.error(`\ndeploy-plan: FAILED (${checks} checks run)`);
} else {
  console.log(`\nAll ${checks} deploy-plan checks passed.`);
}
