import type { NormalizedLandmark, Point } from "./types";

/**
 * Semantic body regions the selection can be matched against.
 *
 * The selection is classified by comparing the hand-made window against the
 * boxes the person's landmarks imply. The winner is the region the window is
 * most "inside of", so framing your eyes picks the template's eye region
 * instead of cropping a random piece of the picture.
 *
 * Coarse regions come first, finer ones later: classification walks this list
 * and lets a smaller, more specific region win when the window is tightly
 * inside it.
 */
export type RegionKind =
  | "left-eye"
  | "right-eye"
  | "eyes"
  | "face"
  | "head"
  | "neck"
  | "torso"
  | "left-arm"
  | "right-arm"
  | "left-hand"
  | "right-hand"
  | "left-leg"
  | "right-leg";

/** A region the selection can match, with the landmarks that define it. */
export type RegionDefinition = {
  kind: RegionKind;
  label: string;
  /**
   * Indices into the landmark array this region was built from. The region's
   * box is the bounding box of these points, so the region follows the person
   * and never relies on screen coordinates.
   */
  indices: number[];
};

/**
 * MediaPipe Pose Landmark indices (33-point model).
 * https://developers.google.com/mediapipe/solutions/vision/pose_landmarker
 */
export const POSE_LANDMARK = {
  nose: 0,
  leftEyeInner: 1,
  leftEye: 2,
  leftEyeOuter: 3,
  rightEyeInner: 4,
  rightEye: 5,
  rightEyeOuter: 6,
  leftEar: 7,
  rightEar: 8,
  mouthLeft: 9,
  mouthRight: 10,
  leftShoulder: 11,
  rightShoulder: 12,
  leftElbow: 13,
  rightElbow: 14,
  leftWrist: 15,
  rightWrist: 16,
  leftPinky: 17,
  rightPinky: 18,
  leftIndex: 19,
  rightIndex: 20,
  leftThumb: 21,
  rightThumb: 22,
  leftHip: 23,
  rightHip: 24,
  leftKnee: 25,
  rightKnee: 26,
  leftAnkle: 27,
  rightAnkle: 28,
  leftHeel: 29,
  rightHeel: 30,
  leftFootIndex: 31,
  rightFootIndex: 32,
} as const;

/**
 * MediaPipe Pose topology — the bones of the 33-point skeleton, used by the
 * debug overlay to draw a full body instead of a cloud of dots.
 * https://developers.google.com/mediapipe/solutions/vision/pose_landmarker
 */
export const POSE_CONNECTIONS: ReadonlyArray<readonly [number, number]> = [
  // face
  [0, 1], [1, 2], [2, 3], [3, 7],
  [0, 4], [4, 5], [5, 6], [6, 8],
  [9, 10],
  // torso
  [11, 12], [11, 23], [12, 24], [23, 24],
  // arms
  [11, 13], [13, 15], [12, 14], [14, 16],
  [15, 17], [17, 19], [19, 21],
  [16, 18], [18, 20], [20, 22],
  // legs
  [23, 25], [25, 27], [27, 29], [27, 31],
  [24, 26], [26, 28], [28, 30], [28, 32],
];

/** Face Landmarker indices that carve the face into stable sub-regions. */
export const FACE_LANDMARK = {
  leftEyeCenter: 468,
  rightEyeCenter: 473,
  noseTip: 1,
  mouthCenter: 13,
  chin: 152,
  forehead: 10,
  leftCheek: 234,
  rightCheek: 454,
} as const;

/**
 * Regions derived from pose landmarks. Pose gives one box per body part, so
 * the whole body is covered without gaps.
 */
export const POSE_REGIONS: RegionDefinition[] = [
  { kind: "head", label: "Head", indices: [0, 2, 5, 7, 8, 9, 10] },
  { kind: "neck", label: "Neck", indices: [0, 11, 12] },
  { kind: "torso", label: "Torso", indices: [11, 12, 23, 24] },
  { kind: "left-arm", label: "Left Arm", indices: [11, 13, 15, 17, 19, 21] },
  { kind: "right-arm", label: "Right Arm", indices: [12, 14, 16, 18, 20, 22] },
  { kind: "left-hand", label: "Left Hand", indices: [15, 17, 19, 21] },
  { kind: "right-hand", label: "Right Hand", indices: [16, 18, 20, 22] },
  { kind: "left-leg", label: "Left Leg", indices: [23, 25, 27, 29, 31] },
  { kind: "right-leg", label: "Right Leg", indices: [24, 26, 28, 30, 32] },
];

/**
 * Regions derived from face landmarks. Face Landmarker sees more detail than
 * pose inside the head, so it refines "head" into eyes/face.
 */
export const FACE_REGIONS: RegionDefinition[] = [
  { kind: "left-eye", label: "Left Eye", indices: [468, 469, 470, 471, 472] },
  { kind: "right-eye", label: "Right Eye", indices: [473, 474, 475, 476, 477] },
  { kind: "eyes", label: "Eyes", indices: [468, 473] },
  { kind: "face", label: "Face", indices: [10, 152, 234, 454, 1, 13] },
];

/** Axis-aligned box in normalized [0..1] coordinates. */
export type NormBox = { x: number; y: number; width: number; height: number };

/** Bounding box of the given landmark indices, or null if none are present. */
export function regionBox(
  landmarks: NormalizedLandmark[],
  indices: number[]
): NormBox | null {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let found = 0;
  for (const i of indices) {
    const p = landmarks[i];
    if (!p) continue;
    found++;
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x);
    maxY = Math.max(maxY, p.y);
  }
  if (found === 0) return null;
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

/** Intersection area of two normalized boxes. */
function intersectionArea(a: NormBox, b: NormBox): number {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  const right = Math.min(a.x + a.width, b.x + b.width);
  const bottom = Math.min(a.y + a.height, b.y + b.height);
  if (right <= x || bottom <= y) return 0;
  return (right - x) * (bottom - y);
}

function boxArea(box: NormBox): number {
  return box.width * box.height;
}

function boxCenter(box: NormBox): Point {
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
 }

export type RegionScore = {
  kind: RegionKind;
  label: string;
  /** How much of the selection window lies inside this region (0..1). */
  coverage: number;
  /** How much of this region lies inside the selection window (0..1). */
  containment: number;
  /** Center distance in normalized units, squared (cheaper than a sqrt). */
  distSq: number;
  /** Combined score, higher is better. */
  score: number;
};

/**
 * Scores one region against the selection window.
 *
 * Two signals matter and they answer different questions:
 *  - `coverage`  — "is the window sitting ON this part?" A big window over the
 *    whole torso covers it well.
 *  - `containment` — "is this part INSIDE the window?" A small window around
 *    an eye contains that eye completely.
 *
 * Smaller regions win ties because containment is easier for them, which is
 * exactly the intended behavior: a tight frame on the eyes should pick "eyes",
 * not "face", even though the eyes are inside the face.
 */
export function scoreRegion(
  region: RegionDefinition,
  regionBox: NormBox,
  selection: NormBox
): RegionScore | null {
  if (regionBox.width <= 0 || regionBox.height <= 0) return null;

  const inter = intersectionArea(selection, regionBox);
  const coverage = inter / Math.max(boxArea(selection), 1e-9);
  const regionArea = boxArea(regionBox);
  const containment = inter / Math.max(regionArea, 1e-9);

  const sc = boxCenter(selection);
  const rc = boxCenter(regionBox);
  const distSq = (sc.x - rc.x) ** 2 + (sc.y - rc.y) ** 2;

  // Containment leads, not coverage. A window on the eyes is fully inside the
  // face box too, so coverage would always prefer the biggest enclosing region.
  // What distinguishes "eyes" from "face" is that the eyes region *fits* the
  // window: it contains most of what the window covers and is not much bigger
  // than it. `tightness` rewards regions whose size matches the window, so a
  // tight frame wins over a big region it merely sits inside.
  const selectionArea = boxArea(selection);
  const areaRatio = selectionArea > 0 ? regionArea / selectionArea : Infinity;
  const tightness = areaRatio <= 1 ? 1 : Math.max(0, 1 - Math.log2(areaRatio) * 0.5);

  const score = containment * 0.5 + coverage * 0.3 + tightness * 0.2 - distSq * 0.1;

  return {
    kind: region.kind,
    label: region.label,
    coverage,
    containment,
    distSq,
    score,
  };
}

export type ClassificationResult = {
  region: RegionKind | null;
  label: string;
  confidence: number;
  scores: RegionScore[];
};

/**
 * Classifies which body part the selection window is framing.
 *
 * Face regions are checked first because they are more specific than the pose
 * "head" box; pose regions cover the rest of the body. Whichever region scores
 * highest wins, and the confidence is that region's coverage, so a window that
 * only grazes a region reports low confidence and the caller falls back to
 * plain clipping.
 *
 * Returns `region: null` when no region is available (no landmarks detected).
 */
export function classifyRegion(
  selection: NormBox,
  poseLandmarks: NormalizedLandmark[] | null,
  faceLandmarks: NormalizedLandmark[] | null
): ClassificationResult {
  const scores: RegionScore[] = [];

  if (faceLandmarks) {
    for (const region of FACE_REGIONS) {
      const box = regionBox(faceLandmarks, region.indices);
      const scored = box ? scoreRegion(region, box, selection) : null;
      if (scored) scores.push(scored);
    }
  }

  if (poseLandmarks) {
    for (const region of POSE_REGIONS) {
      const box = regionBox(poseLandmarks, region.indices);
      const scored = box ? scoreRegion(region, box, selection) : null;
      if (scored) scores.push(scored);
    }
  }

  if (scores.length === 0) {
    return { region: null, label: "—", confidence: 0, scores: [] };
  }

  let best = scores[0];
  for (const s of scores) {
    if (s.score > best.score) best = s;
  }

  // Confidence is coverage: how much of the window is actually on the region.
  // A window that merely touches an edge gets a low value and falls back.
  const confidence = Math.max(0, Math.min(1, best.coverage));

  return {
    region: best.kind,
    label: best.label,
    confidence,
    scores,
  };
}

/**
 * Maps a classified region to a "coarse" region the renderer cares about.
 * Fine regions (left-eye vs right-eye vs eyes) collapse to one template view
 * so the template config stays small and the mapping stays stable.
 */
export function coarseRegion(kind: RegionKind | null): RegionKind | null {
  if (kind === null) return null;
  if (kind === "left-eye" || kind === "right-eye" || kind === "eyes") return "eyes";
  return kind;
}

// ------------------------------------------------------------------ hysteresis

export type RegionLockState = {
  kind: RegionKind | null;
  label: string;
  /** Exponentially-smoothed confidence, survives across frames. */
  confidence: number;
};

/**
 * The winning region must beat the incumbent by this margin before the
 * classification changes — without it a window straddling the eye/face
 * boundary flips between the two every frame.
 */
export const REGION_SWITCH_MARGIN = 0.12;

/** Below this smoothed confidence the region clears → plain clipping. */
export const REGION_FALLBACK_CONFIDENCE = 0.25;

/** Time constant (seconds) of the confidence EMA. */
export const REGION_CONFIDENCE_TAU = 0.25;

export const INITIAL_REGION_LOCK: RegionLockState = {
  kind: null,
  label: "—",
  confidence: 0,
};

/**
 * Applies the region hysteresis to a fresh classification.
 *
 * Pure and stateless on its own — the caller threads `state` through frames.
 * The incumbent region is kept unless another region beats it by
 * `REGION_SWITCH_MARGIN`; confidence is smoothed so one blurry frame cannot
 * collapse a stable classification. Low confidence clears the region so the
 * renderer falls back to plain full-screen clipping.
 */
export function advanceRegion(
  state: RegionLockState,
  classified: ClassificationResult,
  alpha: number
): RegionLockState {
  const confidence = state.confidence + (classified.confidence - state.confidence) * alpha;

  const incumbent = state.kind;
  if (classified.region && classified.region !== incumbent) {
    const scores = new Map(classified.scores.map((s) => [s.kind, s.score]));
    const challengerScore = scores.get(classified.region);
    const incumbentScore = incumbent === null ? undefined : scores.get(incumbent);
    // No incumbent to beat, or the challenger wins by a clear margin.
    const margin =
      challengerScore !== undefined && incumbentScore !== undefined
        ? challengerScore - incumbentScore
        : REGION_SWITCH_MARGIN;
    if (incumbent === null || margin >= REGION_SWITCH_MARGIN) {
      return { kind: classified.region, label: classified.label, confidence };
    }
  }

  if (confidence < REGION_FALLBACK_CONFIDENCE) {
    return { kind: null, label: "—", confidence };
  }

  return { kind: incumbent, label: state.label, confidence };
}
