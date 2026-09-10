/* Screensaver.tsx: the AFK scene.
 *
 * When nobody has touched the console for a while, the board is replaced by the scaffold: one gnome
 * per task, rappelling in off a beam and raising a timber frame that grows with the task's real
 * progress. Any input dismisses it (see useIdle), and nothing underneath is touched, because this
 * overlay only ever reads the store.
 *
 * WHY THE RENDER LOOP IS IMPERATIVE. React owns the CAST: which lanes exist, which tool each gnome
 * holds, what its card says. The frame-by-frame numbers (rope length, lean angle, which timbers are
 * up) are written straight to the DOM by one rAF loop instead of through state, because they change
 * sixty times a second and re-rendering six cards that often to move two transforms is the one thing
 * a screensaver may not do. The loop touches a node only when the value it would write has actually
 * changed, which is what `applied` on each lane records.
 *
 * COST WHEN IDLE. The loop does not exist unless the scene is on screen, and it stops entirely while
 * the tab is hidden or the browser asks for reduced motion. In the reduced-motion case every lane is
 * still POSED correctly (the gnome hangs at the right depth on the right rope, the right timbers are
 * up); only the loops are gone, which is what the media query at the bottom of screensaver.css and
 * the single static pass below implement together.
 */

import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, type CSSProperties } from "react";
import { useStore } from "../../store.js";
import { roleColor } from "../../lib/format.js";
import { DroppedTool, GROUND_Y, PLOT_VB, Plot, Rig, TOOL_MOTION } from "./rig.js";
import {
  ASCEND,
  DESCEND,
  DROP_LEFT,
  DROP_TOP,
  DROP_W,
  EASE_IO,
  GUTTER,
  RAPPEL,
  SLIP,
  SWING_IN,
  pulls,
  rigFor,
  slipAmount,
  swayFor,
  targetFor,
  type CardGeometry,
} from "./scene.js";
import { buildHeight, sceneTasks, type SceneTask, type TargetPhase } from "./taskScene.js";
import { useDocumentHidden, usePrefersReducedMotion } from "./useIdle.js";
import "./screensaver.css";

/** The pose a lane is actually in: the phase the live data asks for, plus the two transitions
 *  between them, because a gnome does not teleport off the beam onto his work, he rappels. */
export type AnimPhase = TargetPhase | "descending" | "ascending";

/** The class the worker element wears per pose. `gs-moving` covers both transitions: the arm holds a
 *  braced pose and JS drives the rope, so there is nothing to tell them apart in CSS. */
const PHASE_CLASS: Record<AnimPhase, string[]> = {
  perched: ["gs-perched"],
  working: ["gs-working"],
  done: ["gs-perched", "gs-done"],
  failed: ["gs-failed"],
  descending: ["gs-moving"],
  ascending: ["gs-moving"],
};

const ALL_PHASE_CLASSES = ["gs-perched", "gs-working", "gs-done", "gs-failed", "gs-moving"];

/** How long the transition out of a phase takes, in seconds. A resting phase has no clock. */
const PHASE_SECONDS: Record<AnimPhase, number> = {
  descending: DESCEND,
  ascending: ASCEND,
  failed: SLIP,
  perched: 0,
  working: 0,
  done: 0,
};

/** The half of a lane that hangs off the beam. */
interface WorkerParts {
  worker: HTMLElement;
  lean: HTMLElement;
  rope: HTMLElement;
  dropped: HTMLElement;
}

/** The half of a lane that sits on the board. */
interface CardParts {
  card: HTMLElement;
  plot: HTMLElement;
  pieces: HTMLElement[];
  elapsed: HTMLElement;
}

/** One lane's nodes, its pose, and the last values written to it. */
interface Lane extends WorkerParts, CardParts {
  geo: CardGeometry | null;
  phase: AnimPhase;
  /** When the current phase began, in ms, so a transition can be interpolated. */
  since: number;
  applied: { phase: string; pieces: number; snapped: number; len: number; deg: number; elapsed: string };
}

const mmss = (ms: number): string => {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
};

/**
 * The pose a lane should move to next, given where it is, what the live data now says, and how long
 * it has held the current pose.
 *
 * This one function is the whole lifecycle: a task that starts while the scene is up rappels in, one
 * that finishes is hauled out hand over hand and then tips its hat, one that fails slips on the rope
 * from wherever it was. Returning the SAME phase means "not yet", which is what lets the caller
 * settle a lane by iterating until it stops changing.
 */
export function nextPhase(phase: AnimPhase, target: TargetPhase, elapsedSec: number): AnimPhase {
  // A failure interrupts anything: the rope goes before the gnome has any say in it.
  if (target === "failed" && phase !== "failed") return "failed";

  switch (phase) {
    case "descending":
      if (target !== "working") return "ascending";
      return elapsedSec >= DESCEND ? "working" : "descending";
    case "ascending":
      if (target === "working") return "descending";
      return elapsedSec >= ASCEND ? (target === "done" ? "done" : "perched") : "ascending";
    case "working":
      return target === "working" ? "working" : "ascending";
    default:
      // perched / done / failed: a resting pose only leaves when the data does.
      return target === "working" ? "descending" : target;
  }
}

/** Where a lane starts the first time it appears. Work already in flight when the scene opens
 *  rappels in, which is how the whole board arrives rather than snapping into place. */
const initialPhase = (target: TargetPhase): AnimPhase => (target === "working" ? "descending" : target);

export function Screensaver() {
  // One subscription per collection. Each is replaced by reference only when it really changes, so
  // the cast is rebuilt on a task/run/stream update and on nothing else.
  const threads = useStore((s) => s.threads);
  const runs = useStore((s) => s.runs);
  const drafts = useStore((s) => s.threadDrafts);
  const tasks = useMemo(() => {
    const text: Record<string, string | undefined> = {};
    for (const [id, draft] of Object.entries(drafts)) text[id] = draft?.text;
    return sceneTasks(threads, runs, text);
  }, [threads, runs, drafts]);

  const reducedMotion = usePrefersReducedMotion();
  const hidden = useDocumentHidden();

  const rootRef = useRef<HTMLDivElement>(null);
  const beamRef = useRef<HTMLDivElement>(null);
  const lanes = useRef(new Map<string, Lane>());
  const workerParts = useRef(new Map<string, WorkerParts>());
  const cardParts = useRef(new Map<string, CardParts>());
  // The loop reads the newest cast through refs, so a store update never has to restart it.
  const tasksRef = useRef(tasks);
  tasksRef.current = tasks;
  const snapRef = useRef(reducedMotion);
  snapRef.current = reducedMotion;
  const anchorY = useRef(0);

  /** Join the two halves of a lane once both have mounted, preserving the pose of a lane that is
   *  only re-registering (a tool change replaces the rig's SVG, which detaches the cached nodes). */
  const link = useCallback((id: string) => {
    const worker = workerParts.current.get(id);
    const card = cardParts.current.get(id);
    if (!worker || !card) {
      lanes.current.delete(id);
      return;
    }
    const existing = lanes.current.get(id);
    const target = tasksRef.current.find((t) => t.id === id)?.target ?? "perched";
    lanes.current.set(id, {
      ...worker,
      ...card,
      geo: existing?.geo ?? null,
      phase: existing?.phase ?? initialPhase(target),
      since: existing?.since ?? Date.now(),
      // Every "last written" value is deliberately impossible, so the first frame writes everything.
      applied: { phase: "", pieces: -1, snapped: -2, len: -1, deg: NaN, elapsed: "" },
    });
  }, []);

  const registerWorker = useCallback(
    (id: string, parts: WorkerParts | null) => {
      if (parts) workerParts.current.set(id, parts);
      else workerParts.current.delete(id);
      link(id);
    },
    [link],
  );

  const registerCard = useCallback(
    (id: string, parts: CardParts | null) => {
      if (parts) cardParts.current.set(id, parts);
      else cardParts.current.delete(id);
      link(id);
    },
    [link],
  );

  /** Re-read the layout: where the beam's underside is, and where each card's build plot sits. The
   *  rigging solves against these, so they are re-measured whenever the cast or the viewport
   *  changes rather than cached from mount. */
  const measure = useCallback(() => {
    const root = rootRef.current;
    const beam = beamRef.current;
    if (!root || !beam) return;
    const scene = root.getBoundingClientRect();
    anchorY.current = beam.getBoundingClientRect().bottom - scene.top;
    for (const lane of lanes.current.values()) {
      const card = lane.card.getBoundingClientRect();
      const plot = lane.plot.getBoundingClientRect();
      lane.geo = {
        anchorX: card.left - scene.left - GUTTER,
        plotL: plot.left - scene.left,
        plotT: plot.top - scene.top,
        plotW: plot.width,
        plotH: plot.height,
      };
      lane.worker.style.left = `${lane.geo.anchorX}px`;
      lane.worker.style.top = `${anchorY.current}px`;
      // The falling tool is placed from the rig frame rather than from hand-tuned pixels, so it
      // leaves the mitt at exactly the size and spot it was being swung at.
      lane.dropped.style.left = `${DROP_LEFT.toFixed(2)}px`;
      lane.dropped.style.width = `${DROP_W.toFixed(2)}px`;
    }
  }, []);

  /** One frame. `now` is wall-clock ms, because every input (a run's start, a task's last update) is
   *  wall-clock too; `instant` suppresses the piece-landing transition for the first pass after a
   *  layout change, so opening the scene does not fly thirteen timbers in at once. */
  const paint = useCallback((now: number, instant: boolean) => {
    for (const task of tasksRef.current) {
      const lane = lanes.current.get(task.id);
      if (!lane || !lane.geo) continue;

      // ---- pose ----
      // Settle rather than step: one frame may cross a whole transition (a tab that was hidden for
      // an hour), and a reduced-motion console skips the transitions entirely.
      if (snapRef.current) {
        lane.phase = task.target;
      } else {
        for (let i = 0; i < ALL_PHASE_CLASSES.length; i++) {
          const next = nextPhase(lane.phase, task.target, (now - lane.since) / 1000);
          if (next === lane.phase) break;
          lane.phase = next;
          lane.since = now;
        }
      }
      const phase = lane.phase;
      const span = PHASE_SECONDS[phase];
      const u = span > 0 ? Math.min(1, (now - lane.since) / 1000 / span) : 1;

      // ---- rigging ----
      const progress = buildHeight(task.build, now);
      const work = rigFor(lane.geo, anchorY.current, targetFor(lane.geo, progress));
      let len = work.len;
      let deg = work.deg;
      switch (phase) {
        case "perched":
        case "done":
          len = 0;
          deg = 0;
          break;
        case "descending":
          len = work.len * RAPPEL(u);
          deg = work.deg * SWING_IN(u);
          break;
        case "ascending":
          len = work.len * (1 - pulls(u));
          deg = work.deg * (1 - EASE_IO(u));
          break;
        case "failed":
          len = work.len + slipAmount(u);
          break;
        default:
          break;
      }

      const phaseClass = PHASE_CLASS[phase].join(" ");
      if (phaseClass !== lane.applied.phase) {
        lane.worker.classList.remove(...ALL_PHASE_CLASSES);
        lane.worker.classList.add(...PHASE_CLASS[phase]);
        lane.applied.phase = phaseClass;
        const sway = swayFor(Math.max(len, 40));
        lane.worker.style.setProperty("--gs-sway-dur", `${sway.dur.toFixed(2)}s`);
        lane.worker.style.setProperty("--gs-sway-amp", `${sway.amp.toFixed(2)}deg`);
        // Let go of the tool exactly once, when the failure happens.
        if (phase === "failed") {
          const ground = lane.geo.plotT + (GROUND_Y / PLOT_VB.h) * lane.geo.plotH;
          lane.dropped.style.top = `${len + DROP_TOP}px`;
          lane.dropped.style.setProperty("--gs-fall", `${Math.max(0, ground - (anchorY.current + len + DROP_TOP))}px`);
          lane.dropped.classList.remove("gs-falling");
          void lane.dropped.offsetWidth; // restart the fall if this lane has failed before
          lane.dropped.classList.add("gs-falling");
        } else {
          lane.dropped.classList.remove("gs-falling");
        }
      }

      // Rounded before comparing: a sub-tenth-of-a-pixel rope is not a visible change, and writing
      // it anyway is what turns an idle scene into sixty style recalculations a second.
      const lenPx = Math.round(len * 10) / 10;
      const degRounded = Math.round(deg * 100) / 100;
      if (lenPx !== lane.applied.len) {
        lane.rope.style.height = `${lenPx}px`;
        lane.applied.len = lenPx;
      }
      if (degRounded !== lane.applied.deg) {
        lane.lean.style.transform = `rotate(${degRounded}deg)`;
        lane.applied.deg = degRounded;
      }

      // ---- the build ----
      // A task that has never started shows bare ground, not a sill plate it did not lay.
      const shown = task.startedAt == null ? -1 : progress;
      const onCount = lane.pieces.reduce((n, p) => (shown >= Number(p.dataset.at) ? n + 1 : n), 0);
      if (onCount !== lane.applied.pieces || instant) {
        if (instant) lane.plot.classList.add("gs-instant");
        lane.pieces.forEach((p) => p.classList.toggle("gs-on", shown >= Number(p.dataset.at)));
        if (instant) requestAnimationFrame(() => lane.plot.classList.remove("gs-instant"));
        lane.applied.pieces = onCount;
      }
      // The piece he was working on when it went wrong lets go and leans.
      const snapIndex = phase === "failed" ? onCount - 1 : -1;
      if (snapIndex !== lane.applied.snapped) {
        lane.pieces.forEach((p, i) => p.classList.toggle("gs-snapped", i === snapIndex));
        lane.applied.snapped = snapIndex;
      }
      lane.plot.classList.toggle("gs-plot-failed", phase === "failed");
      lane.plot.classList.toggle("gs-plot-done", phase === "done");

      // ---- the clock ----
      const text = task.startedAt == null ? "--:--" : mmss((task.endedAt ?? now) - task.startedAt);
      if (text !== lane.applied.elapsed) {
        lane.elapsed.textContent = text;
        lane.applied.elapsed = text;
      }
    }
  }, []);

  // Measure before the first paint, and again whenever the cast changes the layout.
  const laneKey = tasks.map((t) => t.id).join("\n");
  useLayoutEffect(() => {
    measure();
    paint(Date.now(), true);
  }, [laneKey, measure, paint]);

  useEffect(() => {
    const onResize = (): void => {
      measure();
      paint(Date.now(), true);
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [measure, paint]);

  // Reduced motion still needs a pass whenever the data changes, since there is no loop to pick it
  // up. Cheap: it is one write per lane per store update, not per frame.
  useEffect(() => {
    if (!reducedMotion) return;
    paint(Date.now(), true);
  }, [reducedMotion, tasks, paint]);

  // The loop itself. It exists only while the scene is visible and motion is wanted: a hidden tab or
  // a reduced-motion browser gets the static passes above and nothing else.
  useEffect(() => {
    if (reducedMotion || hidden) return;
    // Coming back from a hidden tab, the poses are minutes stale, so restart every transition clock
    // and settle without animating before the loop takes over.
    for (const lane of lanes.current.values()) lane.since = Date.now();
    measure();
    paint(Date.now(), true);

    let raf = 0;
    const frame = (): void => {
      paint(Date.now(), false);
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [reducedMotion, hidden, measure, paint]);

  return (
    <div className="gs-root" ref={rootRef} role="presentation" data-screensaver="on">
      {/* The scaffold beam. Every rope hangs off it, and it is where a gnome sits when it has
          nothing to build yet, or has finished. */}
      <div className="gs-beam" ref={beamRef} aria-hidden="true">
        <span className="gs-beam-grain" />
      </div>
      <div className="gs-cards">
        {tasks.map((task) => (
          <LaneCard key={task.id} task={task} register={registerCard} />
        ))}
      </div>
      {/* Ropes and gnomes live above the cards so boots can dangle over a card edge. */}
      <div className="gs-workers" aria-hidden="true">
        {tasks.map((task) => (
          <LaneWorker key={task.id} task={task} register={registerWorker} />
        ))}
      </div>
      {tasks.length === 0 ? <p className="gs-empty">The board is clear. The crew is on the beam.</p> : null}
      <p className="gs-hint">move the mouse or press any key</p>
    </div>
  );
}

/** Only the fields the card actually prints. The lane object is rebuilt on every store update (its
 *  build descriptor carries live timestamps), so without this every streamed token would re-render
 *  six cards and their thirteen-piece SVGs. */
const sameCard = (a: { task: SceneTask }, b: { task: SceneTask }): boolean =>
  a.task.id === b.task.id &&
  a.task.title === b.task.title &&
  a.task.workspace === b.task.workspace &&
  a.task.role === b.task.role &&
  a.task.badge === b.task.badge &&
  a.task.stateColor === b.task.stateColor &&
  a.task.activity === b.task.activity;

const LaneCard = memo(function LaneCard({
  task,
  register,
}: {
  task: SceneTask;
  register: (id: string, parts: CardParts | null) => void;
}) {
  const ref = useRef<HTMLElement>(null);
  const { id } = task;

  useLayoutEffect(() => {
    const card = ref.current;
    if (!card) return;
    register(id, {
      card,
      plot: card.querySelector<HTMLElement>(".gs-plot")!,
      pieces: Array.from(card.querySelectorAll<HTMLElement>(".gs-b-piece")),
      elapsed: card.querySelector<HTMLElement>(".gs-elapsed")!,
    });
    return () => register(id, null);
  }, [id, register]);

  return (
    <article className="gs-card" ref={ref} style={{ "--gs-state": task.stateColor } as CSSProperties} data-task={id}>
      <div className="gs-title">{task.title}</div>
      <div className="gs-ws">{task.workspace}</div>
      <div className="gs-plot">
        <Plot />
      </div>
      <div className="gs-activity">{task.activity}</div>
      <div className="gs-foot">
        <span className="gs-badge">{task.badge}</span>
        <span className="gs-rolechip" style={{ "--gs-role": roleColor(task.role) } as CSSProperties}>
          <i />
          {task.role}
        </span>
        <span className="gs-elapsed">--:--</span>
      </div>
    </article>
  );
},
sameCard);

/** A worker is a zero-size anchor pinned under its hook on the beam; everything below hangs from it. */
const LaneWorker = memo(
  function LaneWorker({ task, register }: { task: SceneTask; register: (id: string, parts: WorkerParts | null) => void }) {
    const ref = useRef<HTMLDivElement>(null);
    const { id, tool, role } = task;
    const motion = TOOL_MOTION[tool];

    useLayoutEffect(() => {
      const worker = ref.current;
      if (!worker) return;
      register(id, {
        worker,
        lean: worker.querySelector<HTMLElement>(".gs-lean")!,
        rope: worker.querySelector<HTMLElement>(".gs-rope")!,
        dropped: worker.querySelector<HTMLElement>(".gs-dropped")!,
      });
      return () => register(id, null);
      // Re-registering on a tool change is load-bearing: React replaces the rig's SVG, so the cached
      // nodes would otherwise be detached elements nothing on screen reads.
    }, [id, tool, register]);

    return (
      <div
        className={`gs-worker gs-t-${tool}`}
        ref={ref}
        style={
          {
            color: roleColor(role),
            "--gs-tool-dur": `${motion.dur}s`,
            "--gs-impact-frac": motion.impact,
          } as CSSProperties
        }
      >
        <span className="gs-hook" />
        <div className="gs-lean">
          <div className="gs-sway">
            <div className="gs-recoil">
              <div className="gs-rope" />
              <div className="gs-rig">
                <Rig tool={tool} />
              </div>
            </div>
          </div>
        </div>
        <div className="gs-dropped">
          <DroppedTool tool={tool} />
        </div>
      </div>
    );
  },
  (a, b) => a.task.id === b.task.id && a.task.tool === b.task.tool && a.task.role === b.task.role,
);
