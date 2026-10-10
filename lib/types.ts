/**
 * Shared geometry / tracking types for the Hand Frame → Vector pipeline.
 *
 * All coordinates produced by MediaPipe are normalized to [0..1] of the video
 * frame. Everything inside `lib` works in *pixel* space of the video
 * (video.videoWidth x video.videoHeight) so distances are aspect-correct.
 * Renderers convert pixels back to percentages of the stage.
 */

import type { RegionKind } from "./regions";
import type { SelectionPhase } from "./selection";
import type { AppMode } from "./modes";

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
  /**
   * The application mode machine's current mode (lib/modes.ts). Discrete, so
   * it lives here and not in the per-frame `Snapshot`: frame formation only
   * runs in FRAME_SEARCH / FRAME_LOCKED, and every mode change is a UI-level
   * event (menu open, item selected, lock, release, reset), not a per-frame
   * value.
   */
  mode: AppMode;
  /**
   * Which top-level entry the open submenu belongs to (null until the first
   * pick). Recorded by the engine from `openSubmenu`'s payload — the menu
   * renderer's tabs and highlight read it from here.
   */
  menuTop: import("./menuModel").TopLevelItem | null;
  /**
   * Which category is THE content mode (user rule: template, effect and
   * motion are mutually exclusive — only one renders at a time). Null means
   * "nothing is showing" (fresh state or after a reset); `selectionPatch`
   * is the single source that flips it on a pick.
   */
  contentMode: import("./modes").MenuPick["kind"] | null;
  /**
   * The live content values — set by `itemSelected` payloads via
   * `selectionPatch`, which nulls the two non-active categories so exactly
   * one is non-null, matching `contentMode`. They are APP state within a
   * session, but a gesture reset or camera-off clears them back to null
   * (spec §22: reset leaves "nothing is showing").
   */
  template: string | null;
  effect: string | null;
  motion: string | null;
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
  /**
   * The raw MediaPipe hand output, normalized [0..1] — the input side of the
   * coordinate chain, kept alongside `hands` so the debug overlay can print
   * "raw → stage" for a landmark and prove the mapping end to end.
   */
  handLandmarksNorm: NormalizedLandmark[][];
  /** Candidate frame before smoothing (preview), null when not estimable. */
  rawFrame: FrameRect | null;
  /**
   * The fitted oriented rectangle of the ACTIVE window, derived each frame from
   * `windowCorners` so the two can never disagree. Null while inactive.
   */
  frame: FrameRect | null;
  /** Face bounding box, null when no face was found this frame. */
  faceBox: Box | null;
  faceInSelection: boolean;
  /** Raw normalized face landmarks (empty array when no face was found). */
  faceLandmarks: NormalizedLandmark[];
  /** The four raw frame corners (fingertips), empty when unavailable. */
  corners: Point[];
  /**
   * The menu pointer: the index fingertip (landmark 8) of the pointing hand,
   * in raw video pixels (pre-mirror, like `hands`). The renderer runs it
   * through the single coordinate chain — `toStageFraction`/`toStagePixels`
   * — so it lands exactly where the finger appears on the mirrored preview.
   * The engine prefers the right hand (spec: right-hand pointer) and falls
   * back to any visible hand. Null when no hand is visible.
   */
  pointer: Point | null;
  /**
   * MediaPipe's handedness verdict per detected hand ("0:Right 0.97"),
   * raw as reported. Debug readout: it settles whether this camera's labels
   * can be trusted, since MediaPipe decides handedness assuming a mirrored
   * input while we feed it the raw frame.
   */
  handedness: string[];
  /** Swipe detector live state — debug readout for the gesture hunt. */
  swipe: import("./swipe").SwipeDebug;
  /**
   * The four corners of the hand-made window, in video-pixel space — the single
   * source the yellow dots and the clip-path both read, so they can never
   * disagree. Produced by the sticky tracker (`lib/frameTracker.ts`): eased
   * toward the fingertips while the hands are seen, and coasted along its last
   * velocity through short detection dropouts instead of freezing or
   * vanishing. Populated while the selection is forming or active, and cleared
   * only when the selection deactivates or the forming window gives up. Unlike
   * `frame` this is the actual quadrilateral the hands form, so it may be
   * trapezoid or asymmetric. Gating the *visible* clip on `frameActive` is what
   * keeps it hidden while merely forming.
   */
  windowCorners: Point[];
  /**
   * Whether the selection is live this frame (LOCKED or RELEASING). Media
   * opacity follows this flag, *not* `windowCorners.length`, so a one-frame
   * detection dropout never blanks the layer.
   */
  frameActive: boolean;
  /**
   * The selection machine's phase this frame. Debug-only readout; the spec
   * wants SEARCHING / CANDIDATE / LOCKED / RELEASING visible while tuning the
   * sticky-lock behaviour. `frameActive` is derived from it and is what the
   * renderers actually gate on.
   */
  selectionPhase: SelectionPhase;
  /**
   * Consecutive frames the window tracker has gone without usable corners.
   * Zero while tracking; counts up through the grace budget while holding; the
   * frame releases once it passes `TRACK_CONFIG.maxMissedFrames`.
   */
  missedFrames: number;
  /**
   * The window tracker's state this frame: "tracking" (all four slots saw a
   * fresh anchor), "holding" (one hand's slots are blind and held, the rest
   * still following) or "lost" (every slot blind past the budget). Debug
   * readout — it pinpoints which side of a partial detection the frame is on.
   */
  trackState: import("./frameTracker").TrackState;
  /**
   * Per-slot blind counters (thumb/index per hand, in slot order). Debug
   * readout — the pair that counts up is the hand the tracker is holding.
   */
  anchorMissed: number[];
  /**
   * Per-hand gesture verdict reasons, raw: "ok", a rejection reason
   * (MediaPipe still sees the hand but the classifier refused it), or
   * "anchor-fallback:<why>" (the hand degraded to its two fingertips and is
   * still carrying the window). Debug readout that separates MediaPipe loss
   * from gesture rejection at a glance.
   */
  handReasons: string[];
  /**
   * Which body part the hand-made window is framing. `kind` is null while the
   * frame is inactive or the classifier is not confident enough — the renderer
   * then falls back to plain full-screen clipping.
   */
  region: { kind: RegionKind | null; label: string; confidence: number };
  /** Transform that aligns the template's region with the window, if any. */
  regionTransform: import("./regionMapping").RegionTransform | null;
  /**
   * Similarity transform (scale + rotation + translation, video pixels) that
   * maps the template's face anchors onto the user's face anchors, so the
   * character's face tracks the real face. Identity/null when the selection is
   * not on a face or no face is detected. Applied on the media element only —
   * the clip window is a separate element and never transformed.
   */
  faceAlign: import("./faceAlignment").Similarity | null;
  /** Pose landmarks of the detected person (empty when unavailable). */
  poseLandmarks: NormalizedLandmark[];
  fps: number;
  /** Debug reason for the current frame-detection state. */
  reason: string;
  videoWidth: number;
  videoHeight: number;
};
