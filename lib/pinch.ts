/**
 * Pinch detection and the double-pinch effect cycle (spec decision 1).
 *
 * Geometry only — no learned gesture: a pinch is the thumb tip (4) and index
 * tip (8) closing to a fraction of the palm length (0→9), so it counts the
 * same whether the hand is at the camera or across the room, and in raw or
 * normalized coordinates. Any hand counts; the aggregate state is what the
 * frame-freeze guard reads.
 *
 * The cycle follows the decision exactly:
 *
 *   first pinch            → nothing (but it starts the window, and while
 *                             held the degenerate geometry freezes the frame
 *                             feed — same rule as the swipe sign)
 *   second pinch in-window → NEXT EFFECT (lib/effects.nextEffect) — the
 *                             event the engine turns into a status patch
 *   window expires         → the next pinch starts a fresh pair
 *
 * Timing state lives here (not in the engine) so tests can drive it.
 */

/** Tunables — threshold and window are the decision's starting point. */
export const PINCH_CONFIG = {
  /** thumb↔index gap below this fraction of palm length = pinched */
  threshold: 0.35,
  /** the second pinch must land within this many ms of the first */
  windowMs: 700,
} as const;

/** The landmark shape the detector needs (MediaPipe normalized or pixel). */
export type PinchLandmark = { x: number; y: number };

function distance(a: PinchLandmark, b: PinchLandmark): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/**
 * Whether one hand is pinching: gap(4,8) < threshold × palm(0,9). Returns
 * false for anything too short to contain the four landmarks it reads.
 */
export function isPinched(landmarks: readonly PinchLandmark[] | null | undefined): boolean {
  if (!landmarks || landmarks.length < 10) return false;
  const palm = distance(landmarks[0], landmarks[9]);
  if (palm <= 0) return false;
  return distance(landmarks[4], landmarks[8]) < PINCH_CONFIG.threshold * palm;
}

/**
 * Edge-detected double-pinch over ANY visible hand (per-frame aggregate:
 * one hand pinching is enough). `update` returns true only on the SECOND
 * pinch of a pair; `held` reports the current pinch for the freeze guard.
 */
export class PinchCycleDetector {
  private closed = false;
  private firstAt = Number.NEGATIVE_INFINITY;

  /**
   * Feed the frame's hands. Returns true on the pinch that completes a
   * double-pinch; every other frame — including held pinches — returns false.
   */
  update(
    hands: readonly (readonly PinchLandmark[])[],
    nowMs: number
  ): boolean {
    const pinched = hands.some((hand) => isPinched(hand));
    const edge = pinched && !this.closed;
    this.closed = pinched;

    // Expire a stale first pinch BEFORE judging the edge: a lone pinch that
    // waited out the window must start a fresh pair, not complete one.
    if (nowMs - this.firstAt > PINCH_CONFIG.windowMs) {
      this.firstAt = Number.NEGATIVE_INFINITY;
    }
    if (!edge) return false;
    if (Number.isFinite(this.firstAt)) {
      this.firstAt = Number.NEGATIVE_INFINITY;
      return true;
    }
    this.firstAt = nowMs;
    return false;
  }

  /** While the fingers are closed — drives the frame-freeze guard. */
  get held(): boolean {
    return this.closed;
  }
}
