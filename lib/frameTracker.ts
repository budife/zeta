import type { Point } from "./types";
import { smoothingAlpha } from "./smoothing";

/**
 * Sticky quadrilateral tracking for the hand-made window.
 *
 * The window is ONE object, not four independent points. This tracker owns the
 * four corners as a unit and, once it has seen a valid frame, refuses to let go
 * of them easily:
 *
 *   - the window LOCKS only when all four anchors are seen at once — the
 *     gesture that establishes intent;
 *   - after lock, each slot follows its own anchor: a fresh anchor eases the
 *     corner toward it (matched by nearest distance, so the polygon cannot
 *     flip when the frame tilts or the hands swap detection order);
 *   - a slot that got NO anchor this frame is not dropped — it holds its last
 *     known position and coasts briefly along the velocity the hand had, so a
 *     window carried to the right keeps drifting right instead of stopping
 *     dead, then settles;
 *   - only when EVERY slot has been blind past `maxMissedFrames` — i.e. both
 *     hands are genuinely gone — is the frame declared `lost`, which is the
 *     one and only thing that may release the selection. One hand lost at the
 *     viewport edge degrades the follow on its own side and nothing else.
 *
 * Nothing here knows about gestures or validity: the caller feeds it whatever
 * anchors survived the frame (four, two, or none) and decides what "lost" means
 * upstream.
 */
export const TRACK_CONFIG = {
  /**
   * Consecutive fully-blind frames (no anchor at all) before the tracker gives
   * up. Per-slot: a window with even one hand visible never reaches this, so
   * only the genuine "both hands gone" case can release the selection. At
   * 60 fps this is ~130 ms of total blindness — long enough to ride out
   * MediaPipe dropouts, short enough that a user who walked away does not keep
   * a phantom window.
   */
  maxMissedFrames: 8,
  /** Corner easing time constant while tracking (seconds). Responsive, not laggy. */
  tauCorner: 0.06,
  /**
   * Largest single-frame corner jump accepted, as a fraction of the window's
   * own diagonal. A detection that teleports is clamped rather than trusted —
   * this is the "don't accept a wildly different geometry" rule from the spec,
   * and the bound that keeps an unreliable anchor from yanking its corner.
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
 * How many consecutive fully-blind frames the window tolerates while still
 * merely FORMING (not yet locked) before the stale dots are cleared. A live
 * selection holds for the full `maxMissedFrames`; a forming one should not
 * leave orphan dots sitting where the hands used to be.
 */
export const FORMING_HOLD_FRAMES = 3;

/** What the tracker is doing this frame — drives the selection machine. */
export type TrackState =
  | "tracking"
  | "holding"
  | "lost";

/**
 * Sticky quadrilateral tracker: four slots as one object.
 *
 * `corners` are kept in the order the lock produced them, and each fresh
 * anchor is paired to the nearest free slot — so a slot keeps following the
 * same fingertip even if the angular sort starts somewhere else after a tilt
 * or MediaPipe reorders the hands. Velocity is measured on the raw anchors
 * (not the eased corners) so prediction reflects how the hands are actually
 * moving.
 */
export class StickyFrameTracker {
  private corners: Point[] | null = null;
  private velocity: Point[] = [];
  /** The last raw anchor each slot consumed (for velocity), null while blind. */
  private slotLastTarget: (Point | null)[] = [];
  /** Consecutive frames each slot has gone without a fresh anchor. */
  private slotMissed: number[] = [];
  /** Consecutive frames with NO anchor at all (the release clock). */
  private blind = 0;

  reset(): void {
    this.corners = null;
    this.velocity = [];
    this.slotLastTarget = [];
    this.slotMissed = [];
    this.blind = 0;
  }

  /** The current window corners, or null if it has never tracked a frame. */
  get value(): Point[] | null {
    return this.corners;
  }

  /**
   * Consecutive frames since ANY anchor was last seen. Zero while tracking or
   * holding with one hand; the release clock runs only when the window is
   * completely blind.
   */
  get missedFrames(): number {
    return this.blind;
  }

  /** Per-slot blind counters — diagnostic, and how "holding" is told apart. */
  get slotMissedFrames(): number[] {
    return this.slotMissed;
  }

  /**
   * `tracking` — every slot saw a fresh anchor this frame.
   * `holding` — at least one slot is blind (one hand lost or degraded), but
   *            the window is still alive: the blind slots hold, the rest keep
   *            following.
   * `lost`    — every slot has been blind past the budget: both hands are
   *            genuinely gone. This is the release trigger.
   */
  get state(): TrackState {
    if (this.blind > TRACK_CONFIG.maxMissedFrames) return "lost";
    if (this.blind > 0 || this.slotMissed.some((m) => m > 0)) return "holding";
    return "tracking";
  }

  /**
   * Advances the tracker one frame.
   *
   * `detected` is whatever anchors survived this frame — four while both hands
   * track, two when one hand degraded or dropped, null/short when detection
   * failed outright. The returned corners are what the window should render:
   * eased toward the fresh anchors, held-and-coasted on the blind slots, and
   * the last known shape once lost.
   */
  update(detected: Point[] | null, dtSeconds: number): Point[] | null {
    const targets = detected ?? [];

    if (!this.corners) {
      // The window is established by seeing all four anchors at once; anything
      // less is not a window yet, and is not clung to.
      if (targets.length === 4) {
        this.snap(targets);
      } else {
        this.blind++;
      }
      return this.corners;
    }

    this.blind = targets.length === 0 ? this.blind + 1 : 0;
    this.advance(targets, dtSeconds);
    return this.corners;
  }

  /** First frame: snap, so the window appears instantly. */
  private snap(targets: Point[]): void {
    this.corners = targets.map((p) => ({ ...p }));
    this.slotLastTarget = targets.map((p) => ({ ...p }));
    this.velocity = targets.map(() => ({ x: 0, y: 0 }));
    this.slotMissed = targets.map(() => 0);
    this.blind = 0;
  }

  /**
   * Eases each slot toward its matched fresh anchor, clamping teleports, and
   * holds + coasts every slot that received none.
   */
  private advance(targets: Point[], dtSeconds: number): void {
    const dt = Math.max(dtSeconds, 1 / 120);
    const alpha = smoothingAlpha(dtSeconds, TRACK_CONFIG.tauCorner);
    const maxStep = TRACK_CONFIG.maxJumpFraction * (diagonal(this.corners) || 1);

    // Pair each fresh anchor to the nearest still-free slot, so a slot keeps
    // following the same fingertip and the polygon cannot flip.
    const slotTarget: (Point | null)[] = (this.corners ?? []).map(() => null);
    const used = new Set<number>();
    for (const t of targets) {
      let best = -1;
      let bestDist = Infinity;
      for (let j = 0; j < slotTarget.length; j++) {
        if (used.has(j)) continue;
        const p = this.corners![j];
        const d = (p.x - t.x) ** 2 + (p.y - t.y) ** 2;
        if (d < bestDist) {
          bestDist = d;
          best = j;
        }
      }
      if (best >= 0) {
        used.add(best);
        slotTarget[best] = t;
      }
    }

    for (let i = 0; i < slotTarget.length; i++) {
      const cur = this.corners![i];
      const t = slotTarget[i];
      if (t) {
        // Clamp the jump: a detection that teleported is trusted only partway.
        let dx = t.x - cur.x;
        let dy = t.y - cur.y;
        const step = Math.hypot(dx, dy);
        if (step > maxStep) {
          const k = maxStep / step;
          dx *= k;
          dy *= k;
        }
        this.corners![i] = { x: cur.x + dx * alpha, y: cur.y + dy * alpha };

        // Velocity from the raw anchors: the eased corners lag behind the
        // hands, so measuring displacement there would understate motion.
        const prev = this.slotLastTarget[i] ?? t;
        this.velocity[i] = { x: (t.x - prev.x) / dt, y: (t.y - prev.y) / dt };
        this.slotLastTarget[i] = t;
        this.slotMissed[i] = 0;
      } else {
        // No fresh anchor for this slot: keep the corner and coast it briefly
        // along the hand's last velocity, damping each frame so the window
        // slows to a stop instead of sailing away. Never invented: the corner
        // stays where the hand was last seen.
        const v = this.velocity[i] ?? { x: 0, y: 0 };
        this.corners![i] = { x: cur.x + v.x * dt, y: cur.y + v.y * dt };
        this.velocity[i] = {
          x: v.x * TRACK_CONFIG.velocityDamping,
          y: v.y * TRACK_CONFIG.velocityDamping,
        };
        this.slotMissed[i]++;
      }
    }
  }
}

/** Diagonal of the corners' bounding box — the window's own scale. */
function diagonal(corners: Point[] | null): number {
  if (!corners || corners.length === 0) return 0;
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
