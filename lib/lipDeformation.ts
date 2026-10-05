import type { NormalizedLandmark } from "./types";

/**
 * Face Landmarker indices for the lip contour.
 * MediaPipe face mesh 478-landmark model.
 */
export const LIP_LANDMARK = {
  // Outer lip contour — clockwise from left corner
  leftCorner: 61,
  upperLipLeft1: 185,
  upperLipLeft2: 40,
  upperLipMid1: 39,
  upperLipMid2: 37,
  upperLipCenter: 0,
  upperLipMid3: 267,
  upperLipMid4: 269,
  upperLipRight1: 270,
  upperLipRight2: 409,
  rightCorner: 291,
  lowerLipRight1: 375,
  lowerLipRight2: 321,
  lowerLipMid1: 405,
  lowerLipCenter: 17,
  lowerLipMid2: 84,
  lowerLipLeft1: 181,
  lowerLipLeft2: 91,
  lowerLipLeft3: 146,
} as const;

/** Face landmark indices used to estimate face size (for relative distances). */
export const FACE_SIZE_LANDMARKS = [
  10,  // forehead
  152, // chin
  234, // left cheek
  454, // right cheek
  1,   // nose tip
];

/**
 * Computes face size in normalized units — the approximate diameter of the
 * face oval. Used as a scale reference so thresholds work regardless of
 * distance from camera.
 */
export function computeFaceSize(landmarks: { x: number; y: number }[]): number {
  if (landmarks.length < 200) return 0;
  // Use chin-to-forehead distance as a rough face height.
  const chin = landmarks[152];
  const forehead = landmarks[10];
  if (!chin || !forehead) return 0;
  const dy = chin.y - forehead.y;
  const dx = chin.x - forehead.x;
  return Math.sqrt(dx * dx + dy * dy);
}

/** Indices of the lip contour vertices in order (clockwise). */
export const LIP_CONTOUR_INDICES: number[] = [
  LIP_LANDMARK.leftCorner,
  LIP_LANDMARK.upperLipLeft1,
  LIP_LANDMARK.upperLipLeft2,
  LIP_LANDMARK.upperLipMid1,
  LIP_LANDMARK.upperLipMid2,
  LIP_LANDMARK.upperLipCenter,
  LIP_LANDMARK.upperLipMid3,
  LIP_LANDMARK.upperLipMid4,
  LIP_LANDMARK.upperLipRight1,
  LIP_LANDMARK.upperLipRight2,
  LIP_LANDMARK.rightCorner,
  LIP_LANDMARK.lowerLipRight1,
  LIP_LANDMARK.lowerLipRight2,
  LIP_LANDMARK.lowerLipMid1,
  LIP_LANDMARK.lowerLipCenter,
  LIP_LANDMARK.lowerLipMid2,
  LIP_LANDMARK.lowerLipLeft1,
  LIP_LANDMARK.lowerLipLeft2,
  LIP_LANDMARK.lowerLipLeft3,
];

export type LipContour = {
  /** Normalized [0..1] positions of the lip contour vertices. */
  points: { x: number; y: number }[];
  center: { x: number; y: number };
  leftCorner: { x: number; y: number };
  rightCorner: { x: number; y: number };
  topCenter: { x: number; y: number };
  bottomCenter: { x: number; y: number };
  faceSize: number;
};

/**
 * Extracts lip contour from face landmarks.
 * Returns null when landmarks are unavailable or incomplete.
 */
export function extractLipContour(
  landmarks: { x: number; y: number }[]
): LipContour | null {
  if (!landmarks || landmarks.length < 400) return null;

  const points = LIP_CONTOUR_INDICES.map((i) => landmarks[i]).filter(Boolean);
  if (points.length < 4) return null;

  const left = landmarks[LIP_LANDMARK.leftCorner];
  const right = landmarks[LIP_LANDMARK.rightCorner];
  const top = landmarks[LIP_LANDMARK.upperLipCenter];
  const bottom = landmarks[LIP_LANDMARK.lowerLipCenter];
  if (!left || !right || !top || !bottom) return null;

  return {
    points,
    center: {
      x: (left.x + right.x) / 2,
      y: (top.y + bottom.y) / 2,
    },
    leftCorner: { x: left.x, y: left.y },
    rightCorner: { x: right.x, y: right.y },
    topCenter: { x: top.x, y: top.y },
    bottomCenter: { x: bottom.x, y: bottom.y },
    faceSize: computeFaceSize(landmarks),
  };
}

// ----------------------------------------------------------------------- config

export const LIP_CONFIG = {
  /** Fraction of face size: fingertip must be closer than this to grab. */
  GRAB_DISTANCE: 0.08,
  /** Fraction of face size: must move farther than this to release. */
  RELEASE_DISTANCE: 0.12,
  /** Maximum stretch multiplier relative to original lip width. */
  MAX_LIP_STRETCH: 2.5,
  /** EMA smoothing factor for fingertip positions. */
  FINGER_SMOOTHING: 0.3,
  /** Per-frame lerp toward target deformation (lower = more lag/elastic). */
  DEFORM_SMOOTHING: 0.15,
  /** Spring return speed when released (fraction per frame). */
  SPRING_RETURN: 0.06,
  /** Falloff radius as fraction of face size. */
  FALLOFF_RADIUS: 0.15,
} as const;

// ------------------------------------------------------------------- state machine

export type LipSide = "left" | "right" | null;

export type LipGrabState = "idle" | "near" | "grabbed" | "dragging";

export type LipSideState = {
  state: LipGrabState;
  /** Position of the finger when the grab started (normalized coords). */
  grabStart: { x: number; y: number } | null;
  /** Current finger position (smoothed). */
  fingerPos: { x: number; y: number } | null;
  /** Current deformation vector (in normalized units). */
  deformation: { x: number; y: number };
  /** Target deformation (before smoothing). */
  targetDeformation: { x: number; y: number };
  /** Consecutive frames with no valid finger near this side. */
  lostStreak: number;
};

export type LipInteractionState = {
  /** State for the left side of the lip. */
  left: LipSideState;
  /** State for the right side. */
  right: LipSideState;
  /** Whether the lip contour is valid this frame. */
  hasFace: boolean;
  /** Lip contour, null when no face. */
  contour: LipContour | null;
  /** Frames since face was lost. */
  faceLostStreak: number;
};

export const EMPTY_LIP_SIDE: LipSideState = {
  state: "idle",
  grabStart: null,
  fingerPos: null,
  deformation: { x: 0, y: 0 },
  targetDeformation: { x: 0, y: 0 },
  lostStreak: 0,
};

export const INITIAL_LIP_STATE: LipInteractionState = {
  left: { ...EMPTY_LIP_SIDE },
  right: { ...EMPTY_LIP_SIDE },
  hasFace: false,
  contour: null,
  faceLostStreak: 0,
};

// ---------------------------------------------------------------------- helpers

/** Distance between two points in normalized space. */
function dist2(a: { x: number; y: number }, b: { x: number; y: number }): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return Math.sqrt(dx * dx + dy * dy);
}

/** EMA smooth a point toward target. */
function smoothPoint(
  current: { x: number; y: number } | null,
  target: { x: number; y: number },
  alpha: number
): { x: number; y: number } {
  if (!current) return { x: target.x, y: target.y };
  return {
    x: current.x + (target.x - current.x) * alpha,
    y: current.y + (target.y - current.y) * alpha,
  };
}

// ----------------------------------------------------------- advance one side

function advanceLipSide(
  state: LipSideState,
  finger: { x: number; y: number } | null,
  lipCorner: { x: number; y: number } | null,
  faceSize: number
): LipSideState {
  const fingerPos = finger
    ? smoothPoint(state.fingerPos, finger, LIP_CONFIG.FINGER_SMOOTHING)
    : state.fingerPos;

  const lipToFinger =
    fingerPos && lipCorner ? dist2(fingerPos, lipCorner) / Math.max(faceSize, 0.01) : Infinity;

  let nextState: LipGrabState = state.state;
  let grabStart = state.grabStart;
  let targetDef = { x: 0, y: 0 };

  switch (state.state) {
    case "idle":
    case "near":
      if (fingerPos && lipCorner && lipToFinger < LIP_CONFIG.GRAB_DISTANCE) {
        nextState = "grabbed";
        grabStart = { x: fingerPos.x, y: fingerPos.y };
      } else if (fingerPos && lipCorner && lipToFinger < LIP_CONFIG.RELEASE_DISTANCE) {
        nextState = "near";
      } else {
        nextState = "idle";
        grabStart = null;
      }
      break;

    case "grabbed":
    case "dragging":
      if (!fingerPos) {
        // Finger lost.
        nextState = "idle";
        grabStart = null;
      } else if (lipToFinger > LIP_CONFIG.RELEASE_DISTANCE) {
        nextState = "idle";
        grabStart = null;
      } else if (grabStart) {
        nextState = "dragging";
        const dx = fingerPos.x - grabStart.x;
        const dy = fingerPos.y - grabStart.y;
        // Clamp stretch.
        const stretch = Math.sqrt(dx * dx + dy * dy) / Math.max(faceSize, 0.01);
        const clamped = Math.min(stretch, LIP_CONFIG.MAX_LIP_STRETCH);
        const angle = Math.atan2(dy, dx);
        targetDef = {
          x: Math.cos(angle) * clamped * faceSize,
          y: Math.sin(angle) * clamped * faceSize,
        };
      }
      break;
  }

  // Smooth deformation toward target (creates elastic feel).
  const def = {
    x: state.deformation.x + (targetDef.x - state.deformation.x) * LIP_CONFIG.DEFORM_SMOOTHING,
    y: state.deformation.y + (targetDef.y - state.deformation.y) * LIP_CONFIG.DEFORM_SMOOTHING,
  };

  // Spring return toward zero when not dragging.
  if (nextState !== "dragging") {
    def.x += (0 - def.x) * LIP_CONFIG.SPRING_RETURN;
    def.y += (0 - def.y) * LIP_CONFIG.SPRING_RETURN;
  }

  return {
    state: nextState,
    grabStart,
    fingerPos,
    deformation: def,
    targetDeformation: targetDef,
    lostStreak: finger ? 0 : state.lostStreak + 1,
  };
}

// ------------------------------------------------------------------- main advance

export type FingerData = {
  /** Normalized position. */
  x: number;
  y: number;
};

/**
 * Advances the full lip interaction state for one frame.
 */
export function advanceLipInteraction(
  state: LipInteractionState,
  faceLandmarks: { x: number; y: number }[] | null,
  fingertips: FingerData[]
): LipInteractionState {
  const contour = faceLandmarks ? extractLipContour(faceLandmarks) : null;
  const hasFace = contour !== null;
  const faceLostStreak = hasFace ? 0 : state.faceLostStreak + 1;

  // Hold face state for a few frames before giving up.
  const effectiveContour = contour ?? (faceLostStreak < 8 ? state.contour : null);
  const faceSize = effectiveContour?.faceSize ?? 0;

  // Find nearest fingertip to left lip corner and right lip corner.
  const leftCorner = effectiveContour?.leftCorner ?? null;
  const rightCorner = effectiveContour?.rightCorner ?? null;

  let leftFinger: FingerData | null = null;
  let rightFinger: FingerData | null = null;
  let leftDist = Infinity;
  let rightDist = Infinity;

  for (const f of fingertips) {
    if (leftCorner) {
      const d = dist2(f, leftCorner);
      if (d < leftDist) {
        leftDist = d;
        leftFinger = f;
      }
    }
    if (rightCorner) {
      const d = dist2(f, rightCorner);
      if (d < rightDist) {
        rightDist = d;
        rightFinger = f;
      }
    }
  }

  return {
    left: advanceLipSide(state.left, leftFinger, leftCorner, faceSize),
    right: advanceLipSide(state.right, rightFinger, rightCorner, faceSize),
    hasFace,
    contour: effectiveContour,
    faceLostStreak,
  };
}

// ------------------------------------------------------------ deformation result

export type LipDeformationResult = {
  /** Normalized offset of the left lip corner from its rest position. */
  leftOffset: { x: number; y: number };
  /** Normalized offset of the right lip corner. */
  rightOffset: { x: number; y: number };
  /** Current grab states. */
  leftState: LipGrabState;
  rightState: LipGrabState;
  /** Deformed lip contour points in normalized space, or null if no face. */
  deformedContour: { x: number; y: number }[] | null;
};

/**
 * Computes the final deformation result from the interaction state.
 */
export function computeLipDeformation(
  state: LipInteractionState
): LipDeformationResult {
  const contour = state.contour;
  if (!contour) {
    return {
      leftOffset: { x: 0, y: 0 },
      rightOffset: { x: 0, y: 0 },
      leftState: "idle",
      rightState: "idle",
      deformedContour: null,
    };
  }

  const leftOff = state.left.deformation;
  const rightOff = state.right.deformation;

  // Deform the contour points with smooth falloff.
  const faceSize = Math.max(contour.faceSize, 0.01);
  const falloffRadius = LIP_CONFIG.FALLOFF_RADIUS * faceSize;

  const deformed = contour.points.map((p) => {
    // Distance from this point to each side's anchor.
    const dLeft = dist2(p, contour.leftCorner);
    const dRight = dist2(p, contour.rightCorner);

    // Influence decays smoothly with distance (gaussian-like falloff).
    const infLeft = Math.exp(-(dLeft * dLeft) / (2 * falloffRadius * falloffRadius));
    const infRight = Math.exp(-(dRight * dRight) / (2 * falloffRadius * falloffRadius));

    return {
      x: p.x + leftOff.x * infLeft + rightOff.x * infRight,
      y: p.y + leftOff.y * infLeft + rightOff.y * infRight,
    };
  });

  return {
    leftOffset: leftOff,
    rightOffset: rightOff,
    leftState: state.left.state,
    rightState: state.right.state,
    deformedContour: deformed,
  };
}