import type { ClientMessage } from "./streamClient.js";

type Send = (message: ClientMessage) => void;
type Point = { x: number; y: number };
type Button = "left" | "right" | "middle" | "back" | "forward";

const MOUSE_BUTTONS: Button[] = ["left", "middle", "right", "back", "forward"];
const MAX_ZOOM = 5;
const TAP_SLOP_PX = 10;
const LONG_PRESS_MS = 550;
// A second tap this close in time and space lands exactly on the first, so Windows sees a double-click
// even though a fingertip never hits the same pixel twice.
const DOUBLE_TAP_MS = 450;
const DOUBLE_TAP_SLOP_PX = 32;
const PINCH_DECIDE_PX = 22;
const SCROLL_DECIDE_PX = 10;
const TWO_FINGER_TAP_MS = 300;
// Windows scrolls 120 units per wheel notch; a notch in the browser is ~100 CSS px.
const WHEEL_UNITS_PER_PX = 1.2;
const TOUCH_SCROLL_UNITS_PER_PX = 3;

interface Touch { id: number; start: Point; at: Point; startedAt: number }

type Gesture =
  | { kind: "idle" }
  | { kind: "pending"; touch: Touch; longPress: number }
  | { kind: "drag" }
  | { kind: "consumed" }
  | { kind: "two"; startedAt: number; mode: "undecided" | "zoom" | "scroll"; dist0: number; mid0: Point; lastMid: Point; zoom0: number; pan0: Point; scrollCarry: number; scrollCarryX: number };

/**
 * The viewer's drawing surface: letterboxes the canvas inside the stage, owns the local zoom and pan,
 * and turns mouse, pen, and touch input into remote mouse events. Positions leave as fractions of the
 * video, so the server maps them onto the real display whatever the scaling in between.
 *
 * Touch is direct: tap clicks, a long press right-clicks, one finger drags, two fingers scroll, and a
 * pinch zooms the local view (pan by moving the pinch).
 */
export class RemoteSurface {
  private video = { width: 16, height: 9 };
  private base = { left: 0, top: 0, width: 0, height: 0 };
  private zoom = 1;
  private pan: Point = { x: 0, y: 0 };
  private touches = new Map<number, Touch>();
  private gesture: Gesture = { kind: "idle" };
  private lastTap: { at: number; client: Point; video: Point } | null = null;
  private pendingMove: Point | null = null;
  private moveFrame: number | null = null;
  private wheelCarry = { x: 0, y: 0 };
  private readonly resize = new ResizeObserver(() => this.layout());
  private readonly detach: () => void;

  constructor(
    private readonly stage: HTMLElement,
    private readonly canvas: HTMLCanvasElement,
    private readonly send: Send,
    private readonly onZoomChange: (zoomed: boolean) => void,
    private readonly onMouseFocus: () => void,
  ) {
    this.resize.observe(stage);
    const listeners: [string, EventListener, AddEventListenerOptions?][] = [
      ["pointerdown", (e) => this.onPointerDown(e as PointerEvent)],
      ["pointermove", (e) => this.onPointerMove(e as PointerEvent)],
      ["pointerup", (e) => this.onPointerUp(e as PointerEvent)],
      ["pointercancel", (e) => this.onPointerCancel(e as PointerEvent)],
      ["wheel", (e) => this.onWheel(e as WheelEvent), { passive: false }],
      ["contextmenu", (e) => e.preventDefault()],
    ];
    for (const [type, listener, options] of listeners) stage.addEventListener(type, listener, options);
    this.detach = () => {
      for (const [type, listener] of listeners) stage.removeEventListener(type, listener);
    };
  }

  dispose(): void {
    this.resize.disconnect();
    this.detach();
    this.cancelGesture();
    if (this.moveFrame !== null) cancelAnimationFrame(this.moveFrame);
  }

  setVideoSize(size: { width: number; height: number }): void {
    this.video = size;
    this.layout();
  }

  resetZoom(): void {
    this.zoom = 1;
    this.pan = { x: 0, y: 0 };
    this.applyTransform();
  }

  private layout(): void {
    const width = this.stage.clientWidth;
    const height = this.stage.clientHeight;
    if (!width || !height) return;
    const scale = Math.min(width / this.video.width, height / this.video.height);
    const w = Math.round(this.video.width * scale);
    const h = Math.round(this.video.height * scale);
    this.base = { left: Math.round((width - w) / 2), top: Math.round((height - h) / 2), width: w, height: h };
    Object.assign(this.canvas.style, { left: `${this.base.left}px`, top: `${this.base.top}px`, width: `${w}px`, height: `${h}px` });
    this.applyTransform();
  }

  private applyTransform(): void {
    this.clampPan();
    this.canvas.style.transform = this.zoom === 1 ? "" : `translate(${this.pan.x}px, ${this.pan.y}px) scale(${this.zoom})`;
    this.onZoomChange(this.zoom > 1.001);
  }

  private clampPan(): void {
    const minX = this.base.width * (1 - this.zoom);
    const minY = this.base.height * (1 - this.zoom);
    this.pan = { x: Math.min(0, Math.max(minX, this.pan.x)), y: Math.min(0, Math.max(minY, this.pan.y)) };
  }

  /** A client point as a fraction of the video; the canvas rect already includes zoom and pan. */
  private toVideo(client: Point): Point {
    const rect = this.canvas.getBoundingClientRect();
    return {
      x: Math.min(1, Math.max(0, (client.x - rect.left) / (rect.width || 1))),
      y: Math.min(1, Math.max(0, (client.y - rect.top) / (rect.height || 1))),
    };
  }

  private moveTo(point: Point): void {
    this.send({ t: "move", ...point });
  }

  /** Mouse moves arrive faster than frames; send the latest once per animation frame. */
  private queueMove(point: Point): void {
    this.pendingMove = point;
    this.moveFrame ??= requestAnimationFrame(() => {
      this.moveFrame = null;
      if (this.pendingMove) this.moveTo(this.pendingMove);
      this.pendingMove = null;
    });
  }

  private flushMove(): void {
    if (this.moveFrame !== null) cancelAnimationFrame(this.moveFrame);
    this.moveFrame = null;
    if (this.pendingMove) this.moveTo(this.pendingMove);
    this.pendingMove = null;
  }

  /* ---- mouse and pen ------------------------------------------------------------------------ */

  private onPointerDown(e: PointerEvent): void {
    if (e.pointerType === "touch") return this.onTouchDown(e);
    e.preventDefault();
    this.onMouseFocus();
    this.stage.setPointerCapture(e.pointerId);
    this.pendingMove = this.toVideo(clientOf(e));
    this.flushMove();
    const button = MOUSE_BUTTONS[e.button];
    if (button) this.send({ t: "button", button, down: true });
  }

  private onPointerMove(e: PointerEvent): void {
    if (e.pointerType === "touch") return this.onTouchMove(e);
    this.queueMove(this.toVideo(clientOf(e)));
  }

  private onPointerUp(e: PointerEvent): void {
    if (e.pointerType === "touch") return this.onTouchUp(e);
    this.flushMove();
    const button = MOUSE_BUTTONS[e.button];
    if (button) this.send({ t: "button", button, down: false });
  }

  private onPointerCancel(e: PointerEvent): void {
    if (e.pointerType === "touch") {
      this.touches.delete(e.pointerId);
      this.cancelGesture();
      return;
    }
    this.send({ t: "release" });
  }

  private onWheel(e: WheelEvent): void {
    e.preventDefault();
    const unit = e.deltaMode === WheelEvent.DOM_DELTA_LINE ? 40 : e.deltaMode === WheelEvent.DOM_DELTA_PAGE ? 800 : 1;
    this.wheelCarry.y += -e.deltaY * unit * WHEEL_UNITS_PER_PX;
    this.wheelCarry.x += e.deltaX * unit * WHEEL_UNITS_PER_PX;
    this.flushWheel();
  }

  private flushWheel(): void {
    const dy = Math.trunc(this.wheelCarry.y);
    const dx = Math.trunc(this.wheelCarry.x);
    if (!dy && !dx) return;
    this.wheelCarry.y -= dy;
    this.wheelCarry.x -= dx;
    this.send({ t: "wheel", dy: clampWheel(dy), dx: clampWheel(dx) });
  }

  /* ---- touch -------------------------------------------------------------------------------- */

  private onTouchDown(e: PointerEvent): void {
    e.preventDefault();
    this.stage.setPointerCapture(e.pointerId);
    const point = clientOf(e);
    const touch: Touch = { id: e.pointerId, start: point, at: point, startedAt: performance.now() };
    this.touches.set(e.pointerId, touch);
    if (this.touches.size === 1) {
      const longPress = window.setTimeout(() => this.longPress(touch), LONG_PRESS_MS);
      this.gesture = { kind: "pending", touch, longPress };
      return;
    }
    if (this.touches.size === 2) this.beginTwoFinger();
  }

  private onTouchMove(e: PointerEvent): void {
    const touch = this.touches.get(e.pointerId);
    if (!touch) return;
    touch.at = clientOf(e);
    const g = this.gesture;
    if (g.kind === "pending" && distance(touch.at, touch.start) > TAP_SLOP_PX) this.beginDrag(g);
    else if (g.kind === "drag") this.queueMove(this.toVideo(touch.at));
    else if (g.kind === "two") this.twoFingerMove(g);
  }

  private onTouchUp(e: PointerEvent): void {
    const touch = this.touches.get(e.pointerId);
    this.touches.delete(e.pointerId);
    if (!touch) return;
    const g = this.gesture;
    if (g.kind === "pending") {
      window.clearTimeout(g.longPress);
      this.tap(touch.start);
      this.gesture = { kind: "idle" };
    } else if (g.kind === "drag") {
      this.flushMove();
      this.send({ t: "button", button: "left", down: false });
      this.gesture = { kind: "idle" };
    } else if (g.kind === "two") {
      if (g.mode === "undecided" && performance.now() - g.startedAt < TWO_FINGER_TAP_MS) this.click("right", this.toVideo(g.mid0));
      this.flushWheelCarry(g);
      // The remaining finger must not start a fresh gesture mid-lift.
      this.gesture = this.touches.size ? { kind: "consumed" } : { kind: "idle" };
    } else if (!this.touches.size) {
      this.gesture = { kind: "idle" };
    }
  }

  private tap(client: Point): void {
    const now = performance.now();
    const last = this.lastTap;
    const video = last && now - last.at < DOUBLE_TAP_MS && distance(client, last.client) < DOUBLE_TAP_SLOP_PX ? last.video : this.toVideo(client);
    this.click("left", video);
    this.lastTap = { at: now, client, video };
  }

  private click(button: Button, video: Point): void {
    this.flushMove();
    this.moveTo(video);
    this.send({ t: "button", button, down: true });
    this.send({ t: "button", button, down: false });
  }

  private longPress(touch: Touch): void {
    if (this.gesture.kind !== "pending" || this.gesture.touch !== touch) return;
    this.click("right", this.toVideo(touch.start));
    navigator.vibrate?.(15);
    this.gesture = { kind: "consumed" };
  }

  private beginDrag(g: Extract<Gesture, { kind: "pending" }>): void {
    window.clearTimeout(g.longPress);
    this.flushMove();
    this.moveTo(this.toVideo(g.touch.start));
    this.send({ t: "button", button: "left", down: true });
    this.queueMove(this.toVideo(g.touch.at));
    this.gesture = { kind: "drag" };
  }

  private beginTwoFinger(): void {
    const g = this.gesture;
    if (g.kind === "pending") window.clearTimeout(g.longPress);
    if (g.kind === "drag") {
      this.flushMove();
      this.send({ t: "button", button: "left", down: false });
    }
    const [a, b] = [...this.touches.values()] as [Touch, Touch];
    const mid = midpoint(a.at, b.at);
    this.gesture = { kind: "two", startedAt: performance.now(), mode: "undecided", dist0: distance(a.at, b.at), mid0: mid, lastMid: mid, zoom0: this.zoom, pan0: { ...this.pan }, scrollCarry: 0, scrollCarryX: 0 };
  }

  private twoFingerMove(g: Extract<Gesture, { kind: "two" }>): void {
    if (this.touches.size < 2) return;
    const [a, b] = [...this.touches.values()] as [Touch, Touch];
    const dist = distance(a.at, b.at);
    const mid = midpoint(a.at, b.at);
    if (g.mode === "undecided") {
      if (Math.abs(dist - g.dist0) > PINCH_DECIDE_PX) g.mode = "zoom";
      else if (distance(mid, g.mid0) > SCROLL_DECIDE_PX) g.mode = "scroll";
      else return;
    }
    if (g.mode === "zoom") this.pinch(g, dist, mid);
    else this.twoFingerScroll(g, mid);
  }

  /** Scale about the pinch centre and follow its movement, so the content stays under the fingers. */
  private pinch(g: Extract<Gesture, { kind: "two" }>, dist: number, mid: Point): void {
    const zoom = Math.min(MAX_ZOOM, Math.max(1, g.zoom0 * (dist / (g.dist0 || 1))));
    const stageRect = this.stage.getBoundingClientRect();
    const origin = { x: stageRect.left + this.base.left, y: stageRect.top + this.base.top };
    const contentX = (g.mid0.x - origin.x - g.pan0.x) / g.zoom0;
    const contentY = (g.mid0.y - origin.y - g.pan0.y) / g.zoom0;
    this.zoom = zoom;
    this.pan = { x: mid.x - origin.x - contentX * zoom, y: mid.y - origin.y - contentY * zoom };
    this.applyTransform();
  }

  private twoFingerScroll(g: Extract<Gesture, { kind: "two" }>, mid: Point): void {
    g.scrollCarry += (mid.y - g.lastMid.y) * TOUCH_SCROLL_UNITS_PER_PX;
    g.scrollCarryX += -(mid.x - g.lastMid.x) * TOUCH_SCROLL_UNITS_PER_PX;
    g.lastMid = mid;
    if (Math.abs(g.scrollCarry) < 30 && Math.abs(g.scrollCarryX) < 30) return;
    this.flushWheelCarry(g);
  }

  private flushWheelCarry(g: Extract<Gesture, { kind: "two" }>): void {
    const dy = Math.trunc(g.scrollCarry);
    const dx = Math.trunc(g.scrollCarryX);
    g.scrollCarry -= dy;
    g.scrollCarryX -= dx;
    if (dy || dx) this.send({ t: "wheel", dy: clampWheel(dy), dx: clampWheel(dx) });
  }

  private cancelGesture(): void {
    const g = this.gesture;
    if (g.kind === "pending") window.clearTimeout(g.longPress);
    if (g.kind === "drag") this.send({ t: "button", button: "left", down: false });
    this.gesture = this.touches.size ? { kind: "consumed" } : { kind: "idle" };
  }
}

function clientOf(e: PointerEvent): Point {
  return { x: e.clientX, y: e.clientY };
}

function distance(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function midpoint(a: Point, b: Point): Point {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

function clampWheel(value: number): number {
  return Math.max(-12_000, Math.min(12_000, value));
}
