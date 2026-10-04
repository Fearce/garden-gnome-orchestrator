/** Gate for the composer's optimistic recent-repo edits: an add, a removal and the active chip must agree
 *  with the server's one-chip-per-workspace identity, or a chip doubles until the next broadcast. */
const { withRecentRepo, withoutRecentRepo, isSameRepo } = await import("../src/lib/recentRepos.js");

let passed = 0;
const failures: string[] = [];
function check(label: string, condition: boolean): void {
  if (condition) {
    passed++;
    console.log(`  ✓ ${label}`);
  } else {
    failures.push(label);
    console.log(`  ✗ ${label}`);
  }
}
const same = (a: readonly string[], b: readonly string[]) => JSON.stringify(a) === JSON.stringify(b);

const wow = "C:\\repos\\wowforever_summon_overlay";
const wowTree = "C:\\repos\\wowforever_summon_overlay.worktrees\\chips\\wowforever_summon_overlay";
const ggo = "C:\\claude-orchestrator";

console.log("\nA. adding a repo");
check("a forward-slash spelling of a listed repo moves it instead of adding a chip",
  same(withRecentRepo([ggo, wow], "C:/repos/wowforever_summon_overlay/", 9), [wow, ggo]));
check("a lower-case drive spelling is stored canonically", same(withRecentRepo([wow], "c:\\claude-orchestrator", 9), [ggo, wow]));
check("a folder-case variant replaces the chip rather than joining it",
  same(withRecentRepo(["C:\\Repos\\App", ggo], "c:/repos/app", 9), ["C:\\repos\\app", ggo]));
check("a same-named worktree is a chip of its own", same(withRecentRepo([wow], wowTree, 9), [wowTree, wow]));
check("POSIX paths stay case-sensitive", same(withRecentRepo(["/srv/app"], "/srv/App", 9), ["/srv/App", "/srv/app"]));
check("the cap still applies", same(withRecentRepo([ggo, wow], wowTree, 2), [wowTree, ggo]));
check("a blank path changes nothing", same(withRecentRepo([ggo], "   ", 9), [ggo]));

console.log("\nB. removing a repo");
check("forget matches any spelling of the workspace", same(withoutRecentRepo([wowTree, ggo, wow], "c:/repos/WOWFOREVER_summon_overlay/"), [wowTree, ggo]));

console.log("\nC. the active chip");
check("a typed lower-case path lights the canonical chip", isSameRepo(ggo, "c:\\claude-orchestrator"));
check("a forward-slash path with a trailing slash lights it too", isSameRepo(ggo, " C:/claude-orchestrator/ "));
check("a same-named worktree does not light the main repo's chip", !isSameRepo(wow, wowTree));
check("an empty workspace lights nothing", !isSameRepo(ggo, "  "));

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) process.exit(1);
