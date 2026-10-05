/**
 * Shared geometry / tracking types for the Hand Frame → Vector pipeline.
 *
 * All coordinates produced by MediaPipe are normalized to [0..1] of the video
 * frame. Everything inside `lib` works in *pixel* space of the video
 * (video.videoWidth x video.videoHeight) so distances are aspect-correct.
 * Renderers convert pixels back to percentages of the stage.
 */

import type { RegionKind } from "./regions";
import type { LipDeformationResult } from "./lipDeformation";

/** A point in video-pixel space. */
export type Point = { x: number; y: number };

/**
 * An oriented rectangle in video-pixel space.
 * `rotation` is expressed in degrees and normalized to (-90, 90].
 */
export type FrameRect = {
  cx: number;
  cy: number;
  width: number;
  height: number;
  rotation: number;
};

/** An axis-aligned bounding box in video-pixel space (top-left origin). */
export type Box = {
  x: number;
  y: number;
  width: number;
  height: number;
};

/** Normalized landmark as returned by MediaPipe tasks-vision. */
export type NormalizedLandmark = { x: number; y: number; z: number };

/** Result of `detectHandFrame()`. */
export type HandFrameDetection = {
  /** How many hands MediaPipe reported. */
  handCount: number;
  /**
   * The four candidate frame corners (thumb tip + index tip of each hand),
   * angularly sorted around their centroid so they form a simple polygon.
   * Empty when fewer than two hands pass the gesture check.
   */
  corners: Point[];
  /** Per-hand gesture verdict, useful for the debug overlay. */
  gestures: HandGestureVerdict[];
  /** Human readable reason describing the detection outcome. */
  reason: string;
};

export type HandGestureVerdict = { ok: boolean; reason: string };

/** Result of `isValidFrame()`. */
export type FrameValidity = { valid: boolean; reason: string };

/** Where a vector character should be drawn, in video-pixel space. */
export type VectorTransform = {
  cx: number;
  cy: number;
  /** Square side length in video pixels. */
  size: number;
  rotation: number;
};

export type FaceState = "none" | "outside" | "in-frame";

/** Discrete application status — only re-rendered when one of these changes. */
export type AppStatus = {
  camera: "off" | "starting" | "ready" | "error";
  models: "loading" | "ready" | "error";
  hands: number;
  frame: "inactive" | "active";
  face: FaceState;
  /** Which body part the selection is framing, when the classifier is confident. */
  region: RegionKind | null;
  /** Smoothed confidence of the region classification (0..1). */
  regionConfidence: number;
  error: string | null;
};

/** Per-frame snapshot pushed to subscribers (continuous values). */
export type Snapshot = {
  /** Pixel-space landmarks per detected hand. */
  hands: Point[][];
  /** Candidate frame before smoothing (preview), null when not estimable. */
  rawFrame: FrameRect | null;
  /** Smoothed, active frame — null while the frame is inactive. */
  frame: FrameRect | null;
  /** Face bounding box, null when no face was found this frame. */
  faceBox: Box | null;
  faceInSelection: boolean;
  /** Raw normalized face landmarks (empty array when no face was found). */
  faceLandmarks: NormalizedLandmark[];
  /** The four raw frame corners (fingertips), empty when unavailable. */
  corners: Point[];
  /**
   * The four corners of the clipping window after smoothing, in video-pixel
   * space. Empty while the frame is inactive. Unlike `frame` this is the actual
   * quadrilateral the hands form, so it may be trapezoid or asymmetric.
   */
  windowCorners: Point[];
  /**
   * Whether the selection is live this frame (LOCKED or RELEASING). Media
   * opacity follows this flag, *not* `windowCorners.length`, so a one-frame
   * detection dropout never blanks the layer.
   */
  frameActive: boolean;
  /**
   * Which body part the hand-made window is framing. `kind` is null while the
   * frame is inactive or the classifier is not confident enough — the renderer
   * then falls back to plain full-screen clipping.
   */
  region: { kind: RegionKind | null; label: string; confidence: number };
  /** Transform that aligns the template's region with the window, if any. */
  regionTransform: import("./regionMapping").RegionTransform | null;
  /** Pose landmarks of the detected person (empty when unavailable). */
  poseLandmarks: NormalizedLandmark[];
  fps: number;
  /** Debug reason for the current frame-detection state. */
  reason: string;
  videoWidth: number;
  videoHeight: number;
  /** Lip deformation data for the rubber-lip effect, null when no face. */
  lipDeformation: LipDeformationResult | null;
};
