import { journeyProgress } from "./workshopStage.js";

/** One left-right stride. Matches the pace of the 12s loop's own footfalls. */
const STRIDE_MS = 440;

/** A walk cycle layered on top of whatever the gnome's CSS loop is doing (composite "add"), so the
 *  loop keeps its phase and nothing restarts when the walk ends. Script animations only: they run
 *  for one walk and need no React state. */
export function stride(actor: HTMLElement, dx: number, ms: number): Animation[] {
  const strides = Math.max(1, Math.round(ms / STRIDE_MS));
  const step = { duration: ms / strides, iterations: strides, easing: "linear" };
  const played: Animation[] = [];
  const play = (selector: string, keyframes: Keyframe[], options: KeyframeAnimationOptions) => {
    actor.querySelectorAll<HTMLElement>(selector).forEach((element) => played.push(element.animate(keyframes, options)));
  };
  play(".beta-gnome-body", [{ translate: "0 0" }, { translate: "0 -1.5px" }, { translate: "0 0" }],
    { ...step, duration: step.duration / 2, iterations: strides * 2, composite: "add" });
  play(".beta-boot-left, .gnome-boot-left", [{ rotate: "0deg", offset: 0 }, { rotate: "-22deg", translate: "-1px -1px", offset: 0.25 }, { rotate: "0deg", translate: "0 0", offset: 0.5 }, { rotate: "0deg", offset: 1 }],
    { ...step, composite: "add" });
  play(".beta-boot-right, .gnome-boot-right", [{ rotate: "0deg", offset: 0 }, { rotate: "0deg", translate: "0 0", offset: 0.5 }, { rotate: "22deg", translate: "1px -1px", offset: 0.75 }, { rotate: "0deg", offset: 1 }],
    { ...step, composite: "add" });
  // Down the floor or back up it, a gnome faces the way it walks; straight forward it faces us.
  if (Math.abs(dx) > 6) play(".beta-character", [{ transform: `scaleX(${Math.sign(dx)})` }, { transform: `scaleX(${Math.sign(dx)})` }], { duration: ms });
  // Work is set down for the walk and picked up again on arrival.
  const set = Math.min(0.2, 160 / ms);
  play(".beta-tool, .gnome-prop", [{ opacity: 1 }, { opacity: 0, offset: set }, { opacity: 0, offset: 1 - set }, { opacity: 1 }], { duration: ms });
  return played;
}

/** The 12s loop walks a gnome `travel` px toward its teammate. When a lane change gives it a new
 *  partner (or none), glide from where the old travel had it to where the new one does instead of
 *  jumping there. */
export function bridgeJourney(button: HTMLElement, from: number, to: number): Animation | undefined {
  const loop = button.getAnimations().find((animation) => (animation as CSSAnimation).animationName === "beta-journey");
  const progress = loop?.effect?.getComputedTiming().progress;
  if (progress == null) return undefined;
  const offset = journeyProgress(progress) * (from - to);
  if (Math.abs(offset) < 0.5) return undefined;
  return button.animate([{ translate: `${offset}px 0` }, { translate: "0 0" }], { duration: 650, easing: "cubic-bezier(.3,0,.2,1)", composite: "add" });
}

/** Reduced motion: arrive by a short fade instead of a walk. */
export function fadeIn(actor: HTMLElement) {
  actor.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 220, easing: "ease-out" });
}
