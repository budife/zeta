import type { FrameRect, Point } from "./types";
import { clamp } from "./geometry";

/**
 * Normalizes an angle to (-90, 90].
 * A rectangle is invariant under a 180° rotation, so any angle is equivalent
 * to angle + 180 * k. Keeping the value in a 180° window prevents the overlay
 * from snapping when the frame passes through ±90°.
 */
export function normalizeAngle(deg: number): number {
  let a = deg % 180;
  if (a <= -90) a += 180;
  else if (a > 90) a -= 180;
  return a;
}

/** Frame-rate independent exponential smoothing factor for a given time constant. */
export function smoothingAlpha(dtSeconds: number, tauSeconds: number): number {
  if (tauSeconds <= 0) return 1;
  const dt = clamp(dtSeconds, 0, 0.1);
  return 1 - Math.exp(-dt / tauSeconds);
}

export function smoothTowards(
  current: number,
  target: number,
  dtSeconds: number,
  tauSeconds: number
): number {
  return current + (target - current) * smoothingAlpha(dtSeconds, tauSeconds);
}

/**
 * Smooths an oriented rectangle so overlays do not jitter.
 * The first update after `reset()` snaps to the target: the overlay must appear
 * instantly, then it interpolates.
 */
export class RectSmoother {
  private state: FrameRect | null = null;

  /** Time constant for the center position (seconds). */
  tauPosition = 0.06;
  /** Time constant for width/height (seconds). */
  tauSize = 0.08;
  /** Time constant for rotation (seconds). */
  tauRotation = 0.09;

  reset(): void {
    this.state = null;
  }

  get value(): FrameRect | null {
    return this.state;
  }

  update(target: FrameRect, dtSeconds: number): FrameRect {
    if (!this.state) {
      this.state = { ...target, rotation: normalizeAngle(target.rotation) };
      return this.state;
    }

    const current = this.state;
    const alphaPos = smoothingAlpha(dtSeconds, this.tauPosition);
    const alphaSize = smoothingAlpha(dtSeconds, this.tauSize);
    const alphaRot = smoothingAlpha(dtSeconds, this.tauRotation);

    // Rectangles are 180°-symmetric: pick the closest equivalent angle first.
    const currentNorm = normalizeAngle(current.rotation);
    let targetNorm = normalizeAngle(target.rotation);
    let delta = targetNorm - currentNorm;
    if (delta > 90) delta -= 180;
    else if (delta < -90) delta += 180;

    this.state = {
      cx: current.cx + (target.cx - current.cx) * alphaPos,
      cy: current.cy + (target.cy - current.cy) * alphaPos,
      width: current.width + (target.width - current.width) * alphaSize,
      height: current.height + (target.height - current.height) * alphaSize,
      rotation: normalizeAngle(currentNorm + delta * alphaRot),
    };
    return this.state;
  }
}

/**
 * Smooths the four corners of the hand-made window independently.
 *
 * Unlike `RectSmoother` this does not assume the window is a rectangle: each
 * corner eases toward its own target, so a trapezoid or asymmetric frame keeps
 * its shape instead of being pulled back to an oriented box. Corners are
 * matched to their previous positions by nearest distance, so the smoothing
 * stays attached to the same fingertip even if the angular sort reorders them.
 */
export class CornerSmoother {
  private state: Point[] | null = null;

  tauCorner = 0.06;

  reset(): void {
    this.state = null;
  }

  get value(): Point[] | null {
    return this.state;
  }

  update(target: Point[], dtSeconds: number): Point[] {
    if (target.length !== 4) {
      this.state = null;
      return target;
    }
    if (!this.state) {
      this.state = target.map((p) => ({ ...p }));
      return this.state;
    }

    const alpha = smoothingAlpha(dtSeconds, this.tauCorner);
    const previous = this.state;
    const used = new Set<number>();

    this.state = target.map((t) => {
      // Pair this target corner with the unused previous corner nearest to it.
      let best = -1;
      let bestDist = Infinity;
      for (let j = 0; j < previous.length; j++) {
        if (used.has(j)) continue;
        const p = previous[j];
        const d = (p.x - t.x) ** 2 + (p.y - t.y) ** 2;
        if (d < bestDist) {
          bestDist = d;
          best = j;
        }
      }
      used.add(best);
      const current = previous[best] ?? t;
      return {
        x: current.x + (t.x - current.x) * alpha,
        y: current.y + (t.y - current.y) * alpha,
      };
    });
    return this.state;
  }
}
