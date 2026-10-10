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
 * When the gesture rules apply. The two tiers exist because a frame is much
 * harder to *start* than to *keep*:
 *
 * - `acquire` is used while SEARCHING/CANDIDATE. The user is still forming the
 *   frame, so the pose is checked at full strictness to make sure they really
 *   mean it — the L must be recognisable.
 * - `track` is used once the selection is LOCKED. The gesture is never
 *   re-validated from then on: the user may relax their fingers, and the frame
 *   must stay connected (the spec is explicit — TEST 12). Only the two anchors
 *   need to remain readable and plausible. A degenerate shape still fails
 *   `isValidQuad` downstream, so dropping the spread check here cannot pin a
 *   collapsed window in place.
 */
export type GestureMode = "acquire" | "track";

/**
 * Verdict for one hand: does it expose two usable corners?
 *
 * Validated against ALL 21 landmarks, not just the thumb and index tips: a
 * detection whose landmarks are incomplete or whose points sit nowhere near
 * the wrist is rejected before its tips can be used as corners. The anchors
 * themselves stay exactly four — thumb tip + index tip per hand — and no
 * bounding box is involved anywhere in this check.
 *
 * Beyond that the only condition (in `acquire` mode) is that the thumb tip and
 * index tip are far enough apart (and the hand big enough) that the two points
 * can serve as corners. No finger-curl rules, no "L" shape requirement, no
 * rectangle condition — the four corners come straight from the landmarks.
 */
function checkHandGesture(hand: Point[], mode: GestureMode): HandGestureVerdict {
  // Acquiring demands a complete MediaPipe hand. Tracking only needs the two
  // anchors to be readable — a frame that loses a few landmarks must not die.
  const minLandmarks = mode === "track" ? HAND_LANDMARK.indexTip + 1 : 21;
  if (hand.length < minLandmarks) {
    return { ok: false, reason: "hand-incomplete" };
  }

  const wrist = hand[HAND_LANDMARK.wrist];
  const palm = dist(wrist, hand[HAND_LANDMARK.middleMcp]);
  const minPalm = mode === "track" ? FRAME_CONFIG.trackMinPalm : FRAME_CONFIG.minPalm;
  if (palm < minPalm) {
    return { ok: false, reason: "hand-too-far" };
  }

  // Every landmark must be reachable from the wrist at the hand's own scale.
  // The bound is looser once locked: this is an anti-teleport guard on the
  // input side, not a gesture rule, so tracking tolerance applies to it too.
  const maxReach =
    palm * (mode === "track" ? FRAME_CONFIG.maxLandmarkReachTrack : FRAME_CONFIG.maxLandmarkReach);
  for (const landmark of hand) {
    if (dist(wrist, landmark) > maxReach) {
      return { ok: false, reason: "landmark-out-of-reach" };
    }
  }

  // The spread check is ACQUIRE-ONLY. Requiring an L every frame after lock is
  // exactly what made the frame drop when the user relaxed their fingers.
  if (mode === "acquire") {
    const separation =
      dist(hand[HAND_LANDMARK.thumbTip], hand[HAND_LANDMARK.indexTip]) / palm;
    if (separation < FRAME_CONFIG.minTipSeparation) {
      return { ok: false, reason: "fingers-not-spread" };
    }
  }

  return { ok: true, reason: "ok" };
}

/**
 * Anchor-only plausibility — the TRACK-mode fallback.
 *
 * The gesture classifier's job is to establish *intent* at lock time. After
 * lock, the window is carried by the fingertips themselves, so a hand that
 * fails the whole-hand check may still supply usable anchors: MediaPipe
 * keeps reporting the thumb and index tips long after an occluded finger it
 * had to extrapolate has wrecked the reach check, and a foreshortened palm
 * at the viewport edge says nothing about whether the two tips are real.
 *
 * Each anchor is therefore vetted on its own. Nothing palm-relative is
 * applied here — the tracker's per-frame jump clamp bounds any anchor that
 * teleported instead of trusting it. A hand that cannot even present its two
 * tips contributes nothing this frame, and its slots are *held* by the
 * tracker rather than invented (see `StickyFrameTracker`).
 */
function checkAnchorsOnly(hand: Point[]): HandGestureVerdict {
  // The two anchors are landmarks 4 and 8; without them there is nothing to take.
  if (hand.length < HAND_LANDMARK.indexTip + 1) {
    return { ok: false, reason: "hand-incomplete" };
  }
  const thumb = hand[HAND_LANDMARK.thumbTip];
  const index = hand[HAND_LANDMARK.indexTip];
  if (!Number.isFinite(thumb.x) || !Number.isFinite(thumb.y)) {
    return { ok: false, reason: "anchor-not-finite" };
  }
  if (!Number.isFinite(index.x) || !Number.isFinite(index.y)) {
    return { ok: false, reason: "anchor-not-finite" };
  }
  return { ok: true, reason: "anchor-fallback" };
}

/**
 * Step 1 — converts raw MediaPipe landmarks into the raw frame corners.
 *
 * Each contributing hand supplies its thumb tip and index tip; the two hands
 * therefore supply the four corners of the frame, with nothing hardcoded:
 * position, size and rotation all follow the hands.
 *
 * `mode` selects the gesture strictness (see `GestureMode`): strict while
 * acquiring, forgiving once the frame is locked. Defaults to `acquire` so
 * callers that do not care keep the old behaviour.
 *
 * The two phases also differ in what a *degraded* hand costs:
 *  - `acquire` needs both hands to pass the full check, so the frame can only
 *    be established by the intended two-hand gesture (four anchors at once).
 *  - `track` takes whatever anchors survived the frame — both hands yield four
 *    corners, one hand yields two, and a hand that lost both its tips yields
 *    none. The tracker holds the slots that got nothing instead of dropping
 *    the window, so a hand lost at the viewport edge degrades the follow on
 *    its own side only.
 */
export function detectHandFrame(
  landmarks: NormalizedLandmark[][],
  width: number,
  height: number,
  mode: GestureMode = "acquire"
): HandFrameDetection {
  const hands = (landmarks ?? []).map((lm) => toPixelLandmarks(lm, width, height));

  // ACQUIRE: the full gesture check decides intent — both hands must pass.
  // TRACK: a hand that fails the whole-hand check is re-vetted on its anchors
  // alone (see `checkAnchorsOnly`), because after lock the fingertips carry
  // the window and one extrapolated or foreshortened landmark must not cost a
  // hand both of them. The verdict records which path won, so the debug
  // readout distinguishes "hand rejected" from "hand degraded to anchors".
  const gestures = hands.map((hand) => {
    const strict = checkHandGesture(hand, mode);
    if (strict.ok || mode !== "track") return strict;
    const fallback = checkAnchorsOnly(hand);
    if (fallback.ok) return { ok: true, reason: `anchor-fallback:${strict.reason}` };
    return strict;
  });

  const contributing = hands.filter((_, i) => gestures[i].ok);

  // Locking still demands both hands. Tracking continues on whatever survived.
  if (contributing.length < (mode === "track" ? 1 : 2)) {
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
    // NOT angularly sorted: the engine reorders the hand arrays by persistent
    // identity (lib/handIdentity.ts) before calling this function, so the
    // corners already come out in a consistent slot order. Sorting by angle
    // here would reintroduce the per-frame reorder that caused anchor swaps.
    corners,
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

  // Sort angularly here (not in detectHandFrame): the rectangle-fit math
  // needs consistently ordered corners, but the tracker must receive the
  // raw hand-identity order so its nearest-slot matching stays stable.
  const sorted = sortAngular(corners);
  const c = centroid(sorted);
  // Opposite edges of a consistently-wound quadrilateral point in opposite
  // directions, so the second direction is reversed before averaging.
  const ax = Math.atan2(sorted[1].y - sorted[0].y, sorted[1].x - sorted[0].x);
  const ax2 = Math.atan2(sorted[2].y - sorted[3].y, sorted[2].x - sorted[3].x);
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
  const e0x = sorted[1].x - sorted[0].x;
  const e0y = sorted[1].y - sorted[0].y;
  if (e0x * ux + e0y * uy < 0) {
    ux = -ux;
    uy = -uy;
  }
  const vx = -uy;
  const vy = ux;

  let minU = Infinity, maxU = -Infinity, minV = Infinity, maxV = -Infinity;
  for (const p of sorted) {
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
 * form. The window may be a trapezoid, asymmetric, tilted, larger than the
 * stage, or partly off-screen: as long as the four corners enclose a single
 * simple area that is not degenerate, it is a valid window.
 *
 * The strictness is split the same way the gesture check is (see
 * `GestureMode`), because "can LOCK here" and "may TRACK there" need different
 * answers — this is the tracking-validity / rendering-validity split:
 *
 *  - `acquire` (default, used while searching): the gesture must enclose a real
 *    window before it may lock, so fractional area and side floors apply. They
 *    are usability floors for locking, not drag limits.
 *  - `track` (used once locked): no maximum size, no aspect ceiling, no
 *    viewport bound. The window follows the hands wherever they go — past the
 *    stage edge (the viewport clips it naturally), down to a small size, tilted
 *    or skewed — and only *genuinely degenerate* geometry is rejected, so a
 *    momentary misread holds instead of releasing the frame.
 *
 * Checks shared by both modes:
 *  - exactly four corners, every coordinate finite (NaN/Infinity poison the
 *    clip path and every downstream computation);
 *  - the polygon is simple (edges do not cross) and consistently wound;
 *  - not a degenerate sliver or a collapsed polygon (mode-dependent floor).
 */
export function isValidQuad(
  corners: Point[],
  width: number,
  height: number,
  mode: GestureMode = "acquire"
): FrameValidity {
  if (corners.length !== 4) return { valid: false, reason: "no-frame" };

  // Numerical safeguard, checked first: non-finite coordinates would sail
  // through every comparison below (NaN < x is false) and reach the clip path.
  for (const p of corners) {
    if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) {
      return { valid: false, reason: "non-finite" };
    }
  }

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

  // Axis-aligned bounding box — the basis for the sliver guards.
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const p of corners) {
    minX = Math.min(minX, p.x);
    maxX = Math.max(maxX, p.x);
    minY = Math.min(minY, p.y);
    maxY = Math.max(maxY, p.y);
  }
  const bboxW = maxX - minX;
  const bboxH = maxY - minY;

  if (mode === "acquire") {
    if (area < FRAME_CONFIG.minAreaFraction * total) {
      return { valid: false, reason: "area-too-small" };
    }
    if (Math.min(bboxW, bboxH) < FRAME_CONFIG.minWindowSide * Math.min(width, height)) {
      return { valid: false, reason: "too-narrow" };
    }
    return { valid: true, reason: "ok" };
  }

  // TRACK: only genuinely degenerate geometry is refused. No size ceiling, no
  // aspect ceiling, no viewport bound — the window may extend past the stage
  // (the viewport clips it naturally) and take any shape the hands form.
  if (area < FRAME_CONFIG.minDegenerateAreaPx) {
    return { valid: false, reason: "degenerate-area" };
  }
  if (Math.min(bboxW, bboxH) < FRAME_CONFIG.minDegenerateSidePx) {
    return { valid: false, reason: "degenerate-sliver" };
  }
  return { valid: true, reason: "ok" };
}
