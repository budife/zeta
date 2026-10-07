import { clamp } from "./geometry";

/**
 * Frame-rate independent easing.
 *
 * Everything that interpolates a tracking value across frames goes through
 * `smoothingAlpha` so the feel is identical at 30 fps and 120 fps: a fixed
 * number of *seconds* to close a fraction of the gap, not a fixed number of
 * frames.
 *
 * The window's own sticky behaviour (hold, velocity prediction, anti-teleport)
 * lives in `lib/frameTracker.ts`.
 */

/** Frame-rate independent exponential smoothing factor for a given time constant. */
export function smoothingAlpha(dtSeconds: number, tauSeconds: number): number {
  if (tauSeconds <= 0) return 1;
  const dt = clamp(dtSeconds, 0, 0.1);
  return 1 - Math.exp(-dt / tauSeconds);
}
