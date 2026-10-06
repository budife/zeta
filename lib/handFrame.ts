import type {
  FrameRect,
  HandFrameDetection,
  HandGestureVerdict,
  FrameValidity,
  NormalizedLandmark,
  Point,
} from "./types";
import {
  FRAME_CONFIG,
  HAND_LANDMARK,
  centroid,
  dist,
  rectCorners,
  sortAngular,
  toPixelLandmarks,
} from "./geometry";

/**
 * Verdict for one hand: does it expose two usable corners?
 *
 * Deliberately minimal: the only thing that matters is that the thumb tip and
 * index tip are far enough apart (and the hand big enough) that the two points
 * can serve as corners. No finger-curl rules, no "L" shape requirement, no
 * rectangle condition — the four corners come straight from the landmarks.
 */
function checkHandGesture(hand: Point[]): HandGestureVerdict {
  const palm = dist(hand[HAND_LANDMARK.wrist], hand[HAND_LANDMARK.middleMcp]);
  if (palm < 8) {
    return { ok: false, reason: "hand-too-far" };
  }

  const separation =
    dist(hand[HAND_LANDMARK.thumbTip], hand[HAND_LANDMARK.indexTip]) / palm;
  if (separation < FRAME_CONFIG.minTipSeparation) {
    return { ok: false, reason: "fingers-not-spread" };
  }

  return { ok: true, reason: "ok" };
}

/**
 * Step 1 — converts raw MediaPipe landmarks into the four raw frame corners.
 *
 * Each contributing hand supplies its thumb tip and index tip; the two hands
 * therefore supply the four corners of the frame, with nothing hardcoded:
 * position, size and rotation all follow the hands.
 */
export function detectHandFrame(
  landmarks: NormalizedLandmark[][],
  width: number,
  height: number
): HandFrameDetection {
  const hands = (landmarks ?? []).map((lm) => toPixelLandmarks(lm, width, height));

  const gestures = hands.map((hand) => checkHandGesture(hand));
  const contributing = hands.filter((_, i) => gestures[i].ok);

  if (contributing.length < 2) {
    const reason =
      hands.length < 2
        ? hands.length === 0
          ? "hands-not-detected"
          : "one-hand-detected"
        : "gesture-invalid";
    return { handCount: hands.length, corners: [], gestures, reason };
  }

  const corners: Point[] = [];
  for (const hand of contributing) {
    corners.push(hand[HAND_LANDMARK.thumbTip]);
    corners.push(hand[HAND_LANDMARK.indexTip]);
  }

  return {
    handCount: hands.length,
    corners: sortAngular(corners),
    gestures,
    reason: "corners-found",
  };
}

/**
 * Step 2 — fits an oriented rectangle to the four raw corners.
 * Opposite edges of a rectangle are parallel, so the rectangle's axis is the
 * average direction of edges 0→1 and 2→3. Every corner is then projected onto
 * that axis and its perpendicular to obtain width and height.
 */
export function calculateFrame(corners: Point[]): FrameRect | null {
  if (!corners || corners.length !== 4) return null;

  const c = centroid(corners);
  // Opposite edges of a consistently-wound quadrilateral point in opposite
  // directions, so the second direction is reversed before averaging.
  const ax = Math.atan2(corners[1].y - corners[0].y, corners[1].x - corners[0].x);
  const ax2 = Math.atan2(corners[2].y - corners[3].y, corners[2].x - corners[3].x);
  let ux = Math.cos(ax) + Math.cos(ax2);
  let uy = Math.sin(ax) + Math.sin(ax2);
  if (Math.hypot(ux, uy) < 0.25) {
    // Degenerate collinear case: fall back to an axis-aligned bounding box.
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const p of corners) {
      minX = Math.min(minX, p.x);
      maxX = Math.max(maxX, p.x);
      minY = Math.min(minY, p.y);
      maxY = Math.max(maxY, p.y);
    }
    return {
      cx: (minX + maxX) / 2,
      cy: (minY + maxY) / 2,
      width: maxX - minX,
      height: maxY - minY,
      rotation: 0,
    };
  }

  const len = Math.hypot(ux, uy);
  ux /= len;
  uy /= len;

  // Pointing both axes at the same place makes them "opposite", regardless of
  // which corner the sort started at.
  const e0x = corners[1].x - corners[0].x;
  const e0y = corners[1].y - corners[0].y;
  if (e0x * ux + e0y * uy < 0) {
    ux = -ux;
    uy = -uy;
  }
  const vx = -uy;
  const vy = ux;

  let minU = Infinity, maxU = -Infinity, minV = Infinity, maxV = -Infinity;
  for (const p of corners) {
    const du = p.x - c.x;
    const dv = p.y - c.y;
    const u = du * ux + dv * uy;
    const v = du * vx + dv * vy;
    minU = Math.min(minU, u);
    maxU = Math.max(maxU, u);
    minV = Math.min(minV, v);
    maxV = Math.max(maxV, v);
  }

  return {
    cx: c.x + ux * (minU + maxU) / 2 + vx * (minV + maxV) / 2,
    cy: c.y + uy * (minU + maxU) / 2 + vy * (minV + maxV) / 2,
    width: maxU - minU,
    height: maxV - minV,
    rotation: (Math.atan2(uy, ux) * 180) / Math.PI,
  };
}

/**
 * Step 3 — decides whether the fitted rectangle really looks like a frame.
 * All three checks are deliberately generous so the gesture stays easy to hold.
 */
export function isValidFrame(
  frame: FrameRect | null,
  width: number,
  height: number
): FrameValidity {
  if (!frame) return { valid: false, reason: "no-frame" };

  if (frame.width < 24 || frame.height < 24) {
    return { valid: false, reason: "frame-too-small" };
  }

  const area = frame.width * frame.height;
  const total = width * height;
  if (area < FRAME_CONFIG.minAreaFraction * total) {
    return { valid: false, reason: "area-too-small" };
  }
  if (area > FRAME_CONFIG.maxAreaFraction * total) {
    return { valid: false, reason: "area-too-large" };
  }

  const shortest = Math.min(frame.width, frame.height);
  const aspect = Math.max(frame.width, frame.height) / Math.max(shortest, 1);
  if (aspect > FRAME_CONFIG.maxAspect) {
    return { valid: false, reason: "too-narrow" };
  }

  const corners = sortAngular(rectCorners(frame));
  for (let i = 0; i < corners.length; i++) {
    const a = corners[(i + corners.length - 1) % corners.length];
    const b = corners[i];
    const d = corners[(i + 1) % corners.length];
    const v1x = a.x - b.x;
    const v1y = a.y - b.y;
    const v2x = d.x - b.x;
    const v2y = d.y - b.y;
    const dot = v1x * v2x + v1y * v2y;
    const cross = v1x * v2y - v1y * v2x;
    const angle = (Math.atan2(Math.abs(cross), dot) * 180) / Math.PI;
    if (angle < FRAME_CONFIG.minCornerAngle || angle > FRAME_CONFIG.maxCornerAngle) {
      return { valid: false, reason: "not-rectangular" };
    }
  }

  return { valid: true, reason: "ok" };
}

/**
 * Step 3b — decides whether the four detected corners enclose a usable window.
 *
 * Unlike `isValidFrame` (which fits an oriented rectangle and rejects anything
 * too far from it), this validates the raw quadrilateral the hands actually
 * form. The window may be a trapezoid, asymmetric, or tilted: as long as the
 * four corners enclose a single simple area that is big enough and not a
 * degenerate sliver, it is a valid window.
 *
 * Checks, all deliberately generous:
 *  - exactly four corners, none repeated;
 *  - the polygon is simple (edges do not cross) and consistently wound;
 *  - the enclosed area is within the configured fraction of the video;
 *  - the corners are not nearly collinear (which would give a zero-area sliver).
 */
export function isValidQuad(
  corners: Point[],
  width: number,
  height: number
): FrameValidity {
  if (corners.length !== 4) return { valid: false, reason: "no-frame" };

  const total = width * height;

  // Shoelace area. The sign also tells us the winding, which we need to be
  // consistent: a self-intersecting "bowtie" is not a window.
  let signedArea = 0;
  for (let i = 0; i < 4; i++) {
    const a = corners[i];
    const b = corners[(i + 1) % 4];
    signedArea += a.x * b.y - b.x * a.y;
  }
  const area = Math.abs(signedArea) / 2;
  if (area < FRAME_CONFIG.minAreaFraction * total) {
    return { valid: false, reason: "area-too-small" };
  }
  if (area > FRAME_CONFIG.maxAreaFraction * total) {
    return { valid: false, reason: "area-too-large" };
  }

  // Every corner must turn the same way (all left or all right). A sign flip
  // means a reflex angle or a crossing, i.e. not a simple quadrilateral.
  let winding = 0;
  for (let i = 0; i < 4; i++) {
    const a = corners[i];
    const b = corners[(i + 1) % 4];
    const c = corners[(i + 2) % 4];
    const cross = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
    if (Math.abs(cross) < 1) continue; // nearly straight is fine
    const sign = cross > 0 ? 1 : -1;
    if (winding === 0) winding = sign;
    else if (sign !== winding) return { valid: false, reason: "not-simple-quad" };
  }

  // Reject slivers: the smallest dimension of the axis-aligned bounding box
  // must be a reasonable fraction of the video. A window can be tall or wide,
  // but not a line.
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const p of corners) {
    minX = Math.min(minX, p.x);
    maxX = Math.max(maxX, p.x);
    minY = Math.min(minY, p.y);
    maxY = Math.max(maxY, p.y);
  }
  const bboxW = maxX - minX;
  const bboxH = maxY - minY;
  const minSide = Math.min(bboxW, bboxH);
  if (minSide < FRAME_CONFIG.minWindowSide * Math.min(width, height)) {
    return { valid: false, reason: "too-narrow" };
  }
  const aspect = Math.max(bboxW, bboxH) / Math.max(minSide, 1);
  if (aspect > FRAME_CONFIG.maxAspect) {
    return { valid: false, reason: "too-narrow" };
  }

  return { valid: true, reason: "ok" };
}
