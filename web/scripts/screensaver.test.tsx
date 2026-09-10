/**
 * Gate: the AFK screensaver, and the four things about it that cannot be checked by looking.
 *
 *   npm run test:screensaver --prefix server
 *
 * 1. THE RIGGING SOLVER. A gnome's rope length and lean are solved from one target point, and the
 *    prototype this grew out of shipped three real bugs of exactly one class: a sign error in a
 *    rotation. So the solver is checked by composing it FORWARD (rotate the rig's own impact offset
 *    by the angle it returned) and asserting the tool lands on the point that was asked for. A
 *    reversed sign still produces a plausible-looking small angle while the build is low, and only
 *    walks the gnome off the far side of the board once he traverses out along his rafter.
 *
 * 2. THE DATA MAPPING. Every lane is a real task, so the mapping from `ThreadState` to a pose, a
 *    role and a build height is the feature. The height in particular must never fall: a task handed
 *    back from QA for a fix round is in `implementing` again, and a frame that un-builds itself is
 *    the bug that mapping is written to avoid.
 *
 * 3. THE LIFECYCLE. `nextPhase` is the whole animation state machine in one pure function, so it is
 *    driven through a full task life here rather than watched.
 *
 * 4. THE BLAST RADIUS. The scene ships a stylesheet full of names the console already owns
 *    (`card`, `title`, `badge`, `plot`) and a dozen @keyframes, and animation names are GLOBAL. Every
 *    rule is asserted to sit under `.gs-root` and every keyframe to carry the `gs-` prefix, because
 *    a leak here repaints the real board for an owner who never went idle.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { AgentRun, Thread, ThreadState } from "../src/types.js";
// The screensaver's graph reaches its own stylesheet, which plain Node cannot load. Must precede the
// dynamic imports below (see ssrCssStub.mjs).
import "./ssrCssStub.mjs";

const WEB = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel: string): string => readFileSync(join(WEB, rel), "utf8");

// Standalone tsx gates may compile imported JSX with the classic runtime even though Vite uses the
// automatic one, so React has to be reachable as a global. `localStorage` is what store.ts reads at
// module scope for the view settings.
const stored = new Map<string, string>();
Object.assign(globalThis, {
  React,
  document: { baseURI: "http://localhost/", visibilityState: "visible", hidden: false, addEventListener: () => {}, removeEventListener: () => {} },
  localStorage: {
    getItem: (k: string) => stored.get(k) ?? null,
    setItem: (k: string, v: string) => void stored.set(k, v),
    removeItem: (k: string) => void stored.delete(k),
  },
});

const { useStore, IDLE_MINUTES_MIN, IDLE_MINUTES_MAX } = await import("../src/store.js");
const { buildHeight, buildProgressFor, sceneTasks, targetPhase, MAX_LANES } = await import("../src/components/screensaver/taskScene.js");
const { IMPACT_DX, IMPACT_DY, rigFor, targetFor, workPointAt, pulls, slipAmount, RAPPEL } = await import("../src/components/screensaver/scene.js");
const { Screensaver, nextPhase } = await import("../src/components/screensaver/Screensaver.js");

const results: { label: string; ok: boolean; detail?: string }[] = [];
function check(label: string, ok: boolean, detail?: string): void {
  results.push({ label, ok, detail });
  console.log(`  ${ok ? "\u2713" : "\u2717"} ${label}${!ok && detail ? ` \u2014 ${detail}` : ""}`);
}

const NOW = 1_700_000_000_000;
const thread = (over: Partial<Thread> & { id: string; state: ThreadState }): Thread => ({
  title: `task ${over.id}`,
  workspace: "C:\\Users\\Mikkel\\projects\\garden-gnome-orchestrator",
  createdAt: NOW - 600_000,
  updatedAt: NOW - 1_000,
  ...over,
});
const run = (over: Partial<AgentRun> & { id: string; threadId: string; role: AgentRun["role"] }): AgentRun => ({
  model: "claude-opus-5",
  state: "running",
  startedAt: NOW - 60_000,
  ...over,
});

/* ---- 1. the rigging solver ---------------------------------------------------------------------- */

const geo = { anchorX: 400, plotL: 420, plotT: 600, plotW: 240, plotH: 172.8 };
const ANCHOR_Y = 120;

/** Apply a CSS `rotate(deg)` about the hook to the rig's own impact offset, exactly as the browser
 *  composes `.gs-lean`'s transform over the rope's height. This is the forward model the solver is
 *  the inverse of. */
function impactPoint(len: number, deg: number): { x: number; y: number } {
  const t = (deg * Math.PI) / 180;
  const lx = IMPACT_DX;
  const ly = len + IMPACT_DY;
  return {
    x: geo.anchorX + (lx * Math.cos(t) - ly * Math.sin(t)),
    y: ANCHOR_Y + (lx * Math.sin(t) + ly * Math.cos(t)),
  };
}

let worstMiss = 0;
for (const progress of [0, 0.12, 0.25, 0.4, 0.55, 0.7, 0.85, 1]) {
  const target = targetFor(geo, progress);
  const { len, deg } = rigFor(geo, ANCHOR_Y, target);
  const landed = impactPoint(len, deg);
  worstMiss = Math.max(worstMiss, Math.hypot(landed.x - target.x, landed.y - target.y));
}
check("the solved rope + lean land the tool on the requested point", worstMiss < 1e-6, `worst miss ${worstMiss.toExponential(2)}px`);

// The sign, on its own. A CSS rotate(+t) swings a point hanging BELOW the origin to the LEFT, so a
// gnome reaching further RIGHT must rotate NEGATIVE. He hangs with his tool already IMPACT_DX to the
// right of his rope, so the pivot is that plumb line and not the hook: a target inboard of it really
// does lean him back the other way. Both directions are asserted, plus the monotonicity between
// them, because the reversed sign this catches stays small and plausible near the plumb line and
// only walks the gnome off the far side of the board once he traverses out along his rafter.
const deep = { x: 0, y: ANCHOR_Y + 500 };
const farRight = rigFor(geo, ANCHOR_Y, { ...deep, x: geo.anchorX + IMPACT_DX + 300 }).deg;
const farLeft = rigFor(geo, ANCHOR_Y, { ...deep, x: geo.anchorX + IMPACT_DX - 300 }).deg;
check("reaching right of the plumb line leans him right (a negative CSS rotation)", farRight < 0, `${farRight.toFixed(2)}deg`);
check("reaching left of it leans him back the other way", farLeft > 0, `${farLeft.toFixed(2)}deg`);
check("he hangs plumb when the work is straight below his tool", Math.abs(rigFor(geo, ANCHOR_Y, { ...deep, x: geo.anchorX + IMPACT_DX }).deg) < 1e-9);
const sweep = [-300, -150, -40, 0, 40, 150, 300].map((dx) => rigFor(geo, ANCHOR_Y, { ...deep, x: geo.anchorX + IMPACT_DX + dx }).deg);
check(
  "the lean decreases monotonically as the work moves right",
  sweep.every((d, i) => i === 0 || d < sweep[i - 1]!),
  sweep.map((d) => d.toFixed(1)).join(" > "),
);

// The gnome rises as his own build does: a higher work point means a shorter rope.
const low = rigFor(geo, ANCHOR_Y, targetFor(geo, 0.05)).len;
const high = rigFor(geo, ANCHOR_Y, targetFor(geo, 0.95)).len;
check("the rope shortens as the build gets taller", high < low - 50, `${low.toFixed(1)}px at the sill vs ${high.toFixed(1)}px at the ridge`);

// The work path climbs and traverses: never below where it started, and ending near the ridge.
const path = [0, 0.25, 0.5, 0.75, 1].map((p) => workPointAt(p));
check(
  "the work point climbs monotonically up the frame",
  path.every((pt, i) => i === 0 || pt.y <= path[i - 1]!.y),
  path.map((p) => p.y.toFixed(0)).join(" > "),
);

// The haul out is four hand-over-hand pulls, not one glide: strictly increasing, and stepped.
const pullSamples = Array.from({ length: 21 }, (_, i) => pulls(i / 20));
check(
  "hauling out is monotonic from 0 to 1",
  pullSamples[0] === 0 && pullSamples[20] === 1 && pullSamples.every((v, i) => i === 0 || v >= pullSamples[i - 1]!),
);
// The rope gives way fast, then the belay bites and it settles back.
check("a failure drops fast then settles back", slipAmount(0.35) > slipAmount(1) && slipAmount(1) === 15, `${slipAmount(0.35).toFixed(1)} then ${slipAmount(1)}`);
// The rappel overshoots past the stop before the rope pulls him back: that is the brake bounce.
check("the rappel overshoots before it settles", Math.max(...Array.from({ length: 101 }, (_, i) => RAPPEL(i / 100))) > 1.0);

/* ---- 2. the data mapping ------------------------------------------------------------------------ */

const POSES: [ThreadState, string][] = [
  ["queued", "perched"],
  ["awaiting_user", "perched"],
  ["awaiting_approval", "perched"],
  ["paused", "perched"],
  ["review", "perched"],
  ["planning", "working"],
  ["researching", "working"],
  ["implementing", "working"],
  ["qa", "working"],
  ["reviewing", "working"],
  ["done", "done"],
  ["failed", "failed"],
  ["cancelled", "failed"],
];
const wrongPose = POSES.filter(([state, pose]) => targetPhase(state) !== pose);
check("every task state maps to a pose", wrongPose.length === 0, wrongPose.map(([s]) => s).join(", "));

// A QA hand-back: the task is in `implementing` again, but a QA run already happened. The frame it
// already raised must not come back down.
const handBack = thread({ id: "handback", state: "implementing" });
const handBackRuns = [
  run({ id: "r1", threadId: "handback", role: "planner", state: "done", startedAt: NOW - 900_000, endedAt: NOW - 800_000 }),
  run({ id: "r2", threadId: "handback", role: "implementor", state: "done", startedAt: NOW - 800_000, endedAt: NOW - 400_000 }),
  run({ id: "r3", threadId: "handback", role: "qa", state: "done", startedAt: NOW - 400_000, endedAt: NOW - 300_000 }),
  run({ id: "r4", threadId: "handback", role: "implementor", state: "running", startedAt: NOW - 60_000 }),
];
const afterQa = buildHeight(buildProgressFor(handBack, handBackRuns), NOW);
check("a QA hand-back never un-builds the frame", afterQa >= 0.82, `height ${afterQa.toFixed(3)}`);

// Inside a live stage the frame creeps with the run's real elapsed time and never reaches the next
// stage's ground.
const fresh = thread({ id: "fresh", state: "implementing" });
const freshRun = [run({ id: "f1", threadId: "fresh", role: "implementor", startedAt: NOW - 5_000 })];
const young = buildHeight(buildProgressFor(fresh, freshRun), NOW);
const old = buildHeight(buildProgressFor(fresh, freshRun), NOW + 3_600_000);
check("a longer-running stage has built more", old > young, `${young.toFixed(3)} then ${old.toFixed(3)}`);
check("a live stage never claims the next stage's ground", old < 0.82, `height ${old.toFixed(4)}`);
check("a task with no run yet sits at its stage floor", buildHeight(buildProgressFor(fresh, []), NOW) === 0.44);
check("done is the only state that reads a finished frame", buildHeight(buildProgressFor(thread({ id: "d", state: "done" }), []), NOW) === 1);

// A finished run's clock stops: the frame does not keep creeping after the stage ended.
const stopped = [run({ id: "s1", threadId: "fresh", role: "implementor", state: "done", startedAt: NOW - 120_000, endedAt: NOW - 60_000 })];
const frozenA = buildHeight(buildProgressFor(fresh, stopped), NOW);
const frozenB = buildHeight(buildProgressFor(fresh, stopped), NOW + 600_000);
check("a finished run's frame stops growing", frozenA === frozenB, `${frozenA} vs ${frozenB}`);

// The cast: live work first, collaborators and closed tasks off stage, capped at MAX_LANES.
const threads: Record<string, Thread> = {};
for (let i = 0; i < 4; i++) threads[`q${i}`] = thread({ id: `q${i}`, state: "queued", createdAt: NOW - 500_000 + i });
threads["live"] = thread({ id: "live", state: "implementing", createdAt: NOW - 100 });
threads["kid"] = thread({ id: "kid", state: "implementing", parentId: "live" });
threads["gone"] = thread({ id: "gone", state: "closed" });
threads["fin"] = thread({ id: "fin", state: "done", createdAt: NOW - 900_000 });
const cast = sceneTasks(threads, { x: run({ id: "x", threadId: "live", role: "implementor" }) }, {});
check("live work takes the first lane", cast[0]?.id === "live", cast.map((t) => t.id).join(","));
check("a collaborator never gets its own lane", !cast.some((t) => t.id === "kid"));
check("a closed task is off the board", !cast.some((t) => t.id === "gone"));
check("a finished task ranks behind the waiting ones", cast[cast.length - 1]?.id === "fin", cast.map((t) => t.id).join(","));
check("the beam is capped at MAX_LANES", sceneTasks(threads, {}, {}, 2).length === 2 && cast.length <= MAX_LANES);

// The role a lane wears, and the tool that comes with it.
const roleCast = sceneTasks(
  { a: thread({ id: "a", state: "qa" }), b: thread({ id: "b", state: "review" }), c: thread({ id: "c", state: "queued", lane: "read" }) },
  { r: run({ id: "r", threadId: "b", role: "reviewer", state: "done", endedAt: NOW - 1000 }) },
  {},
);
const byId = new Map(roleCast.map((t) => [t.id, t]));
check("a live stage names its own role", byId.get("a")?.role === "qa" && byId.get("a")?.tool === "wrench");
check("a parked task keeps the role that last worked it", byId.get("b")?.role === "reviewer" && byId.get("b")?.tool === "gavel");
check("a read-lane task with no run yet is a reader", byId.get("c")?.role === "reader");

// The activity line is the agent's own live text when there is any, and the brief otherwise.
const narrated = sceneTasks(
  { a: thread({ id: "a", state: "implementing", briefPreview: "from the brief" }) },
  {},
  { a: "- checked the first thing\n- now the second thing" },
);
check("a working lane narrates the live agent stream", narrated[0]?.activity === "now the second thing", narrated[0]?.activity);
const quiet = sceneTasks({ a: thread({ id: "a", state: "queued", briefPreview: "from the brief" }) }, {}, {});
check("a silent lane falls back to the brief", quiet[0]?.activity === "from the brief", quiet[0]?.activity);
check("the card shows the repo leaf, not the whole path", quiet[0]?.workspace === "garden-gnome-orchestrator", quiet[0]?.workspace);

/* ---- 3. the lifecycle --------------------------------------------------------------------------- */

// A task's whole life, driven through the state machine the way the render loop drives it.
check("a queued gnome stays on the beam", nextPhase("perched", "perched", 99) === "perched");
check("work starting sends him down the rope", nextPhase("perched", "working", 0) === "descending");
check("the rappel takes its full time", nextPhase("descending", "working", 0.5) === "descending");
check("then he is working", nextPhase("descending", "working", 2) === "working");
check("finishing hauls him out first", nextPhase("working", "done", 0) === "ascending");
check("the haul takes its full time", nextPhase("ascending", "done", 0.2) === "ascending");
check("and lands him back on the beam, finished", nextPhase("ascending", "done", 5) === "done");
check("a handoff parks him back on the beam", nextPhase("ascending", "perched", 5) === "perched");
check("work restarting mid-haul turns him round", nextPhase("ascending", "working", 0.2) === "descending");
check("a failure interrupts a swing immediately", nextPhase("working", "failed", 0) === "failed");
check("a failure interrupts a rappel immediately", nextPhase("descending", "failed", 0.1) === "failed");
check("a failed lane holds its pose", nextPhase("failed", "failed", 999) === "failed");
check("a retried task rappels back in", nextPhase("failed", "working", 0) === "descending");
check("a done lane restarted goes back down", nextPhase("done", "working", 0) === "descending");

/* ---- 4. the settings ---------------------------------------------------------------------------- */

const store = useStore.getState();
check("the screensaver is on by default", store.screensaver === true);
check("the default wait is five minutes", store.screensaverIdleMinutes === 5);

store.setScreensaverIdleMinutes(12);
check("an idle delay persists", useStore.getState().screensaverIdleMinutes === 12);
store.setScreensaver(false);
check("switching it off persists", useStore.getState().screensaver === false);
check(
  "both settings share the console's one view-settings record",
  JSON.parse(stored.get("director_settings") ?? "{}").screensaverIdleMinutes === 12 &&
    JSON.parse(stored.get("director_settings") ?? "{}").screensaver === false,
  stored.get("director_settings"),
);
check(
  "the other view settings survive a screensaver write",
  JSON.parse(stored.get("director_settings") ?? "{}").theme === "classic" &&
    JSON.parse(stored.get("director_settings") ?? "{}").verbosity === "full",
  stored.get("director_settings"),
);
useStore.getState().setScreensaverIdleMinutes(0);
check("an impossible delay clamps rather than disabling the feature", useStore.getState().screensaverIdleMinutes === IDLE_MINUTES_MIN);
useStore.getState().setScreensaverIdleMinutes(99_999);
check("an absurd delay clamps to the ceiling", useStore.getState().screensaverIdleMinutes === IDLE_MINUTES_MAX);
useStore.getState().setScreensaverIdleMinutes(5);
useStore.getState().setScreensaver(true);

// The Settings panel is categorized, so a control outside a category panel renders on every page.
const panel = read("src/components/SettingsPanel.tsx");
check("the screensaver rows live inside the Appearance page", /Group label="Screensaver"/.test(panel) && panel.indexOf('Group label="Screensaver"') > panel.indexOf('<SettingsCategoryPanel id="appearance"'));
check("settings search can find it", /keywords: "[^"]*screensaver[^"]*"/.test(panel));

/* ---- 5. it renders ------------------------------------------------------------------------------ */

// `renderToStaticMarkup` reads a zustand store through `getServerSnapshot`, which is
// `getInitialState()` — so a `setState` here would render an empty board and look like the scene was
// broken. Every other SSR gate in this directory seeds the same way.
Object.assign(useStore.getInitialState(), {
  threads: {
    a: thread({ id: "a", state: "implementing", title: "Rope physics for the office gnomes" }),
    b: thread({ id: "b", state: "queued", title: "Audit the deliverable path guard" }),
    c: thread({ id: "c", state: "done", title: "Fix the fullscreen lag on the board" }),
    d: thread({ id: "d", state: "failed", title: "Wire the notes text bridge" }),
  },
  runs: { r1: run({ id: "r1", threadId: "a", role: "implementor" }) },
  threadDrafts: {},
});
const markup = renderToStaticMarkup(React.createElement(Screensaver));
check("the scene renders a lane per task", (markup.match(/class="gs-card"/g) ?? []).length === 4, markup.slice(0, 120));
check("each lane gets a worker on the beam", (markup.match(/class="gs-worker gs-t-/g) ?? []).length === 4);
check("the implementor swings a hammer", markup.includes("gs-worker gs-t-hammer"));
check("the queued planner holds a saw", markup.includes("gs-worker gs-t-saw"));
check("every card carries the full thirteen-piece build", (markup.match(/gs-b-piece/g) ?? []).length === 4 * 13);
check("a task's real title is on its card", markup.includes("Rope physics for the office gnomes"));
check("a task's real state is on its badge", markup.includes(">implementing<") && markup.includes(">failed<"));
check("nothing in the scene is focusable or clickable", !/<(?:button|a |input|select)/.test(markup));
check("the scene is inert to assistive tech", markup.includes('role="presentation"'));

Object.assign(useStore.getInitialState(), { threads: {}, runs: {} });
const bare = renderToStaticMarkup(React.createElement(Screensaver));
check("an empty board still shows the beam", bare.includes("gs-beam"));
check("an empty board says so instead of drawing nothing", bare.includes("gs-empty") && !bare.includes('class="gs-card"'));

/* ---- 6. the blast radius ------------------------------------------------------------------------ */

const sheet = read("src/components/screensaver/screensaver.css");

/** Selectors of every style rule, skipping keyframe steps (`0%`, `from`) which are not selectors. */
function selectors(css: string): string[] {
  const src = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const out: string[] = [];
  const stack: (string | null)[] = [];
  let prelude = "";
  for (const ch of src) {
    if (ch === "{") {
      const head = prelude.trim();
      const inKeyframes = stack.some((a) => a?.startsWith("@keyframes"));
      if (head.startsWith("@")) stack.push(head);
      else {
        if (!inKeyframes) for (const sel of head.split(",")) out.push(sel.trim());
        stack.push(null);
      }
      prelude = "";
    } else if (ch === "}") {
      stack.pop();
      prelude = "";
    } else {
      prelude += ch;
    }
  }
  assert.equal(stack.length, 0, "unbalanced braces in screensaver.css");
  return out;
}

const escaped = selectors(sheet).filter((s) => !s.startsWith(".gs-root"));
check("every rule is scoped under .gs-root", escaped.length === 0, escaped.join(" | "));

const ownKeyframes = Array.from(sheet.matchAll(/@keyframes\s+([A-Za-z0-9_-]+)/g), (m) => m[1]!);
check("the scene declares keyframes at all", ownKeyframes.length > 10, String(ownKeyframes.length));
check("every keyframe carries the gs- prefix", ownKeyframes.every((n) => n.startsWith("gs-")), ownKeyframes.filter((n) => !n.startsWith("gs-")).join(", "));

// Animation names are global, so a collision silently re-animates something on the real console.
const OTHER_SHEETS = [
  "src/styles.css",
  "src/themes/nocturne.css",
  "src/components/codeContext.css",
  "src/components/diff.css",
  "src/components/gitChanges.css",
  "src/components/gitConsole.css",
];
const taken = new Set(OTHER_SHEETS.flatMap((rel) => Array.from(read(rel).matchAll(/@keyframes\s+([A-Za-z0-9_-]+)/g), (m) => m[1]!)));
const collisions = ownKeyframes.filter((n) => taken.has(n));
check("no keyframe name collides with the console's own", collisions.length === 0, collisions.join(", "));

// The console's tokens must not be redefined: the scene EXTENDS the palette, it does not replace it.
const rootBlock = sheet.slice(sheet.indexOf(".gs-root {"), sheet.indexOf("}", sheet.indexOf(".gs-root {")));
const declared = Array.from(rootBlock.matchAll(/(--[a-z0-9-]+)\s*:/g), (m) => m[1]!);
check("every token the scene declares is namespaced", declared.every((n) => n.startsWith("--gs-")), declared.filter((n) => !n.startsWith("--gs-")).join(", "));
check("the scene never redefines a console token", !/^\s*:root\s*\{/m.test(sheet.replace(/\/\*[\s\S]*?\*\//g, "")));

// The accent, role and state hues are read through var(), so a theme retints the whole scene.
check("the pennant flies the console's accent", /\.gs-b-pennant\s*\{\s*fill:\s*var\(--accent\)/.test(sheet));
check("styles.css is left alone", !read("src/styles.css").includes("gs-root"));

/* ---- summary ------------------------------------------------------------------------------------ */

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length} passed, ${failed.length} failed`);
if (failed.length) {
  console.log("\nFailures:");
  for (const f of failed) console.log(`  - ${f.label}${f.detail ? ` (${f.detail})` : ""}`);
  process.exit(1);
}
console.log("Screensaver gate passed - solver, live-data mapping, lifecycle, settings and CSS scoping all hold.");
