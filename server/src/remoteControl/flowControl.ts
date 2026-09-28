// Backlog the viewer may build up above its normal latency before we skip ahead to the next keyframe.
// Wi-Fi stalls and keyframe bursts queue a few hundred ms and drain on their own; skipping costs a
// freeze of up to a GOP, so only a backlog that is plainly not draining is worth it.
export const MAX_BACKLOG_MS = 600;
// Backlog at or below which a keyframe resumes sending after a skip.
export const RESUME_BACKLOG_MS = 150;
// A frame still unacknowledged this long into a skip is lost, not queued: the viewer dropped it (a
// decoder error), and since nothing is sent while skipping, no later ack could ever move past it.
export const LOST_FRAME_MS = 3_000;
// The socket's own buffer is the backstop for a viewer that stopped acknowledging altogether.
export const MAX_SOCKET_BUFFER_BYTES = 8 * 1024 * 1024;
// The latency floor is the fastest ack in this window, so it follows a network change within seconds.
const FLOOR_WINDOW_MS = 10_000;
// No usable link takes longer than this to deliver and paint a frame. Capping the floor stops a queue
// that grows slowly enough to hide inside the window from passing itself off as the link's latency.
const MAX_FLOOR_MS = 400;
const FLOOR_BUCKET_MS = 1_000;
const SENT_RING = 4096;

/**
 * Drop-to-keyframe flow control keyed on queueing delay, not on frames in flight. The viewer acks a
 * frame once it is painted, so a frame's ack delay is network round trip + decoder buffering + any
 * queue. The fastest recent ack delay is the link's floor; only the age of the oldest unacked frame
 * ABOVE that floor is backlog. Counting frames in flight instead mistakes a slow decoder or a long
 * round trip for congestion and freezes a healthy stream.
 */
export class FrameFlow {
  private readonly sentAt = new Float64Array(SENT_RING);
  private sentSeq = 0;
  private ackedSeq = 0;
  private dropping = false;
  private floorBuckets: { start: number; min: number }[] = [];

  constructor(private readonly now: () => number = () => performance.now()) {}

  /**
   * Forgets what is in flight, so the next keyframe goes out even mid-skip: a new capture's first keyframe
   * has to reach the viewer, or it keeps showing the old picture while input already maps to the new one.
   */
  restart(): void {
    this.ackedSeq = this.sentSeq;
    this.dropping = false;
  }

  /** Skipping ahead to a keyframe right now. */
  get skipping(): boolean {
    return this.dropping;
  }

  /** Should this frame go out? A false means skip it; once skipping, only a keyframe can resume. */
  admit(key: boolean, socketBufferedBytes: number): boolean {
    if (this.dropping && this.oldestUnackedAgeMs() > LOST_FRAME_MS) this.ackedSeq = this.sentSeq;
    const backlog = this.backlogMs();
    const bufferFull = socketBufferedBytes > MAX_SOCKET_BUFFER_BYTES;
    if (bufferFull || backlog > MAX_BACKLOG_MS) this.dropping = true;
    if (!this.dropping) return true;
    if (key && !bufferFull && backlog <= RESUME_BACKLOG_MS) {
      this.dropping = false;
      return true;
    }
    return false;
  }

  /** Records the frame as sent and returns its sequence number. */
  sent(): number {
    const seq = ++this.sentSeq;
    this.sentAt[seq % SENT_RING] = this.now();
    return seq;
  }

  acked(seq: number): void {
    if (seq > this.sentSeq || this.sentSeq - seq >= SENT_RING) return;
    this.recordAckDelay(this.now() - this.sentAt[seq % SENT_RING]!);
    if (seq > this.ackedSeq) this.ackedSeq = seq;
  }

  /** How long the oldest unacknowledged frame has waited beyond the link's normal ack delay. */
  backlogMs(): number {
    return Math.max(0, this.oldestUnackedAgeMs() - this.floorMs());
  }

  floorMs(): number {
    const since = this.now() - FLOOR_WINDOW_MS;
    let floor = Number.POSITIVE_INFINITY;
    for (const bucket of this.floorBuckets) if (bucket.start >= since - FLOOR_BUCKET_MS) floor = Math.min(floor, bucket.min);
    return Number.isFinite(floor) ? Math.min(floor, MAX_FLOOR_MS) : 0;
  }

  private oldestUnackedAgeMs(): number {
    if (this.ackedSeq >= this.sentSeq) return 0;
    const oldest = this.ackedSeq + 1;
    if (this.sentSeq - oldest >= SENT_RING) return Number.POSITIVE_INFINITY;
    return this.now() - this.sentAt[oldest % SENT_RING]!;
  }

  private recordAckDelay(delay: number): void {
    const now = this.now();
    const last = this.floorBuckets.at(-1);
    if (last && now - last.start < FLOOR_BUCKET_MS) last.min = Math.min(last.min, delay);
    else this.floorBuckets.push({ start: now, min: delay });
    const since = now - FLOOR_WINDOW_MS - FLOOR_BUCKET_MS;
    while (this.floorBuckets.length && this.floorBuckets[0]!.start < since) this.floorBuckets.shift();
  }
}

// Bitrate as a fraction of the chosen preset's. The lowest rung still reads text on a static desktop.
export const RATE_LADDER = [1, 0.6, 0.35, 0.2] as const;
// Two skips this close together mean the link cannot carry the rate; one alone is usually a stall.
const SKIPS_TO_STEP_DOWN = 2;
const SKIP_WINDOW_MS = 20_000;
// A new rate needs a moment to reach the viewer before it can be judged.
const SETTLE_MS = 3_000;
// Backlog under this counts as calm; a lowered rate is raised again after this long calm.
const CALM_BACKLOG_MS = 200;
const STEP_UP_AFTER_MS = 30_000;
// A raise that fails this soon was premature, so the next attempt waits twice as long.
const FAILED_STEP_UP_MS = 60_000;
const MAX_STEP_UP_AFTER_MS = 8 * 60_000;

/**
 * Picks the encoder bitrate for the link: steps down a rung when skips keep happening, and back up
 * after a calm stretch, backing off if the higher rate keeps failing. Changing the rate restarts the
 * encoder, so it reacts to a pattern, never to a single stall.
 */
export class AdaptiveRate {
  private rung = 0;
  private skips: number[] = [];
  private wasSkipping = false;
  private calmSince: number;
  private changedAt: number;
  private steppedUpAt: number | null = null;
  private stepUpAfterMs = STEP_UP_AFTER_MS;

  constructor(private readonly now: () => number = () => performance.now()) {
    this.calmSince = this.changedAt = now();
  }

  get factor(): number {
    return RATE_LADDER[this.rung]!;
  }

  /** Back to the full rate, as when the owner picks a quality: a new choice deserves a fresh try. */
  reset(): void {
    this.rung = 0;
    this.skips = [];
    this.steppedUpAt = null;
    this.stepUpAfterMs = STEP_UP_AFTER_MS;
    this.calmSince = this.changedAt = this.now();
  }

  /** Feed every frame's flow state; returns true when the rate should change (read `factor`). */
  observe(backlogMs: number, skipping: boolean): boolean {
    const now = this.now();
    const skipStarted = skipping && !this.wasSkipping;
    this.wasSkipping = skipping;
    if (skipping || backlogMs > CALM_BACKLOG_MS) this.calmSince = now;
    if (skipStarted && this.stepDown(now)) return true;
    return this.stepUp(now);
  }

  private stepDown(now: number): boolean {
    this.skips = this.skips.filter((at) => now - at < SKIP_WINDOW_MS);
    this.skips.push(now);
    if (this.skips.length < SKIPS_TO_STEP_DOWN || this.rung === RATE_LADDER.length - 1 || now - this.changedAt < SETTLE_MS) return false;
    if (this.steppedUpAt !== null && now - this.steppedUpAt < FAILED_STEP_UP_MS) {
      this.stepUpAfterMs = Math.min(this.stepUpAfterMs * 2, MAX_STEP_UP_AFTER_MS);
    }
    this.rung++;
    this.skips = [];
    this.steppedUpAt = null;
    this.changedAt = now;
    return true;
  }

  private stepUp(now: number): boolean {
    if (this.rung === 0 || now - this.calmSince < this.stepUpAfterMs || now - this.changedAt < this.stepUpAfterMs) return false;
    this.rung--;
    this.steppedUpAt = now;
    this.changedAt = this.calmSince = now;
    return true;
  }
}
