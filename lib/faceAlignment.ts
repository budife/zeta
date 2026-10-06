import type { NormalizedLandmark, Point } from "./types";
import { TEMPLATE_FACE_POINTS, TEMPLATE_VIEWBOX } from "./templateRegions";

/**
 * Face-to-template alignment.
 *
 * When the selection captures the user's face, the media must not merely be
 * cropped to the window: the template's face landmarks (eyes, nose, mouth) are
 * mapped onto the user's face landmarks, and the media is translated / rotated
 * / scaled so they line up. The clip window itself never moves — alignment is
 * a transform on the media layer, clipping stays on its own element.
 *
 * All math here is pure and runs in video-pixel space. The caller (MediaLayer)
 * converts the resulting similarity into a CSS transform.
 */

/** MediaPipe Face Landmarker indices (478-point model, verified). */
export const FACE_LANDMARK = {
  leftEyeOuter: 33,
  leftEyeInner: 133,
  rightEyeOuter: 263,
  rightEyeInner: 362,
  noseTip: 4,
  mouthLeft: 61,
  mouthRight: 291,
  upperLip: 13,
  lowerLip: 14,
} as const;

export type FacePoints = {
  leftEye: Point;
  rightEye: Point;
  nose: Point;
  mouth: Point;
};

/** Ordered point list matching TEMPLATE_FACE_POINTS order. */
export function facePointsList(points: FacePoints): Point[] {
  return [points.leftEye, points.rightEye, points.nose, points.mouth];
}

function average(a: Point, b: Point): Point {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

function at(landmarks: NormalizedLandmark[], index: number): Point | null {
  const lm = landmarks[index];
  return lm ? { x: lm.x, y: lm.y } : null;
}

/**
 * Extracts the four user-face anchors from Face Landmarker output, in
 * normalized coordinates. Returns null unless every needed landmark exists.
 *
 * Eyes use the outer/inner corner midpoint (more stable than a single point),
 * the nose uses the tip, the mouth the midpoint of its two corners.
 */
export function userFacePoints(
  landmarks: NormalizedLandmark[] | null | undefined
): FacePoints | null {
  if (!landmarks || landmarks.length <= FACE_LANDMARK.mouthRight) return null;

  const leO = at(landmarks, FACE_LANDMARK.leftEyeOuter);
  const leI = at(landmarks, FACE_LANDMARK.leftEyeInner);
  const reO = at(landmarks, FACE_LANDMARK.rightEyeOuter);
  const reI = at(landmarks, FACE_LANDMARK.rightEyeInner);
  const nose = at(landmarks, FACE_LANDMARK.noseTip);
  const mL = at(landmarks, FACE_LANDMARK.mouthLeft);
  const mR = at(landmarks, FACE_LANDMARK.mouthRight);
  if (!leO || !leI || !reO || !reI || !nose || !mL || !mR) return null;

  return {
    leftEye: average(leO, leI),
    rightEye: average(reO, reI),
    nose,
    mouth: average(mL, mR),
  };
}

/**
 * Maps the template's face anchors into video-pixel space using the same
 * `object-fit: cover` math as the media layer, so they sit exactly where the
 * rendered template face currently is.
 */
export function templateFacePointsInVideo(
  videoWidth: number,
  videoHeight: number
): FacePoints {
  const cover = Math.max(
    videoWidth / TEMPLATE_VIEWBOX.width,
    videoHeight / TEMPLATE_VIEWBOX.height
  );
  const offsetX = (videoWidth - TEMPLATE_VIEWBOX.width * cover) / 2;
  const offsetY = (videoHeight - TEMPLATE_VIEWBOX.height * cover) / 2;
  const map = (p: Point): Point => ({
    x: offsetX + p.x * cover,
    y: offsetY + p.y * cover,
  });
  return {
    leftEye: map(TEMPLATE_FACE_POINTS.leftEye),
    rightEye: map(TEMPLATE_FACE_POINTS.rightEye),
    nose: map(TEMPLATE_FACE_POINTS.nose),
    mouth: map(TEMPLATE_FACE_POINTS.mouth),
  };
}

/**
 * A 2D similarity transform: scale + rotation + translation.
 * `applySimilarity` maps a source point into the aligned position.
 */
export type Similarity = {
  scale: number;
  rotation: number;
  tx: number;
  ty: number;
};

export const IDENTITY_SIMILARITY: Similarity = {
  scale: 1,
  rotation: 0,
  tx: 0,
  ty: 0,
};

export function applySimilarity(t: Similarity, p: Point): Point {
  const c = Math.cos(t.rotation);
  const s = Math.sin(t.rotation);
  return {
    x: t.scale * (p.x * c - p.y * s) + t.tx,
    y: t.scale * (p.x * s + p.y * c) + t.ty,
  };
}

/**
 * Least-squares similarity (Umeyama, 2D, no reflection) mapping `source`
 * points onto `target` points. Needs at least 2 points; uses all of them so a
 * single noisy landmark does not dominate.
 */
export function solveSimilarity(
  source: Point[],
  target: Point[]
): Similarity | null {
  const n = Math.min(source.length, target.length);
  if (n < 2) return null;

  let scx = 0, scy = 0, tcx = 0, tcy = 0;
  for (let i = 0; i < n; i++) {
    scx += source[i].x; scy += source[i].y;
    tcx += target[i].x; tcy += target[i].y;
  }
  scx /= n; scy /= n; tcx /= n; tcy /= n;

  let dot = 0; // Σ (s' · t') after rotation alignment
  let varS = 0; // Σ |s'|²
  let cross = 0; // Σ (s'x·t'y - s'y·t'x)
  let dot2 = 0; // Σ (s'x·t'x + s'y·t'y)
  for (let i = 0; i < n; i++) {
    const sx = source[i].x - scx;
    const sy = source[i].y - scy;
    const tx = target[i].x - tcx;
    const ty = target[i].y - tcy;
    cross += sx * ty - sy * tx;
    dot2 += sx * tx + sy * ty;
    varS += sx * sx + sy * sy;
  }

  if (varS < 1e-9) return null;

  const rotation = Math.atan2(cross, dot2);
  // Σ (s' rotated by θ) · t' / Σ|s'|² gives the scale.
  const c = Math.cos(rotation);
  const s = Math.sin(rotation);
  for (let i = 0; i < n; i++) {
    const sx = source[i].x - scx;
    const sy = source[i].y - scy;
    const rx = sx * c - sy * s;
    const ry = sx * s + sy * c;
    dot += rx * (target[i].x - tcx) + ry * (target[i].y - tcy);
  }
  const scale = dot / varS;
  if (!Number.isFinite(scale) || scale <= 1e-6) return null;

  const tx = tcx - scale * (scx * c - scy * s);
  const ty = tcy - scale * (scx * s + scy * c);
  return { scale, rotation, tx, ty };
}

/**
 * Full pipeline: template face anchors (viewBox) → user face anchors
 * (normalized) → similarity in video-pixel space that the media layer should
 * apply. Returns identity when either side is unavailable.
 */
export function faceAlignment(
  userPoints: FacePoints | null,
  videoWidth: number,
  videoHeight: number
): Similarity {
  if (!userPoints || videoWidth <= 0 || videoHeight <= 0) {
    return IDENTITY_SIMILARITY;
  }
  const source = facePointsList(templateFacePointsInVideo(videoWidth, videoHeight));
  const target = facePointsList(userPoints).map((p) => ({
    x: p.x * videoWidth,
    y: p.y * videoHeight,
  }));
  return solveSimilarity(source, target) ?? IDENTITY_SIMILARITY;
}
