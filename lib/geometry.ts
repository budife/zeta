import type { FrameRect, NormalizedLandmark, Point } from "./types";

/** Tuning constants for hand-frame detection. Deliberately tolerant. */
export const FRAME_CONFIG = {
  /** Thumb tip ↔ index tip separation, relative to palm length, to form a corner. */
  minTipSeparation: 0.25,
  /**
   * Every one of the 21 landmarks must sit within this many palm lengths of
   * the wrist. Validates the WHOLE hand, not just the two anchor tips, so a
   * detection that teleports a fingertip cannot pass because thumb+index alone
   * look plausible. Deliberately generous — it is a plausibility bound, not an
   * anatomical model. Not a bounding box: a radius around the wrist.
   */
  maxLandmarkReach: 3.5,
  /** Index finger considered extended when tip↔mcp / palmLength exceeds this. */
  extendThreshold: 0.55,
  /**
   * How many of middle/ring/pinky must be curled to avoid open-palm false
   * positives. 0 = no finger-curl requirement: thumb + index tips alone define
   * the window, no other gesture condition may reject it.
   */
  minCurledFingers: 0,
  /** Smallest accepted frame area as a fraction of the whole video area. */
  minAreaFraction: 0.035,
  /** Largest accepted frame area as a fraction of the whole video area. */
  maxAreaFraction: 0.95,
  /** Longest/shortest side ratio allowed for the frame. */
  maxAspect: 3.4,
  /**
   * Smallest accepted dimension of the window's bounding box, as a fraction of
   * the shorter video side. Windows may be tall, wide, or skewed — just not a
   * zero-area sliver.
   */
  minWindowSide: 0.06,
  /** Every interior corner angle must lie inside this range (degrees). */
  minCornerAngle: 40,
  maxCornerAngle: 140,
  /** Consecutive valid frames needed before the frame turns ACTIVE. */
  activateAfter: 2,
  /** Consecutive invalid frames needed before the frame turns INACTIVE. */
  deactivateAfter: 4,
} as const;

/** Landmark index helpers (MediaPipe hand model). */
export const HAND_LANDMARK = {
  wrist: 0,
  thumbCmc: 1,
  thumbMcp: 2,
  thumbIp: 3,
  thumbTip: 4,
  indexMcp: 5,
  indexPip: 6,
  indexDip: 7,
  indexTip: 8,
  middleMcp: 9,
  middlePip: 10,
  middleDip: 11,
  middleTip: 12,
  ringMcp: 13,
  ringPip: 14,
  ringDip: 15,
  ringTip: 16,
  pinkyMcp: 17,
  pinkyPip: 18,
  pinkyDip: 19,
  pinkyTip: 20,
} as const;

/** Hand skeleton connections for the debug overlay (MediaPipe hand topology). */
export const HAND_CONNECTIONS: ReadonlyArray<readonly [number, number]> = [
  [0, 1], [1, 2], [2, 3], [3, 4],
  [0, 5], [5, 6], [6, 7], [7, 8],
  [5, 9], [9, 10], [10, 11], [11, 12],
  [9, 13], [13, 14], [14, 15], [15, 16],
  [13, 17], [17, 18], [18, 19], [19, 20],
  [0, 17],
];

export function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

export function dist(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

export function midpoint(a: Point, b: Point): Point {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

export function centroid(points: Point[]): Point {
  let x = 0;
  let y = 0;
  for (const p of points) {
    x += p.x;
    y += p.y;
  }
  const n = points.length || 1;
  return { x: x / n, y: y / n };
}

/** Converts MediaPipe normalized landmarks into video-pixel space. */
export function toPixelLandmarks(
  landmarks: NormalizedLandmark[],
  width: number,
  height: number
): Point[] {
  return landmarks.map((lm) => ({ x: lm.x * width, y: lm.y * height }));
}

/** Sorts points counter-clockwise (screen space, y-down) around their centroid. */
export function sortAngular(points: Point[]): Point[] {
  const c = centroid(points);
  return [...points].sort(
    (a, b) =>
      Math.atan2(a.y - c.y, a.x - c.x) - Math.atan2(b.y - c.y, b.x - c.x)
  );
}

/** Shoelace area of a simple polygon (always positive). */
export function polygonArea(points: Point[]): number {
  let sum = 0;
  for (let i = 0; i < points.length; i++) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    sum += a.x * b.y - b.x * a.y;
  }
  return Math.abs(sum) / 2;
}

/** Four corners of an oriented rectangle, in the same winding as `rotation`. */
export function rectCorners(rect: FrameRect): Point[] {
  const halfW = rect.width / 2;
  const halfH = rect.height / 2;
  const rad = (rect.rotation * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const local: Point[] = [
    { x: -halfW, y: -halfH },
    { x: halfW, y: -halfH },
    { x: halfW, y: halfH },
    { x: -halfW, y: halfH },
  ];
  return local.map((p) => ({
    x: rect.cx + p.x * cos - p.y * sin,
    y: rect.cy + p.x * sin + p.y * cos,
  }));
}

/** Inverse-maps a point into the rectangle's local space. */
export function toRectLocal(point: Point, rect: FrameRect): Point {
  const rad = (-rect.rotation * Math.PI) / 180;
  const dx = point.x - rect.cx;
  const dy = point.y - rect.cy;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  return { x: dx * cos - dy * sin, y: dx * sin + dy * cos };
}

export function pointInRect(
  point: Point,
  rect: FrameRect,
  margin = 1
): boolean {
  const local = toRectLocal(point, rect);
  return (
    Math.abs(local.x) <= (rect.width / 2) * margin &&
    Math.abs(local.y) <= (rect.height / 2) * margin
  );
}

export function boxContainsCenter(box: { x: number; y: number; width: number; height: number }): Point {
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

/**
 * Frame-activation hysteresis state.
 *
 * A frame must stay valid for `activateAfter` consecutive frames before it
 * turns ACTIVE, and stay invalid for `deactivateAfter` consecutive frames
 * before it turns INACTIVE. Kept as an explicit value so the rule is testable
 * outside the engine's animation loop.
 */
export type FrameActivityState = {
  active: boolean;
  validStreak: number;
  invalidStreak: number;
};

export const INITIAL_FRAME_ACTIVITY: FrameActivityState = {
  active: false,
  validStreak: 0,
  invalidStreak: 0,
};

/**
 * Advances the hysteresis by one frame.
 *
 * `activated` / `deactivated` report the transition caused by *this* frame, so
 * the caller can reset state that depends on the frame (smoothers, face
 * tracker, matched character) exactly once when it goes inactive. The two can
 * never both be true: one requires the previous state to be inactive and the
 * other requires it to be active.
 */
export function advanceFrameActivity(
  state: FrameActivityState,
  valid: boolean
): { state: FrameActivityState; activated: boolean; deactivated: boolean } {
  const validStreak = valid ? state.validStreak + 1 : 0;
  const invalidStreak = valid ? 0 : state.invalidStreak + 1;

  const activated = !state.active && validStreak >= FRAME_CONFIG.activateAfter;
  const deactivated =
    state.active && invalidStreak >= FRAME_CONFIG.deactivateAfter;

  return {
    state: {
      active: activated || (state.active && !deactivated),
      validStreak,
      invalidStreak,
    },
    activated,
    deactivated,
  };
}
