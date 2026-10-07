import type { Point } from "./types";
import { smoothingAlpha } from "./smoothing";

/**
 * Sticky quadrilateral tracking for the hand-made window.
 *
 * The window is ONE object, not four independent points. This tracker owns the
 * four corners as a unit and, once it has seen a valid frame, refuses to let go
 * of them easily:
 *
 *   - while hands are reported, each corner eases toward its own target
 *     (matched to the same fingertip by nearest distance, so the polygon
 *     cannot flip when the frame tilts);
 *   - when detection blinks, the last shape is not frozen — it keeps moving
 *     along the velocity the corners had, so a window carried to the right
 *     keeps drifting right instead of stopping dead;
 *   - only after `maxMissedFrames` consecutive failures is the frame declared
 *     `lost`, which is the one and only thing that may release the selection.
 *
 * Nothing here knows about gestures or validity: the caller feeds it either
 * four usable corners or `null`, and decides what "lost" means upstream.
 */
export const TRACK_CONFIG = {
  /**
   * Consecutive missed frames before the tracker gives up. The spec's starting
   * point; at 60 fps this is ~130 ms of total blindness before the selection
   * may release — long enough to ride out MediaPipe dropouts, short enough
   * that a user who actually walked away does not keep a phantom window.
   */
  maxMissedFrames: 8,
  /** Corner easing time constant while tracking (seconds). Responsive, not laggy. */
  tauCorner: 0.06,
  /**
   * Largest single-frame corner jump accepted, as a fraction of the window's
   * own diagonal. A detection that teleports is clamped rather than trusted —
   * this is the "don't accept a wildly different geometry" rule from the spec.
   */
  maxJumpFraction: 0.4,
  /**
   * Velocity multiplier applied every predicted frame. Prediction must decay,
   * not run away: after a few blind frames the window slows to a stop instead
   * of sailing off in the direction it was last heading.
   */
  velocityDamping: 0.8,
} as const;

/**
 * How many consecutive misses the window tolerates while still merely FORMING
 * (not yet locked) before the stale dots are cleared. A live selection holds
 * for the full `maxMissedFrames`; a forming one should not leave orphan dots
 * sitting where the hands used to be.
 */
export const FORMING_HOLD_FRAMES = 3;

/** What the tracker is doing this frame — drives the selection machine. */
export type TrackState =
  | "tracking"
  | "holding"
  | "lost";

/**
 * Sticky quadrilateral tracker: four corners as one object.
 *
 * `corners` are kept in the order `detectHandFrame` produces (angularly
 * sorted), and each new detection is paired to the previous corners by nearest
 * distance — so corner 0 keeps following the same fingertip even if the
 * angular sort starts somewhere else after a tilt. Velocity is measured on the
 * raw targets (not the eased corners) so prediction reflects how the hands are
 * actually moving.
 */
export class StickyFrameTracker {
  private corners: Point[] | null = null;
  private velocity: Point[] = [];
  private prevTargets: Point[] | null = null;
  private missed = 0;

  reset(): void {
    this.corners = null;
    this.velocity = [];
    this.prevTargets = null;
    this.missed = 0;
  }

  /** The current window corners, or null if it has never tracked a frame. */
  get value(): Point[] | null {
    return this.corners;
  }

  /** Consecutive frames since usable corners were last seen. */
  get missedFrames(): number {
    return this.missed;
  }

  /**
   * `tracking` — fresh corners this frame.
   * `holding` — detection is gone, but within the grace budget; corners are
   *            still published (predicted forward).
   * `lost`    — the budget is spent. This is the release trigger.
   */
  get state(): TrackState {
    if (this.missed === 0) return "tracking";
    return this.missed > TRACK_CONFIG.maxMissedFrames ? "lost" : "holding";
  }

  /**
   * Advances the tracker one frame.
   *
   * `detected` is either the four usable corners this frame or null/short when
   * detection failed or the shape was unusable. The returned corners are what
   * the window should render — smoothed while tracking, predicted while
   * holding, and the last known position once lost.
   */
  update(detected: Point[] | null, dtSeconds: number): Point[] | null {
    if (detected && detected.length === 4) {
      this.advance(detected, dtSeconds);
      this.missed = 0;
      return this.corners;
    }

    this.missed++;
    if (!this.corners || this.missed > TRACK_CONFIG.maxMissedFrames) {
      return this.corners;
    }
    this.predict(dtSeconds);
    return this.corners;
  }

  /** Eases each corner toward its matched target, clamping teleports. */
  private advance(targets: Point[], dtSeconds: number): void {
    if (!this.corners || !this.prevTargets) {
      // First frame: snap, so the window appears instantly.
      this.corners = targets.map((p) => ({ ...p }));
      this.prevTargets = targets.map((p) => ({ ...p }));
      this.velocity = targets.map(() => ({ x: 0, y: 0 }));
      return;
    }

    const dt = Math.max(dtSeconds, 1 / 120);
    const alpha = smoothingAlpha(dtSeconds, TRACK_CONFIG.tauCorner);
    const maxStep = TRACK_CONFIG.maxJumpFraction * (diagonal(this.corners) || 1);

    // Pair each target with the previous corner nearest to it, so a corner
    // keeps following the same fingertip and the polygon cannot flip.
    const used = new Set<number>();
    const next: Point[] = [];
    const nextVelocity: Point[] = [];

    for (let i = 0; i < targets.length; i++) {
      const t = targets[i];
      let best = -1;
      let bestDist = Infinity;
      for (let j = 0; j < this.corners.length; j++) {
        if (used.has(j)) continue;
        const p = this.corners[j];
        const d = (p.x - t.x) ** 2 + (p.y - t.y) ** 2;
        if (d < bestDist) {
          bestDist = d;
          best = j;
        }
      }
      used.add(best);
      const cur = this.corners[best] ?? t;

      // Clamp the jump: a detection that teleported is trusted only partway.
      let dx = t.x - cur.x;
      let dy = t.y - cur.y;
      const step = Math.hypot(dx, dy);
      if (step > maxStep) {
        const k = maxStep / step;
        dx *= k;
        dy *= k;
      }

      next.push({
        x: cur.x + dx * alpha,
        y: cur.y + dy * alpha,
      });

      // Velocity from the raw targets: the eased corners lag behind the hands,
      // so measuring displacement there would systematically understate motion.
      const prev = this.prevTargets[i] ?? t;
      nextVelocity.push({ x: (t.x - prev.x) / dt, y: (t.y - prev.y) / dt });
    }

    this.corners = next;
    this.prevTargets = targets.map((p) => ({ ...p }));
    this.velocity = nextVelocity;
  }

  /** Coasts the window forward along its last velocity, decaying as it goes. */
  private predict(dtSeconds: number): void {
    const dt = Math.max(dtSeconds, 1 / 120);
    const current = this.corners;
    if (!current) return;
    this.corners = current.map((c, i) => {
      const v = this.velocity[i] ?? { x: 0, y: 0 };
      return { x: c.x + v.x * dt, y: c.y + v.y * dt };
    });
    this.velocity = this.velocity.map((v) => ({
      x: v.x * TRACK_CONFIG.velocityDamping,
      y: v.y * TRACK_CONFIG.velocityDamping,
    }));
  }
}

/** Diagonal of the corners' bounding box — the window's own scale. */
function diagonal(corners: Point[]): number {
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const p of corners) {
    minX = Math.min(minX, p.x);
    maxX = Math.max(maxX, p.x);
    minY = Math.min(minY, p.y);
    maxY = Math.max(maxY, p.y);
  }
  return Math.hypot(maxX - minX, maxY - minY);
}
