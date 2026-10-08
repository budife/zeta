/**
 * Pure-logic checks for the hand-frame pipeline. See scripts/run-logic-tests.mjs.
 * Import paths are rewritten at run time, so keep them as `../lib/<name>`.
 */
import { detectHandFrame, calculateFrame, isValidFrame, isValidQuad } from "../lib/handFrame";
import { faceInSelection, computeFaceBox } from "../lib/faceTracking";
import { StickyFrameTracker, TRACK_CONFIG, FORMING_HOLD_FRAMES } from "../lib/frameTracker";
import {
  clipPathPolygon,
  mediaMatrix,
  MIRROR_PREVIEW,
  MIRROR_TRANSFORM,
  normBoxToVideo,
  normalizedToVideo,
  toStageFraction,
  toStagePixels,
  windowToTemplateBox,
} from "../lib/stage";
import {
  advanceRegion,
  classifyRegion,
  coarseRegion,
  regionBox,
  POSE_CONNECTIONS,
  POSE_LANDMARK,
  INITIAL_REGION_LOCK,
  type ClassificationResult,
  type NormBox,
  type RegionKind,
} from "../lib/regions";
import {
  advanceSelection,
  selectionIsActive,
  INITIAL_SELECTION,
  SELECTION_CONFIG,
} from "../lib/selection";
import {
  advanceMode,
  gestureAllowed,
  handFrameAllowed,
  INITIAL_MODE,
} from "../lib/modes";
import { templateRegionFor } from "../lib/templateRegions";
import { mapRegionTransform } from "../lib/regionMapping";
import { advanceFrameActivity, FRAME_CONFIG, INITIAL_FRAME_ACTIVITY } from "../lib/geometry";
import {
  solveSimilarity,
  applySimilarity,
  userFacePoints,
  faceAlignment,
} from "../lib/faceAlignment";

const W = 1280;
const H = 720;

/**
 * Builds a synthetic, reachable 21-landmark hand whose thumb tip and index tip
 * land exactly on the requested points.
 *
 * The wrist is placed 1.5 palms behind the midpoint of the two tips, along the
 * axis across the thumb↔index spread, so every landmark stays within the
 * hand's own reach of the wrist — which is exactly what lib/handFrame.ts
 * validates across all 21 points. The thumb chain is pinned to the requested
 * thumb tip; the index chain likewise; the other three fingers are free.
 */
function hand(thumbTip, indexTip, palm = 60) {
  const T = { x: thumbTip.x, y: thumbTip.y };
  const I = { x: indexTip.x, y: indexTip.y };
  const mid = { x: (T.x + I.x) / 2, y: (T.y + I.y) / 2 };
  const d = { x: I.x - T.x, y: I.y - T.y };
  const spread = Math.hypot(d.x, d.y) || 1;

  // Across the thumb↔index spread; the wrist sits behind the midpoint on it.
  const n = { x: -d.y / spread, y: d.x / spread };
  const wrist = { x: mid.x + n.x * 1.5 * palm, y: mid.y + n.y * 1.5 * palm };
  const f = { x: -n.x, y: -n.y }; // wrist -> fingers
  const s = { x: -f.y, y: f.x }; // across the hand

  /** Landmark `a` palms along the hand and `b` palms across it. */
  const at = (a, b) => ({
    x: wrist.x + (f.x * a + s.x * b) * palm,
    y: wrist.y + (f.y * a + s.y * b) * palm,
    z: 0,
  });
  /** `segments` evenly spaced joints on the straight path from `from` to `to`. */
  const chain = (from, to, segments) => {
    const out = [];
    for (let k = 1; k <= segments; k++) {
      const t = k / segments;
      out.push({
        x: from.x + (to.x - from.x) * t,
        y: from.y + (to.y - from.y) * t,
        z: 0,
      });
    }
    return out;
  };

  const lm = [];
  for (let i = 0; i < 21; i++) lm.push({ x: 0, y: 0, z: 0 });

  lm[0] = at(0, 0); // wrist
  lm[9] = at(1.0, 0); // middle MCP — defines `palm`
  lm[5] = at(0.95, -0.4); // index MCP
  lm[13] = at(0.95, 0.4); // ring MCP
  lm[17] = at(0.85, 0.75); // pinky MCP
  lm[1] = at(0.3, -0.55); // thumb CMC
  lm[2] = at(0.7, -1.0); // thumb MCP

  const thumbTipPt = { x: T.x, y: T.y, z: 0 };
  const indexTipPt = { x: I.x, y: I.y, z: 0 };

  // Thumb: 1 -> 2 already placed, interpolate 2 -> 3 -> 4(thumb tip).
  const thumb = chain(lm[2], thumbTipPt, 2);
  lm[3] = thumb[0];
  lm[4] = thumb[1];

  const index = chain(lm[5], indexTipPt, 3);
  lm[6] = index[0];
  lm[7] = index[1];
  lm[8] = index[2];

  const middle = chain(lm[9], at(2.2, 0), 3);
  lm[10] = middle[0];
  lm[11] = middle[1];
  lm[12] = middle[2];

  const ring = chain(lm[13], at(2.1, 0.55), 3);
  lm[14] = ring[0];
  lm[15] = ring[1];
  lm[16] = ring[2];

  const pinky = chain(lm[17], at(1.9, 1.05), 3);
  lm[18] = pinky[0];
  lm[19] = pinky[1];
  lm[20] = pinky[2];

  return lm;
}

function toNorm(points) {
  return points.map((p) => ({ x: p.x / W, y: p.y / H, z: 0 }));
}

/** Two hands whose thumb/index tips sit at the two given corners. */
function frameHands(topLeft, bottomRight) {
  const a = hand(topLeft, { x: topLeft.x + 260, y: topLeft.y }, 70);
  const b = hand(bottomRight, { x: bottomRight.x - 260, y: bottomRight.y }, 70);
  return [toNorm(a), toNorm(b)];
}

let failures = 0;
function check(name, cond, extra = "") {
  if (cond) {
    console.log(`  PASS  ${name}`);
  } else {
    failures += 1;
    console.log(`  FAIL  ${name} ${extra}`);
  }
}

console.log("\n[1] valid hand frame from two L-gestures");
{
  const hands = frameHands({ x: 340, y: 200 }, { x: 940, y: 520 });
  const det = detectHandFrame(hands, W, H);
  check("detects 2 hands", det.handCount === 2, `got ${det.handCount}`);
  check("both gestures ok", det.gestures.every((g) => g.ok), JSON.stringify(det.gestures));
  check("reason", det.reason === "corners-found", det.reason);
  check("4 corners", det.corners.length === 4, `got ${det.corners.length}`);
  const frame = calculateFrame(det.corners);
  check("frame non-null", frame !== null);
  if (frame) {
    check(
      "center near midpoint",
      Math.hypot(frame.cx - 640, frame.cy - 360) < 60,
      `cx=${frame.cx.toFixed(0)} cy=${frame.cy.toFixed(0)}`
    );
    check("width ~600", Math.abs(frame.width - 600) < 90, `w=${frame.width.toFixed(0)}`);
    check("height ~320", Math.abs(frame.height - 320) < 90, `h=${frame.height.toFixed(0)}`);
    const v = isValidFrame(frame, W, H);
    check("frame valid", v.valid, v.reason);
  }
}

console.log("\n[2] open palm is accepted — only thumb+index spread matters");
{
  const a = hand({ x: 340, y: 200 }, { x: 600, y: 200 });
  const b = hand({ x: 940, y: 520 }, { x: 680, y: 520 });
  for (const h of [a, b]) {
    // Spread middle/ring/pinky (open palm) — previously rejected, now fine.
    h[12] = { x: h[9].x + 60, y: h[9].y + 10, z: 0 };
    h[16] = { x: h[13].x + 60, y: h[13].y + 10, z: 0 };
    h[20] = { x: h[17].x + 60, y: h[17].y + 10, z: 0 };
  }
  const det = detectHandFrame([toNorm(a), toNorm(b)], W, H);
  check("open palms still give 4 corners", det.corners.length === 4, det.reason);
}

console.log("[2b] thumb+index too close on both hands is rejected");
{
  // Both tips nearly on top of each other → no usable corners.
  const a = hand({ x: 400, y: 200 }, { x: 405, y: 202 });
  const b = hand({ x: 900, y: 520 }, { x: 905, y: 518 });
  const det = detectHandFrame([toNorm(a), toNorm(b)], W, H);
  check("no corners when tips coincide", det.corners.length === 0, det.reason);
  check("reason gesture-invalid", det.reason === "gesture-invalid", det.reason);
}

console.log("\n[3] single hand cannot form a frame");
{
  const hands = frameHands({ x: 340, y: 200 }, { x: 940, y: 520 });
  const det = detectHandFrame([hands[0]], W, H);
  check("handCount 1", det.handCount === 1);
  check("no corners", det.corners.length === 0, det.reason);
  check("reason one-hand", det.reason === "one-hand-detected", det.reason);
}

console.log("\n[4] tiny frame rejected");
{
  const hands = frameHands({ x: 620, y: 340 }, { x: 680, y: 380 });
  const det = detectHandFrame(hands, W, H);
  const frame = calculateFrame(det.corners);
  const v = isValidFrame(frame, W, H);
  check("tiny frame invalid", !v.valid, v.reason);
}

console.log("\n[5] rotated frame keeps correct rotation");
{
  const cx = 640, cy = 360, ang = (20 * Math.PI) / 180;
  const local = [
    { x: -250, y: -150 }, { x: 250, y: -150 }, { x: 250, y: 150 }, { x: -250, y: 150 },
  ];
  const corners = local.map((p) => ({
    x: cx + p.x * Math.cos(ang) - p.y * Math.sin(ang),
    y: cy + p.x * Math.sin(ang) + p.y * Math.cos(ang),
  }));
  const frame = calculateFrame(corners);
  check("rotation ~20deg", frame !== null && Math.abs(frame.rotation - 20) < 4, `r=${frame?.rotation.toFixed(1)}`);
  check("width ~500", frame !== null && Math.abs(frame.width - 500) < 30, `w=${frame?.width.toFixed(0)}`);
  check("height ~300", frame !== null && Math.abs(frame.height - 300) < 30, `h=${frame?.height.toFixed(0)}`);
}

console.log("\n[6] face in selection");
{
  const frame = { cx: 640, cy: 360, width: 500, height: 320, rotation: 0 };
  const inside = { x: 640 - 60, y: 360 - 60, width: 120, height: 150 };
  const outside = { x: 1100, y: 100, width: 120, height: 150 };
  check("inside face detected in frame", faceInSelection(inside, frame));
  check("outside face not in frame", !faceInSelection(outside, frame));
  const lm = [];
  for (let i = 0; i < 100; i++) {
    lm.push({ x: (600 + (i % 10) * 8) / W, y: (300 + Math.floor(i / 10) * 12) / H, z: 0 });
  }
  const box = computeFaceBox(lm, W, H);
  check("face box computed", box !== null && box.width > 0 && box.height > 0, JSON.stringify(box));
}

console.log("\n[8] sticky tracker snaps, then eases toward the target");
{
  const t = new StickyFrameTracker();
  const first = t.update(
    [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }, { x: 0, y: 100 }],
    0.016
  );
  check("snap on first frame", first.length === 4 && Math.abs(first[0].x) < 0.001 && Math.abs(first[2].y - 100) < 0.001, JSON.stringify(first));

  const next = t.update(
    [{ x: 10, y: 0 }, { x: 110, y: 0 }, { x: 110, y: 100 }, { x: 10, y: 100 }],
    0.016
  );
  check("corners ease toward target, not all the way", next[0].x > 0 && next[0].x < 10, `x=${next[0].x.toFixed(2)}`);
  check("state is tracking while hands are seen", t.state === "tracking", t.state);
  check("missed is zero while tracking", t.missedFrames === 0, `${t.missedFrames}`);

  t.reset();
  const afterReset = t.update(
    [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }, { x: 0, y: 100 }],
    0.016
  );
  check("reset snaps again", afterReset.every((p) => Math.abs(p.y) < 0.001 || Math.abs(p.y - 100) < 0.001), JSON.stringify(afterReset));

  // A short/degenerate input is a MISS, not a passthrough that corrupts the
  // window: the spec forbids `corners = []` on a single bad frame.
  const bad = t.update([{ x: 0, y: 0 }, { x: 1, y: 1 }], 0.016);
  check("degenerate input keeps the last window", bad.length === 4, JSON.stringify(bad));
  check("missed increments", t.missedFrames === 1, `${t.missedFrames}`);
  check("state degrades to holding", t.state === "holding", t.state);
}

console.log("\n[9] sticky tracker pairs corners, so a tilt rotates instead of flipping");
{
  const t = new StickyFrameTracker();
  const base = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }, { x: 0, y: 100 }];
  t.update(base, 0.016);

  // The same window rotated 30 degrees: nearest-corner pairing must keep each
  // corner on the same fingertip, so the polygon rotates as one object.
  const rad = (30 * Math.PI) / 180;
  const rot = base.map((p) => {
    const dx = p.x - 50;
    const dy = p.y - 50;
    return {
      x: 50 + dx * Math.cos(rad) - dy * Math.sin(rad),
      y: 50 + dx * Math.sin(rad) + dy * Math.cos(rad),
    };
  });
  const rotated = t.update(rot, 0.016);
  // A 30 deg rotation moves each corner ~37px. A corner-swap (the flip the
  // spec warns about) would move two corners the full side length, ~100px.
  const worst = Math.max(...rotated.map((p, i) => Math.hypot(p.x - base[i].x, p.y - base[i].y)));
  check("no corner swapped identity", worst < 60, `worst=${worst.toFixed(1)}`);

  // A trapezoid stays a trapezoid: corners ease independently and are never
  // pulled back to a rectangle.
  t.reset();
  const trapTarget = [
    { x: 40, y: 0 }, { x: 60, y: 0 }, { x: 120, y: 100 }, { x: -20, y: 100 },
  ];
  let trap = t.update(trapTarget, 0.016);
  for (let i = 0; i < 60; i++) trap = t.update(trapTarget, 0.016);
  const topW = Math.hypot(trap[1].x - trap[0].x, trap[1].y - trap[0].y);
  const botW = Math.hypot(trap[2].x - trap[3].x, trap[2].y - trap[3].y);
  check("trapezoid shape preserved", Math.abs(topW - botW) > 30, `top=${topW.toFixed(1)} bot=${botW.toFixed(1)}`);
}

console.log("\n[10] empty hands / degenerate inputs");
{
  const det = detectHandFrame([], W, H);
  check("no hands reported", det.handCount === 0 && det.corners.length === 0, det.reason);
  check("reason hands-not-detected", det.reason === "hands-not-detected", det.reason);
  check("calculateFrame([]) => null", calculateFrame([]) === null);
  check("isValidFrame(null) => invalid", !isValidFrame(null, W, H).valid);
  check("calculateFrame(2 pts) => null", calculateFrame([{ x: 1, y: 1 }, { x: 2, y: 2 }]) === null);
}

console.log("\n[11] frame activation hysteresis");
{
  check("starts inactive", INITIAL_FRAME_ACTIVITY.active === false);

  let state = INITIAL_FRAME_ACTIVITY;

  // activation needs activateAfter consecutive valid frames
  let r = advanceFrameActivity(state, true);
  check("first valid frame does not activate", !r.state.active && !r.activated, JSON.stringify(r.state));
  state = r.state;
  r = advanceFrameActivity(state, true);
  check(
    `activates on frame ${FRAME_CONFIG.activateAfter}`,
    r.state.active && r.activated,
    JSON.stringify(r.state)
  );
  state = r.state;

  // a single blip must not deactivate, and must reset the valid streak
  r = advanceFrameActivity(state, false);
  check("one invalid frame keeps it active", r.state.active && !r.deactivated, JSON.stringify(r.state));
  check("invalid streak counts up", r.state.invalidStreak === 1, `${r.state.invalidStreak}`);
  check("valid streak reset by invalid frame", r.state.validStreak === 0, `${r.state.validStreak}`);
  state = r.state;

  // a valid frame clears the invalid streak before deactivateAfter is reached
  r = advanceFrameActivity(state, true);
  check(
    "valid frame clears the invalid streak",
    r.state.invalidStreak === 0 && r.state.validStreak === 1 && r.state.active,
    JSON.stringify(r.state)
  );
  check("no transition reported", !r.activated && !r.deactivated);
  state = r.state;

  // deactivation needs deactivateAfter consecutive invalid frames
  let deactivatedAfter = -1;
  for (let i = 1; i <= FRAME_CONFIG.deactivateAfter + 2; i++) {
    r = advanceFrameActivity(state, false);
    state = r.state;
    if (r.deactivated) {
      deactivatedAfter = i;
      break;
    }
  }
  check(
    `deactivates after ${FRAME_CONFIG.deactivateAfter} invalid frames`,
    deactivatedAfter === FRAME_CONFIG.deactivateAfter,
    `at ${deactivatedAfter}`
  );
  check("inactive after deactivation", state.active === false);
  check("activated and deactivated are mutually exclusive", !(r.activated && r.deactivated));

  // the cycle restarts cleanly
  r = advanceFrameActivity(state, true);
  check(
    "valid streak restarts from inactive",
    !r.state.active && !r.activated && r.state.validStreak === 1,
    JSON.stringify(r.state)
  );
}

console.log("\n[12] quadrilateral tolerance (window may be skewed)");
{
  const W = 1280, H = 720;
  // Well-formed rectangle is accepted.
  const rect = [
    { x: 300, y: 200 }, { x: 900, y: 200 },
    { x: 900, y: 520 }, { x: 300, y: 520 },
  ];
  check("rectangle is a valid window", isValidQuad(rect, W, H).valid, isValidQuad(rect, W, H).reason);

  // Trapezoid: top edge much narrower than the bottom — the classic
  // perspective frame, and exactly what isValidFrame used to reject.
  const trap = [
    { x: 400, y: 200 }, { x: 800, y: 200 },
    { x: 980, y: 520 }, { x: 220, y: 520 },
  ];
  check("trapezoid is valid", isValidQuad(trap, W, H).valid, isValidQuad(trap, W, H).reason);

  // Asymmetric: one hand higher than the other, sides not parallel.
  const skew = [
    { x: 300, y: 150 }, { x: 920, y: 260 },
    { x: 880, y: 540 }, { x: 340, y: 500 },
  ];
  check("asymmetric quad is valid", isValidQuad(skew, W, H).valid, isValidQuad(skew, W, H).reason);

  // Bowtie / self-intersecting must be rejected.
  const bowtie = [
    { x: 300, y: 200 }, { x: 900, y: 520 },
    { x: 900, y: 200 }, { x: 300, y: 520 },
  ];
  check("bowtie rejected", !isValidQuad(bowtie, W, H).valid, isValidQuad(bowtie, W, H).reason);

  // Tiny quad rejected on area.
  const tiny = [
    { x: 630, y: 350 }, { x: 650, y: 350 },
    { x: 650, y: 370 }, { x: 630, y: 370 },
  ];
  check("tiny quad rejected", !isValidQuad(tiny, W, H).valid, isValidQuad(tiny, W, H).reason);

  // Sliver rejected on minWindowSide.
  const sliver = [
    { x: 100, y: 100 }, { x: 1180, y: 108 },
    { x: 1180, y: 112 }, { x: 100, y: 116 },
  ];
  check("sliver rejected", !isValidQuad(sliver, W, H).valid, isValidQuad(sliver, W, H).reason);

  // Wrong corner count rejected.
  check("3 corners rejected", !isValidQuad(rect.slice(0, 3), W, H).valid);
  check("empty rejected", !isValidQuad([], W, H).valid);
}

console.log("\n[13] sticky tracker clamps a teleport instead of trusting it");
{
  const t = new StickyFrameTracker();
  const base = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }, { x: 0, y: 100 }];
  t.update(base, 0.016);

  // The whole window "teleports" 500px right in one frame. Diagonal is ~141,
  // so the clamp caps a single corner's step at 0.4 * 141 ~= 56px, and easing
  // only closes a fraction of that. Measured at the centroid — the corners get
  // re-paired under a shift, so per-index comparison is meaningless — the
  // unclamped centroid would jump 500 * alpha ~= 117px in this one frame.
  const tele = base.map((p) => ({ x: p.x + 500, y: p.y }));
  const out = t.update(tele, 0.016);
  const cx0 = base.reduce((s, p) => s + p.x, 0) / 4;
  const cx1 = out.reduce((s, p) => s + p.x, 0) / 4;
  const moved = Math.abs(cx1 - cx0);
  const limit = TRACK_CONFIG.maxJumpFraction * Math.hypot(100, 100);
  check("window not yanked by a teleport", moved <= limit, `moved=${moved.toFixed(1)} limit=${limit.toFixed(1)}`);
  check("but it did start moving", moved > 0, `moved=${moved.toFixed(1)}`);
}

console.log("\n[14] clip-path polygon mapping");
{
  const W = 1280, H = 720;
  const corners = [
    { x: 320, y: 180 }, { x: 960, y: 180 },
    { x: 960, y: 540 }, { x: 320, y: 540 },
  ];
  const poly = clipPathPolygon(corners, W, H);
  const parts = poly.split(", ");
  check("four polygon points", parts.length === 4, `${parts.length}`);
  // Mirror flips x, y is untouched: corner (320,180) -> x = 1 - 0.25 = 0.75.
  const [x0, y0] = parts[0].split(" ").map((v) => Number(v.replace("%", "")));
  check(
    "mirror applied to x",
    MIRROR_PREVIEW ? Math.abs(x0 - 75) < 0.01 : Math.abs(x0 - 25) < 0.01,
    parts[0]
  );
  check("y not flipped", Math.abs(y0 - 25) < 0.01, parts[0]);
  // A trapezoid produces four DISTINCT points — the polygon keeps its shape.
  const trap = [
    { x: 400, y: 180 }, { x: 800, y: 180 },
    { x: 960, y: 540 }, { x: 240, y: 540 },
  ];
  const tparts = clipPathPolygon(trap, W, H).split(", ");
  const unique = new Set(tparts);
  check("trapezoid keeps 4 distinct points", unique.size === 4, `${unique.size}`);
}

console.log("\n[15] region classification picks the framed body part");
{
  // Synthetic pose landmarks: a person roughly centered, facing the camera.
  // Landmark indices are MediaPipe's; only the ones the regions read matter.
  const pose = Array.from({ length: 33 }, () => ({ x: 0.5, y: 0.5, z: 0 }));
  pose[0] = { x: 0.5, y: 0.22, z: 0 };   // nose
  pose[2] = { x: 0.46, y: 0.2, z: 0 };   // left eye
  pose[5] = { x: 0.54, y: 0.2, z: 0 };   // right eye
  pose[7] = { x: 0.42, y: 0.22, z: 0 };  // left ear
  pose[8] = { x: 0.58, y: 0.22, z: 0 };  // right ear
  pose[11] = { x: 0.4, y: 0.42, z: 0 };  // left shoulder
  pose[12] = { x: 0.6, y: 0.42, z: 0 };  // right shoulder
  pose[15] = { x: 0.28, y: 0.7, z: 0 };  // left wrist
  pose[16] = { x: 0.72, y: 0.7, z: 0 };  // right wrist
  pose[23] = { x: 0.42, y: 0.72, z: 0 }; // left hip
  pose[24] = { x: 0.58, y: 0.72, z: 0 }; // right hip
  pose[25] = { x: 0.44, y: 0.88, z: 0 }; // left knee
  pose[26] = { x: 0.56, y: 0.88, z: 0 }; // right knee

  // Synthetic face landmarks: eyes above a face box.
  const face = Array.from({ length: 478 }, () => ({ x: 0.5, y: 0.25, z: 0 }));
  face[468] = { x: 0.46, y: 0.2, z: 0 };  // left eye center
  face[473] = { x: 0.54, y: 0.2, z: 0 };  // right eye center
  face[10] = { x: 0.5, y: 0.14, z: 0 };   // forehead
  face[152] = { x: 0.5, y: 0.3, z: 0 };   // chin
  face[234] = { x: 0.42, y: 0.22, z: 0 }; // left cheek
  face[454] = { x: 0.58, y: 0.22, z: 0 }; // right cheek

  const eyeWindow: NormBox = { x: 0.41, y: 0.17, width: 0.18, height: 0.08 };
  const faceWindow: NormBox = { x: 0.38, y: 0.13, width: 0.24, height: 0.22 };
  const torsoWindow: NormBox = { x: 0.38, y: 0.45, width: 0.24, height: 0.3 };
  const handWindow: NormBox = { x: 0.22, y: 0.62, width: 0.14, height: 0.16 };

  const eyes = classifyRegion(eyeWindow, pose, face);
  check("tight window on eyes → eyes", coarseRegion(eyes.region) === "eyes", `${eyes.region} conf=${eyes.confidence.toFixed(2)}`);

  const f = classifyRegion(faceWindow, pose, face);
  check("window on face → face (not eyes)", coarseRegion(f.region) === "face", `${f.region} conf=${f.confidence.toFixed(2)}`);

  const t = classifyRegion(torsoWindow, pose, face);
  check("window on torso → torso", coarseRegion(t.region) === "torso", `${t.region} conf=${t.confidence.toFixed(2)}`);

  const h = classifyRegion(handWindow, pose, face);
  check("window on wrist → hand", coarseRegion(h.region) === "left-hand" || coarseRegion(h.region) === "right-hand", `${h.region} conf=${h.confidence.toFixed(2)}`);

  // No landmarks at all → null region, renderer falls back.
  const none = classifyRegion(eyeWindow, null, null);
  check("no landmarks → null region", none.region === null, `${none.region}`);

  // A window out in the weeds has low confidence.
  const far: NormBox = { x: 0.02, y: 0.02, width: 0.08, height: 0.08 };
  const farRes = classifyRegion(far, pose, face);
  check("off-body window → low confidence", farRes.confidence < 0.35, `${farRes.confidence.toFixed(2)} (${farRes.region})`);

  // regionBox tolerates missing indices.
  check("regionBox handles missing indices", regionBox(face, [9999]) === null);
}

console.log("\n[16] region → template transform");
{
  const W = 1280, H = 720;
  const bigWindow = { width: 500, height: 500 };
  const smallWindow = { width: 120, height: 80 };

  const headBig = mapRegionTransform("head", bigWindow, W, H);
  const headSmall = mapRegionTransform("head", smallWindow, W, H);
  check("bigger window on same region zooms in more", headBig.scale > headSmall.scale, `${headBig.scale.toFixed(2)} vs ${headSmall.scale.toFixed(2)}`);
  // Cover scale = max(1280/1100, 720/620) ≈ 1.1636. The template is centered
  // by object-fit: cover, so after cover the origin is shifted (especially Y
  // because rendered height > video height).
  const expectedHeadOrigY = (-(720 - 620 * 1.163636) / 2 + (60 + 560 / 2) * 1.163636) / 720;
  check("origin inside template after cover",
    Math.abs(headBig.originX - 0.5) < 0.001 &&
    Math.abs(headBig.originY - expectedHeadOrigY) < 0.01,
    `${headBig.originX.toFixed(4)},${headBig.originY.toFixed(4)} (expected 0.5, ~${expectedHeadOrigY.toFixed(4)})`);

  // A window much larger than the region zooms the region in past 1.
  const zoomedIn = mapRegionTransform("eyes", { width: 900, height: 500 }, W, H);
  check("window bigger than region zooms in", zoomedIn.scale > 1, `${zoomedIn.scale.toFixed(2)}`);

  // Fallback for null/unknown uses the full viewBox → origin at the center of
  // the rendered source (which is centered in the stage).
  const fallback = mapRegionTransform(null, bigWindow, W, H);
  check("null region still transforms", fallback.scale > 0, `${fallback.scale.toFixed(2)}`);
  const unknown = mapRegionTransform("left-foot", bigWindow, W, H);
  const expectedUnkOrigY = (-(720 - 620 * 1.163636) / 2 + (620 / 2) * 1.163636) / 720;
  check("unknown region uses whole template", unknown.originX === 0.5 && Math.abs(unknown.originY - expectedUnkOrigY) < 0.01, `${unknown.originX.toFixed(4)},${unknown.originY.toFixed(4)}`);
  check("template region lookup", templateRegionFor("eyes").width === 440, `${templateRegionFor("eyes").width}`);
  check("template default = whole viewBox", templateRegionFor(null).width === 1100, `${templateRegionFor(null).width}`);
}

console.log("\n[18] selection state machine");
{
  const valid = { valid: true, hasCorners: true };
  const invalid = { valid: false, hasCorners: false };

  let s = advanceSelection(INITIAL_SELECTION, invalid);
  check("starts searching, invalid stays searching", s.state.phase === "searching", `${s.state.phase}`);

  s = advanceSelection(INITIAL_SELECTION, valid);
  check("first valid -> candidate", s.state.phase === "candidate", `${s.state.phase}`);

  s = advanceSelection(s.state, valid);
  check("second valid -> locked", s.state.phase === "locked", `${s.state.phase}`);
  check("activated", s.activated, `${s.activated}`);
  check("not deactivated", !s.deactivated, `${s.deactivated}`);

  s = advanceSelection(s.state, invalid);
  check("single dropout stays locked", s.state.phase === "locked", `${s.state.phase}`);

  // Many consecutive dropouts → releasing → searching.
  for (let i = 0; i < 3; i++) {
    s = advanceSelection(s.state, invalid);
  }
  check("sustained failures -> releasing", s.state.phase === "releasing", `${s.state.phase}`);
  check("not deactivated yet", !s.deactivated, `${s.deactivated}`);

  // Two more frames finish the tail → back to searching.
  for (let i = 0; i < 2; i++) {
    s = advanceSelection(s.state, invalid);
  }
  check("releasing tail ends -> searching", s.state.phase === "searching", `${s.state.phase}`);
  check("deactivated", s.deactivated, `${s.deactivated}`);

  let s2 = advanceSelection(INITIAL_SELECTION, valid);
  s2 = advanceSelection(s2.state, valid);
  s2 = advanceSelection(s2.state, invalid);
  s2 = advanceSelection(s2.state, invalid);
  s2 = advanceSelection(s2.state, invalid);
  s2 = advanceSelection(s2.state, invalid);
  check("entered releasing", s2.state.phase === "releasing", `${s2.state.phase}`);
  s2 = advanceSelection(s2.state, valid);
  check("recaptured during releasing -> locked", s2.state.phase === "locked", `${s2.state.phase}`);
  check("not deactivated", !s2.deactivated, `${s2.deactivated}`);
}

console.log("\n[19] window -> template crop box");

{
  const TW = 1100, TH = 620;

  // Invalid input.
  check(
    "fewer than 4 corners -> null",
    windowToTemplateBox([], 640, 480, TW, TH) === null
  );

  // Video 640x480, template 1100x620.
  // cover = max(640/1100, 480/620) = max(0.5818, 0.7742) = 0.7742
  // rendered = 1100*0.7742 x 620*0.7742 = 851.6 x 480
  // offsetX = (640 - 851.6)/2 = -105.8, offsetY = 0
  // Center box in video: 160..480 x 120..360
  // sx = (160 - (-105.8)) / 0.7742 = 343.3
  // sy = (120 - 0) / 0.7742 = 155.0
  // sw = 320 / 0.7742 = 413.3, sh = 240 / 0.7742 = 310.0
  const center = windowToTemplateBox(
    [
      { x: 160, y: 120 },
      { x: 480, y: 120 },
      { x: 480, y: 360 },
      { x: 160, y: 360 },
    ],
    640,
    480,
    TW,
    TH
  )!;
  check("center box has positive size", center.width > 0 && center.height > 0);
  check(
    `center box x ~343 (got ${center.x})`,
    Math.abs(center.x - 343) <= 2
  );
  check(
    `center box y ~155 (got ${center.y})`,
    Math.abs(center.y - 155) <= 2
  );
  check(
    `center box width ~413 (got ${center.width})`,
    Math.abs(center.width - 413) <= 2
  );
  check(
    `center box height ~310 (got ${center.height})`,
    Math.abs(center.height - 310) <= 2
  );

  // Full-video corners map to a box clamped inside the template.
  const full = windowToTemplateBox(
    [
      { x: 0, y: 0 },
      { x: 640, y: 0 },
      { x: 640, y: 480 },
      { x: 0, y: 480 },
    ],
    640,
    480,
    TW,
    TH
  )!;
  check(
    "full-video box fits inside template",
    full.x >= 0 && full.y >= 0 && full.x + full.width <= TW && full.y + full.height <= TH
  );
  // Template is wider than the video aspect, so the video's full width maps
  // to a centered horizontal slice: x = (0 - offsetX)/cover = 105.8/0.7742 ~ 137.
  check(
    `full-video box x centered (got ${full.x})`,
    Math.abs(full.x - 137) <= 2
  );
  check(
    `full-video box y = 0 (got ${full.y})`,
    full.y === 0
  );

  // Tiny window stays non-degenerate.
  const tiny = windowToTemplateBox(
    [
      { x: 319, y: 239 },
      { x: 321, y: 239 },
      { x: 321, y: 241 },
      { x: 319, y: 241 },
    ],
    640,
    480,
    TW,
    TH
  )!;
  check("tiny window -> positive size", tiny.width > 0 && tiny.height > 0);
}

console.log("\n[20] candidate tolerates short noise (TEST E)");

{
  const valid = { valid: true, hasCorners: true };
  const invalid = { valid: false, hasCorners: false };

  // Enter candidate with one valid frame.
  let s = advanceSelection(INITIAL_SELECTION, valid);
  check("in candidate", s.state.phase === "candidate", s.state.phase);

  // A single bad frame must NOT reset the acquisition.
  s = advanceSelection(s.state, invalid);
  check(
    "1 bad frame stays candidate",
    s.state.phase === "candidate",
    s.state.phase
  );
  s = advanceSelection(s.state, valid);
  check("valid again -> still candidate/streak up", s.state.phase === "candidate" || s.state.phase === "locked", s.state.phase);
  s = advanceSelection(s.state, valid);
  check("locks after grace", s.state.phase === "locked", s.state.phase);

  // Sustained failure during candidate still resets.
  s = advanceSelection(INITIAL_SELECTION, valid);
  for (let i = 0; i < SELECTION_CONFIG.candidateGraceFrames; i++) {
    s = advanceSelection(s.state, invalid);
  }
  check(
    "sustained failure during candidate -> searching",
    s.state.phase === "searching",
    s.state.phase
  );

  // TEST E: one frame of tracking dropout while locked keeps last corners
  // (engine holds the sticky tracker's last window — phase must stay locked).
  s = advanceSelection(INITIAL_SELECTION, valid);
  s = advanceSelection(s.state, valid);
  check("locked", s.state.phase === "locked", s.state.phase);
  s = advanceSelection(s.state, invalid);
  check("single dropout -> still locked", s.state.phase === "locked", s.state.phase);
}

console.log("\n[21] trapezoid / tilted quads stay valid (TEST B/C/D)");

{
  // Trapezoid: top edge shorter than bottom, non-90° corners.
  const trap = [
    { x: 440, y: 160 },
    { x: 840, y: 200 },
    { x: 940, y: 560 },
    { x: 340, y: 520 },
  ];
  const v1 = isValidQuad(trap, W, H);
  check("trapezoid valid", v1.valid, v1.reason);

  // Strongly tilted rectangle (~35°).
  const ang = (35 * Math.PI) / 180;
  const cx = 640, cy = 360;
  const local = [
    { x: -280, y: -170 }, { x: 280, y: -170 },
    { x: 280, y: 170 }, { x: -280, y: 170 },
  ];
  const tilted = local.map((p) => ({
    x: cx + p.x * Math.cos(ang) - p.y * Math.sin(ang),
    y: cy + p.x * Math.sin(ang) + p.y * Math.cos(ang),
  }));
  const v2 = isValidQuad(tilted, W, H);
  check("35° tilted quad valid", v2.valid, v2.reason);

  // Asymmetric heights (left hand higher than right hand).
  const asym = [
    { x: 360, y: 80 },
    { x: 920, y: 300 },
    { x: 900, y: 640 },
    { x: 380, y: 460 },
  ];
  const v3 = isValidQuad(asym, W, H);
  check("asymmetric quad valid", v3.valid, v3.reason);

  // Bowtie (crossed polygon) must still be rejected.
  const bowtie = [
    { x: 360, y: 160 },
    { x: 920, y: 560 },
    { x: 920, y: 160 },
    { x: 360, y: 560 },
  ];
  const v4 = isValidQuad(bowtie, W, H);
  check("bowtie rejected", !v4.valid, v4.reason);
}

console.log("\n[22] face alignment (similarity solve)");

{
  const src = [
    { x: 100, y: 100 },
    { x: 200, y: 100 },
    { x: 150, y: 160 },
    { x: 150, y: 220 },
  ];

  // Identity: target == source.
  const id = solveSimilarity(src, src)!;
  check("identity scale ~1", Math.abs(id.scale - 1) < 1e-6, `${id.scale}`);
  check("identity rotation ~0", Math.abs(id.rotation) < 1e-6, `${id.rotation}`);
  check("identity translation ~0", Math.abs(id.tx) < 1e-6 && Math.abs(id.ty) < 1e-6);

  // Pure translation.
  const moved = src.map((p) => ({ x: p.x + 40, y: p.y - 25 }));
  const t = solveSimilarity(src, moved)!;
  check("translation tx=40", Math.abs(t.tx - 40) < 1e-6, `${t.tx}`);
  check("translation ty=-25", Math.abs(t.ty + 25) < 1e-6, `${t.ty}`);
  check("translation keeps scale", Math.abs(t.scale - 1) < 1e-6);

  // Rotation 30° around origin-ish + scale 2.
  const theta = (30 * Math.PI) / 180;
  const rt = { scale: 2, rotation: theta, tx: 10, ty: 20 };
  const target = src.map((p) => applySimilarity(rt, p));
  const solved = solveSimilarity(src, target)!;
  check("solved scale ~2", Math.abs(solved.scale - 2) < 1e-6, `${solved.scale}`);
  check("solved rotation ~30°", Math.abs(solved.rotation - theta) < 1e-6, `${solved.rotation}`);
  check("solved tx ~10", Math.abs(solved.tx - 10) < 1e-6, `${solved.tx}`);
  check("solved ty ~20", Math.abs(solved.ty - 20) < 1e-6, `${solved.ty}`);

  // Roundtrip: applying solved to source reproduces target.
  const p0 = applySimilarity(solved, src[2]);
  check(
    "roundtrip point",
    Math.hypot(p0.x - target[2].x, p0.y - target[2].y) < 1e-6
  );

  // Degenerate inputs.
  check("single point -> null", solveSimilarity([{ x: 0, y: 0 }], [{ x: 1, y: 1 }]) === null);
  check("empty -> null", solveSimilarity([], []) === null);
  check("coincident source -> null",
    solveSimilarity(
      [{ x: 5, y: 5 }, { x: 5, y: 5 }],
      [{ x: 1, y: 1 }, { x: 2, y: 2 }]
    ) === null
  );

  // userFacePoints from a synthetic 478-landmark set.
  const lm: { x: number; y: number; z: number }[] = [];
  for (let i = 0; i < 478; i++) lm.push({ x: 0, y: 0, z: 0 });
  lm[33] = { x: 0.30, y: 0.40, z: 0 };
  lm[133] = { x: 0.36, y: 0.40, z: 0 };
  lm[263] = { x: 0.64, y: 0.41, z: 0 };
  lm[362] = { x: 0.58, y: 0.41, z: 0 };
  lm[4] = { x: 0.47, y: 0.55, z: 0 };
  lm[61] = { x: 0.42, y: 0.68, z: 0 };
  lm[291] = { x: 0.54, y: 0.68, z: 0 };
  const fp = userFacePoints(lm)!;
  check("left eye center", Math.abs(fp.leftEye.x - 0.33) < 1e-9 && Math.abs(fp.leftEye.y - 0.40) < 1e-9);
  check("right eye center", Math.abs(fp.rightEye.x - 0.61) < 1e-9);
  check("nose", Math.abs(fp.nose.x - 0.47) < 1e-9);
  check("mouth center", Math.abs(fp.mouth.x - 0.48) < 1e-9 && Math.abs(fp.mouth.y - 0.68) < 1e-9);
  check("missing landmarks -> null", userFacePoints(lm.slice(0, 100)) === null);
  check("null -> null", userFacePoints(null) === null);

  // faceAlignment: null user points -> identity; real points -> finite.
  const ident = faceAlignment(null, W, H);
  check("null user -> identity", ident.scale === 1 && ident.rotation === 0);
  const aligned = faceAlignment(fp, W, H);
  check("aligned scale finite > 0", Number.isFinite(aligned.scale) && aligned.scale > 0, `${aligned.scale}`);
  check("aligned rotation finite", Number.isFinite(aligned.rotation));
}

console.log("\n[23] media matrix = mirror o similarity (not a 180 rotation)");
{
  const near = (m, x, y, wantX, wantY, tol = 1e-6) =>
    Math.abs(m.a * x + m.c * y + m.e - wantX) < tol &&
    Math.abs(m.b * x + m.d * y + m.f - wantY) < tol;

  // Identity alignment: the matrix must be a pure horizontal reflection,
  // x -> stageW - x and y -> y. A 180 degree rotation maps y -> -y, which
  // throws the whole image off the top of the stage (it renders invisible)
  // and looks upside down when part of it is still on screen.
  {
    const m = mediaMatrix(null, 1280, 1280);
    check("identity mirrors x", near(m, 0, 0, 1280, 0) && near(m, 200, 300, 1080, 300));
    check("identity keeps y sign", near(m, 0, 720, 1280, 720) && near(m, 40, 700, 1240, 700));
  }

  // Rotation + translation: the result must be M(S(p)) — the mirror applied
  // AFTER the similarity, with only the X row negated.
  {
    const s = 2;
    const align = { scale: s, rotation: 0, tx: 0, ty: -100 };
    // S(200,300) = (400, 500) -> mirrored x = 1280 - 400 = 880
    const m = mediaMatrix(align, 1280, 1280);
    check("scale+translate, then mirror", near(m, 200, 300, 880, 500));
  }

  {
    // 90 degrees: S(x,y) = (100 - y, x + 50); mirror x about 1000.
    const align = { scale: 1, rotation: Math.PI / 2, tx: 100, ty: 50 };
    const m = mediaMatrix(align, 1000, 1000);
    // S(300,200) = (-100, 350) -> mirrored x = 1000 - (-100) = 1100
    check("rotation, then mirror", near(m, 300, 200, 1100, 350));
    // S(0,0) = (100, 50) -> mirrored x = 900
    check("rotation about origin", near(m, 0, 0, 900, 50));
  }

  // Translation is in video px and must be scaled to stage px.
  {
    const align = { scale: 1, rotation: 0, tx: 10, ty: 10 };
    const m = mediaMatrix(align, 640, 1280); // k = 2
    // S(0,0) = (20, 20) -> mirrored x = 1280 - 20 = 1260
    check("video px translation scaled to stage px", near(m, 0, 0, 1260, 20));
  }
}

console.log("\n[24] single coordinate mapping chain (normalized -> video -> stage)");
{
  const VW = 1280, VH = 720;
  const SW = 960, SH = 540; // same aspect as the video, as page.tsx guarantees

  // Link 1: normalized -> video intrinsic pixels.
  const v = normalizedToVideo({ x: 0.75, y: 0.25 }, VW, VH);
  check("normalizedToVideo", v.x === 960 && v.y === 180);

  // Link 2: video px -> stage fraction. The mirror flips X only — never Y.
  const f = toStageFraction({ x: 320, y: 100 }, VW, VH);
  check(
    "toStageFraction mirrors x only",
    MIRROR_PREVIEW
      ? Math.abs(f.x - (1 - 320 / VW)) < 1e-12 && f.y === 100 / VH
      : Math.abs(f.x - 320 / VW) < 1e-12 && f.y === 100 / VH
  );

  // Link 3 must be link 2 times the stage size — they share one body, so a
  // percentage overlay and a canvas overlay land on the same pixel.
  const px = toStagePixels({ x: 320, y: 100 }, VW, VH, SW, SH);
  check(
    "toStagePixels = fraction x stage size",
    Math.abs(px.x - f.x * SW) < 1e-9 && Math.abs(px.y - f.y * SH) < 1e-9
  );

  // Full chain for a landmark, both ends.
  const lm = { x: 0.72, y: 0.31 };
  const stage = toStagePixels(normalizedToVideo(lm, VW, VH), VW, VH, SW, SH);
  const wantFrac = MIRROR_PREVIEW ? 1 - 0.72 : 0.72;
  check(
    "normalized -> stage matches example readout",
    Math.abs(stage.x - wantFrac * SW) < 1e-9 && Math.abs(stage.y - 0.31 * SH) < 1e-9
  );

  // Normalized box -> video px box. A NormBox fed straight to placeBox()
  // collapses to ~0,0 with ~0 size; this is the conversion that prevents it.
  const nb = normBoxToVideo({ x: 0.4, y: 0.3, width: 0.2, height: 0.25 }, VW, VH);
  check(
    "normBoxToVideo scales all four fields",
    nb.x === 512 && nb.y === 216 && nb.width === 256 && nb.height === 180
  );

  // The DOM mirror and the math mirror must be decided in exactly one place.
  check(
    "MIRROR_TRANSFORM agrees with MIRROR_PREVIEW",
    MIRROR_TRANSFORM === (MIRROR_PREVIEW ? "scaleX(-1)" : "none")
  );

  // The clip polygon must agree with the same chain (same body, different unit).
  const poly = clipPathPolygon([{ x: 320, y: 100 }], VW, VH);
  const wantPoly = `${(f.x * 100).toFixed(3)}% ${(f.y * 100).toFixed(3)}%`;
  check("clipPathPolygon uses the same chain", poly === wantPoly);
}

console.log("\n[25] hand validation uses all 21 landmarks, not just the two tips");
{
  const good = hand({ x: 340, y: 200 }, { x: 600, y: 200 }, 70);
  const other = hand({ x: 940, y: 520 }, { x: 680, y: 520 }, 70);

  // A landmark teleported far from the wrist: the thumb and index tips still
  // look perfectly plausible on their own, so a tip-only check accepts it.
  const teleported = hand({ x: 340, y: 200 }, { x: 600, y: 200 }, 70);
  teleported[12] = { x: 2600, y: -900, z: 0 };
  const detA = detectHandFrame([toNorm(teleported), toNorm(other)], W, H);
  check(
    "teleported landmark rejected",
    !detA.gestures[0].ok,
    JSON.stringify(detA.gestures[0])
  );
  check(
    "reason landmark-out-of-reach",
    detA.gestures[0].reason === "landmark-out-of-reach",
    detA.gestures[0].reason
  );

  // An incomplete detection (fewer than the 21 landmarks MediaPipe emits).
  const truncated = good.slice(0, 20);
  const detB = detectHandFrame([toNorm(truncated), toNorm(other)], W, H);
  check(
    "incomplete hand rejected",
    !detB.gestures[0].ok && detB.gestures[0].reason === "hand-incomplete",
    JSON.stringify(detB.gestures[0])
  );

  // A complete, coherent hand still passes.
  const detC = detectHandFrame([toNorm(good), toNorm(other)], W, H);
  check("coherent hand accepted", detC.gestures.every((g) => g.ok), JSON.stringify(detC.gestures));
  check("coherent hand yields 4 corners", detC.corners.length === 4, detC.reason);
}

console.log("\n[26] sticky window — hold through dropouts, predict, then lose");
{
  const t = new StickyFrameTracker();
  const base = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }, { x: 0, y: 100 }];
  t.update(base, 0.016);

  // Hands carried to the right at 625 px/s, then tracking drops out mid-motion.
  let moving = base.map((p) => ({ ...p }));
  for (let i = 0; i < 10; i++) {
    moving = moving.map((p) => ({ x: p.x + 10, y: p.y }));
    t.update(moving, 0.016);
  }
  const lastX = t.value[0].x;

  // TEST 8: a 1-3 frame dropout must not flicker the window.
  for (let i = 0; i < 3; i++) t.update(null, 0.016);
  check("3-frame dropout still holds 4 corners", t.value.length === 4, JSON.stringify(t.value));
  check("state holding, not lost", t.state === "holding", t.state);

  // PREDICTION: the window keeps coasting the way the hands were going instead
  // of freezing the instant detection drops.
  check(
    "window keeps moving during dropout",
    t.value[0].x > lastX,
    `x ${lastX.toFixed(1)} -> ${t.value[0].x.toFixed(1)}`
  );

  // Recovery resets the miss counter and resumes tracking.
  t.update(moving, 0.016);
  check("recovery clears the miss count", t.missedFrames === 0 && t.state === "tracking", `${t.missedFrames}/${t.state}`);

  // TEST 9/10: only staying blind past the budget loses the window.
  for (let i = 0; i < TRACK_CONFIG.maxMissedFrames; i++) t.update(null, 0.016);
  check("at the budget the window is still published", t.value.length === 4 && t.state !== "lost", `${t.state}`);
  t.update(null, 0.016);
  check("past the budget -> lost", t.state === "lost", t.state);
  // `lost` still publishes the last position: releasing the selection is the
  // state machine's decision, and the RELEASING tail needs something to fade.
  check("lost keeps the last position", t.value.length === 4, JSON.stringify(t.value));
}

console.log("\n[28] gesture tiers — locked hands are never re-checked for an L");
{
  const other = hand({ x: 900, y: 560 }, { x: 640, y: 560 }, 70);

  // One landmark jittered to 4.2 palm-lengths from the wrist: inside the
  // tracking bound (5) but outside the acquisition bound (3.5). The thumb and
  // index tips themselves are untouched.
  const jittered = hand({ x: 300, y: 180 }, { x: 560, y: 180 }, 70);
  jittered[12] = { x: jittered[0].x + 4.2 * 70, y: jittered[0].y, z: 0 };

  const detAcquire = detectHandFrame([toNorm(jittered), toNorm(other)], W, H, "acquire");
  check("acquire rejects the jittered hand", detAcquire.corners.length === 0, detAcquire.reason);
  check(
    "acquire reason is the reach check",
    detAcquire.gestures[0].reason === "landmark-out-of-reach",
    detAcquire.gestures[0].reason
  );

  const detTrack = detectHandFrame([toNorm(jittered), toNorm(other)], W, H, "track");
  check("track still reads the same anchors", detTrack.corners.length === 4, detTrack.reason);
  check(
    "track corners land on the same tips as a clean hand would",
    detectHandFrame([toNorm(hand({ x: 300, y: 180 }, { x: 560, y: 180 }, 70)), toNorm(other)], W, H)
      .corners.every((p, i) => Math.hypot(p.x - detTrack.corners[i].x, p.y - detTrack.corners[i].y) < 0.001),
    JSON.stringify(detTrack.corners)
  );

  // Track mode also tolerates a hand that lost landmarks — a hand shorter than
  // 21 points but still long enough to carry an index tip stays usable.
  const truncated = hand({ x: 300, y: 180 }, { x: 560, y: 180 }, 70).slice(0, 15);
  const detTrunc = detectHandFrame([toNorm(truncated), toNorm(other)], W, H, "track");
  check("track tolerates a truncated hand", detTrunc.corners.length === 4, detTrunc.gestures[0].reason);
  const detTruncAcq = detectHandFrame([toNorm(truncated), toNorm(other)], W, H, "acquire");
  check("acquire still demands a full hand", detTruncAcq.corners.length === 0, detTruncAcq.gestures[0].reason);
}

console.log("\n[29] sticky lock end-to-end — acquire, lock, dropout, release");
{
  // Replicates the engine's per-frame rule so the behaviour is proved, not
  // just the pieces. This is the acceptance-test matrix (TEST 8/10/12).
  const tracker = new StickyFrameTracker();
  let selection = INITIAL_SELECTION;
  const step = (landmarks) => {
    const wasActive = selectionIsActive(selection.phase);
    const det = detectHandFrame(landmarks, W, H, wasActive ? "track" : "acquire");
    const validity = isValidQuad(det.corners, W, H);
    const hasCorners = det.corners.length === 4;
    const usable = hasCorners && validity.valid;
    tracker.update(usable ? det.corners : null, 0.016);
    if (!wasActive && tracker.missedFrames > FORMING_HOLD_FRAMES) tracker.reset();
    const advance = advanceSelection(selection, {
      valid: wasActive ? tracker.state !== "lost" : usable,
      hasCorners,
    });
    selection = advance.state;
    if (advance.deactivated) tracker.reset();
    return { phase: selection.phase, window: tracker.value };
  };

  const mk = (tl, br, spread) => [
    toNorm(hand(tl, { x: tl.x + spread, y: tl.y }, 70)),
    toNorm(hand(br, { x: br.x - spread, y: br.y }, 70)),
  ];
  const good = mk({ x: 300, y: 180 }, { x: 900, y: 560 }, 260);

  // TEST 1: two L hands -> the window locks.
  step(good);
  const locked = step(good);
  check("frame locks on a real gesture", selectionIsActive(locked.phase), locked.phase);
  check("window has 4 corners", locked.window.length === 4, JSON.stringify(locked.window));

  // TEST 12: the user stops holding a perfect L (thumb/index no longer spread
  // wide, but both tips still plainly visible). The frame must stay connected.
  const relaxed = mk({ x: 300, y: 180 }, { x: 900, y: 560 }, 90);
  const afterRelax = step(relaxed);
  check("relaxed fingers keep the lock", selectionIsActive(afterRelax.phase), afterRelax.phase);
  check("window still follows the hands", afterRelax.window.length === 4, JSON.stringify(afterRelax.window));

  // TEST 8: both hands leave the frame for 3 ticks — no unlock, no flicker.
  for (let i = 0; i < 3; i++) step([]);
  const afterDrop = step([]);
  check("3-frame dropout keeps the lock", selectionIsActive(afterDrop.phase), afterDrop.phase);
  check("window survived the dropout", afterDrop.window.length === 4, JSON.stringify(afterDrop.window));

  // Hands return; tracking resumes without a fresh SEARCHING round trip.
  step(good);
  check("recovery stays locked", selectionIsActive(step(good).phase), selection.phase);

  // TEST 10: sustained blindness past the grace budget is the one thing that
  // releases — and it releases smoothly, never on the first failed frame.
  for (let i = 0; i < 25; i++) step([]);
  const released = step([]);
  check("sustained dropout releases to searching", released.phase === "searching", released.phase);
  check("released window is cleared", released.window === null, JSON.stringify(released.window));
}

console.log("\n[27] pose skeleton topology — all 33 joints connected");
{
  const seen = new Set<number>();
  let inRange = true;
  let noSelfLoop = true;
  for (const [a, b] of POSE_CONNECTIONS) {
    if (a < 0 || a > 32 || b < 0 || b > 32) inRange = false;
    if (a === b) noSelfLoop = false;
    seen.add(a);
    seen.add(b);
  }
  check("all indices within the 33-point model", inRange);
  check("no self loops", noSelfLoop);

  // A joint that appears in no bone is invisible in the debug skeleton —
  // that would quietly drop the very body part the operator is checking.
  const orphans = Array.from({ length: 33 }, (_, i) => i).filter((i) => !seen.has(i));
  check("no orphan joints", orphans.length === 0, `orphans: ${orphans.join(",")}`);

  // The joints called out for full-body tracking must all be reachable.
  const required = [
    POSE_LANDMARK.nose,
    POSE_LANDMARK.leftShoulder,
    POSE_LANDMARK.rightShoulder,
    POSE_LANDMARK.leftElbow,
    POSE_LANDMARK.rightElbow,
    POSE_LANDMARK.leftWrist,
    POSE_LANDMARK.rightWrist,
    POSE_LANDMARK.leftHip,
    POSE_LANDMARK.rightHip,
    POSE_LANDMARK.leftKnee,
    POSE_LANDMARK.rightKnee,
    POSE_LANDMARK.leftAnkle,
    POSE_LANDMARK.rightAnkle,
    POSE_LANDMARK.leftFootIndex,
    POSE_LANDMARK.rightFootIndex,
  ];
  check(
    "nose, arms, hips, knees, ankles and feet are wired in",
    required.every((i) => seen.has(i)),
    `missing: ${required.filter((i) => !seen.has(i)).join(",")}`
  );
}

console.log("\n[30] mode machine — frame search is gated by mode (TEST 1 / 2)");
{
  // ---- the mode chain itself (spec: IDLE -> MENU_OPEN -> MENU_SELECT ->
  // FRAME_SEARCH -> FRAME_LOCKED -> RESETTING -> IDLE) ----
  let m = INITIAL_MODE;
  check("starts in IDLE", m === "IDLE", m);
  m = advanceMode(m, { type: "openMenu" });
  check("swipe-down from IDLE opens the menu", m === "MENU_OPEN", m);
  m = advanceMode(m, { type: "openSubmenu" });
  check("picking a top-level entry opens its submenu", m === "MENU_SELECT", m);
  m = advanceMode(m, { type: "openSubmenu" });
  check("switching submenus stays in MENU_SELECT", m === "MENU_SELECT", m);
  m = advanceMode(m, { type: "itemSelected" });
  check("selecting an item enables frame search", m === "FRAME_SEARCH", m);

  // Illegal events are no-ops: the chain cannot be shortcut.
  check("no lock without a menu selection", advanceMode("IDLE", { type: "frameLocked" }) === "IDLE");
  check("no skipping the menu", advanceMode("IDLE", { type: "itemSelected" }) === "IDLE");
  check(
    "release outside FRAME_LOCKED is a no-op",
    advanceMode("FRAME_SEARCH", { type: "frameReleased" }) === "FRAME_SEARCH"
  );

  // The lock/release loop.
  check("search locks into FRAME_LOCKED", advanceMode("FRAME_SEARCH", { type: "frameLocked" }) === "FRAME_LOCKED");
  check("lock reopens the menu", advanceMode("FRAME_LOCKED", { type: "openMenu" }) === "MENU_OPEN");
  check(
    "release returns to frame search",
    advanceMode("FRAME_LOCKED", { type: "frameReleased" }) === "FRAME_SEARCH"
  );
  check("reset enters RESETTING", advanceMode("FRAME_LOCKED", { type: "reset" }) === "RESETTING");
  check("reset settles in IDLE", advanceMode("RESETTING", { type: "resetDone" }) === "IDLE");

  // ---- the exclusive gesture matrix (one gesture, one mode family) ----
  const ALL_MODES = ["IDLE", "MENU_OPEN", "MENU_SELECT", "FRAME_SEARCH", "FRAME_LOCKED", "RESETTING"];
  const FRAME_MODES = ["FRAME_SEARCH", "FRAME_LOCKED"];
  for (const modeName of ALL_MODES) {
    const expect = FRAME_MODES.includes(modeName);
    check(
      `handFrame ${expect ? "allowed" : "blocked"} in ${modeName}`,
      gestureAllowed(modeName, "handFrame") === expect
    );
  }
  check(
    "pointer only in the menu modes",
    gestureAllowed("MENU_OPEN", "pointer") &&
      gestureAllowed("MENU_SELECT", "pointer") &&
      !gestureAllowed("IDLE", "pointer") &&
      !gestureAllowed("FRAME_LOCKED", "pointer")
  );
  check(
    "pinch only while FRAME_LOCKED",
    gestureAllowed("FRAME_LOCKED", "pinch") &&
      ALL_MODES.filter((x) => x !== "FRAME_LOCKED").every((x) => !gestureAllowed(x, "pinch"))
  );
  check(
    "swipe-left (reset) only while FRAME_LOCKED",
    gestureAllowed("FRAME_LOCKED", "swipeLeft") &&
      ALL_MODES.filter((x) => x !== "FRAME_LOCKED").every((x) => !gestureAllowed(x, "swipeLeft"))
  );
  check(
    "swipe-down opens the menu from IDLE, FRAME_SEARCH and FRAME_LOCKED",
    gestureAllowed("IDLE", "swipeDown") &&
      gestureAllowed("FRAME_SEARCH", "swipeDown") &&
      gestureAllowed("FRAME_LOCKED", "swipeDown") &&
      !gestureAllowed("MENU_OPEN", "swipeDown") &&
      !gestureAllowed("RESETTING", "swipeDown")
  );
  const ALL_GESTURES = ["handFrame", "pointer", "pinch", "swipeDown", "swipeLeft"];
  check(
    "RESETTING allows no gesture at all",
    ALL_GESTURES.every((gesture) => !gestureAllowed("RESETTING", gesture))
  );

  // ---- engine gate replication (lib/engine.ts tick) ----
  // Frame formation runs only where handFrameAllowed() says so; everywhere
  // else the selection machine and the tracker are frozen where they are, so
  // a menu can neither fabricate nor destroy a locked window.
  const tracker = new StickyFrameTracker();
  let selection = INITIAL_SELECTION;
  const step = (modeNow, landmarks) => {
    const wasActive = selectionIsActive(selection.phase);
    const frameEnabled = handFrameAllowed(modeNow);
    const det = detectHandFrame(landmarks, W, H, wasActive ? "track" : "acquire");
    const validity = isValidQuad(det.corners, W, H);
    const hasCorners = det.corners.length === 4;
    const usable = frameEnabled && hasCorners && validity.valid;
    if (frameEnabled) {
      tracker.update(usable ? det.corners : null, 0.016);
      if (!wasActive && tracker.missedFrames > FORMING_HOLD_FRAMES) tracker.reset();
      const advance = advanceSelection(selection, {
        valid: wasActive ? tracker.state !== "lost" : usable,
        hasCorners,
      });
      selection = advance.state;
      if (advance.deactivated) tracker.reset();
    }
    // The engine syncs the mode from the selection machine's live state.
    if (selectionIsActive(selection.phase) && modeNow === "FRAME_SEARCH") {
      modeNow = advanceMode(modeNow, { type: "frameLocked" });
    } else if (!selectionIsActive(selection.phase) && modeNow === "FRAME_LOCKED") {
      modeNow = advanceMode(modeNow, { type: "frameReleased" });
    }
    return { mode: modeNow, phase: selection.phase, window: tracker.value };
  };

  const good = frameHands({ x: 340, y: 200 }, { x: 940, y: 520 });

  // TEST 1: in IDLE a perfect two-hand L must not produce anything.
  let g = INITIAL_MODE;
  for (let i = 0; i < 10; i++) g = step(g, good).mode;
  check("TEST 1: L in IDLE leaves the selection searching", selection.phase === "searching", selection.phase);
  check("TEST 1: no window in IDLE", tracker.value === null, JSON.stringify(tracker.value));
  check("TEST 1: mode stays IDLE", g === "IDLE", g);

  // The menu modes belong to the pointer, not to the frame.
  g = advanceMode(g, { type: "openMenu" });
  for (let i = 0; i < 10; i++) g = step(g, good).mode;
  check("L in MENU_OPEN never locks", selection.phase === "searching", selection.phase);
  check("mode stays MENU_OPEN", g === "MENU_OPEN", g);

  // TEST 2: after an item is selected, the very same gesture locks.
  g = advanceMode(g, { type: "openSubmenu" });
  g = advanceMode(g, { type: "itemSelected" });
  check("selection moves to FRAME_SEARCH", g === "FRAME_SEARCH", g);
  let r = { mode: g, phase: selection.phase, window: tracker.value };
  for (let i = 0; i < 3; i++) {
    r = step(g, good);
    g = r.mode;
  }
  check("TEST 2: the same L now locks", selectionIsActive(selection.phase), selection.phase);
  check("mode advanced to FRAME_LOCKED", g === "FRAME_LOCKED", g);
  check("window published", r.window.length === 4, JSON.stringify(r.window));

  // TEST 11 core: the menu may open over a locked frame without destroying it.
  g = advanceMode(g, { type: "openMenu" });
  check("lock reopens the menu", g === "MENU_OPEN", g);
  for (let i = 0; i < 20; i++) {
    r = step(g, []);
    g = r.mode;
  }
  check("menu never releases a locked frame", selectionIsActive(selection.phase), selection.phase);
  check("window geometry survives the menu", r.window.length === 4, JSON.stringify(r.window));
  g = advanceMode(g, { type: "openSubmenu" });
  g = advanceMode(g, { type: "itemSelected" });
  for (let i = 0; i < 3; i++) {
    r = step(g, good);
    g = r.mode;
  }
  check("resumes as FRAME_LOCKED without a fresh L", g === "FRAME_LOCKED", g);
  check("the lock itself was never broken", selection.phase === "locked", selection.phase);
}

console.log(`\n${failures === 0 ? "ALL LOGIC CHECKS PASSED" : `${failures} FAILURE(S)`}`);
if (failures > 0) process.exitCode = 1;
