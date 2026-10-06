import type {
  AppStatus,
  Box,
  FaceState,
  FrameRect,
  HandFrameDetection,
  Point,
  Snapshot,
} from "./types";
import {
  HAND_CONNECTIONS,
  rectCorners,
  toPixelLandmarks,
} from "./geometry";
import {
  advanceSelection,
  INITIAL_SELECTION,
  selectionIsActive,
  type SelectionState,
} from "./selection";
import { calculateFrame, detectHandFrame, isValidQuad } from "./handFrame";
import { computeFaceBox, faceInSelection } from "./faceTracking";
import { RectSmoother, CornerSmoother, planCornerFrame, smoothingAlpha } from "./smoothing";
import {
  advanceRegion,
  classifyRegion,
  REGION_CONFIDENCE_TAU,
  type ClassificationResult,
} from "./regions";
import { mapRegionTransform } from "./regionMapping";
import {
  faceAlignment,
  userFacePoints,
  IDENTITY_SIMILARITY,
} from "./faceAlignment";

const WASM_PATH = "/mediapipe/wasm";
const HAND_MODEL_PATH = "/models/hand_landmarker.task";
const FACE_MODEL_PATH = "/models/face_landmarker.task";
const POSE_MODEL_PATH = "/models/pose_landmarker.task";

/** Keep using the last face box for this long when detection blinks, to avoid flicker. */
const FACE_HOLD_MS = 500;

/**
 * Region classification needs to be sticky — the hysteresis (switch margin,
 * confidence EMA, fallback threshold) lives in lib/regions.ts as
 * `advanceRegion` so it can be unit-tested directly.
 */

function quadToNormBox(
  corners: Point[],
  width: number,
  height: number
): { x: number; y: number; width: number; height: number } {
  if (corners.length !== 4) return { x: 0.5, y: 0.5, width: 0, height: 0 };
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const c of corners) {
    minX = Math.min(minX, c.x);
    minY = Math.min(minY, c.y);
    maxX = Math.max(maxX, c.x);
    maxY = Math.max(maxY, c.y);
  }
  const w = Math.max(width, 1);
  const h = Math.max(height, 1);
  return {
    x: minX / w,
    y: minY / h,
    width: (maxX - minX) / w,
    height: (maxY - minY) / h,
  };
}

export type EngineSnapshotListener = (snapshot: Snapshot) => void;
export type EngineStatusListener = (status: AppStatus) => void;

/**
 * Owns the single realtime loop: webcam frame → hand landmarks → hand frame →
 * face landmarks → vector transform.
 *
 * Everything runs in one `requestAnimationFrame` loop on the main thread. Hand
 * detection runs every frame; face detection runs only while a valid frame is
 * active, because that is the only time a face matters. Continuous values are
 * pushed to subscribers as a snapshot (overlays write them straight to the DOM
 * so React never re-renders at 60fps); discrete state is diffed and only
 * published when it changes.
 */
export class HandFrameEngine {
  private video: HTMLVideoElement | null = null;
  private handLandmarker: import("@mediapipe/tasks-vision").HandLandmarker | null = null;
  private faceLandmarker: import("@mediapipe/tasks-vision").FaceLandmarker | null = null;
  private poseLandmarker: import("@mediapipe/tasks-vision").PoseLandmarker | null = null;

  private rafId: number | null = null;
  private loadingModels: Promise<void> | null = null;
  /**
   * Bumped on every load/dispose cycle. An in-flight `loadModels()` whose
   * generation has gone stale must not install its landmarkers — they may have
   * been closed by a `dispose()` in between (this happens under React StrictMode,
   * which double-invokes effects in development).
   */
  private generation = 0;
  private lastVideoTime = -1;
  private lastTimestamp = 0;
  private fpsEma = 0;
  private lastFrameAt = 0;

  private frameSmoother = new RectSmoother();
  private cornerSmoother = new CornerSmoother();
  /** Frames the corner smoother has been held without valid corners. */
  private cornerHeld = 0;

  private selection: SelectionState = INITIAL_SELECTION;

  private faceState: FaceState = "none";
  private lastFaceBox: Box | null = null;
  private lastFaceAt = 0;

  /** Smoothed face→template alignment — see lib/faceAlignment.ts. */
  private faceAlign: import("./faceAlignment").Similarity = {
    scale: 1,
    rotation: 0,
    tx: 0,
    ty: 0,
  };

  /** Smoothed region classification — see REGION_LOCK in lib/regions.ts. */
  private regionLock: import("./regions").RegionLockState = {
    kind: null,
    label: "—",
    confidence: 0,
  };

  private status: AppStatus = {
    camera: "off",
    models: "loading",
    hands: 0,
    frame: "inactive",
    face: "none",
    region: null,
    regionConfidence: 0,
    error: null,
  };

  private snapshotListeners = new Set<EngineSnapshotListener>();
  private statusListeners = new Set<EngineStatusListener>();

  // ---------------------------------------------------------------- listeners

  onSnapshot(listener: EngineSnapshotListener): () => void {
    this.snapshotListeners.add(listener);
    return () => this.snapshotListeners.delete(listener);
  }

  onStatus(listener: EngineStatusListener): () => void {
    this.statusListeners.add(listener);
    listener(this.status);
    return () => this.statusListeners.delete(listener);
  }

  subscribe = this.onSnapshot.bind(this);

  private patchStatus(patch: Partial<AppStatus>): void {
    const next: AppStatus = { ...this.status, ...patch };
    const changed =
      next.camera !== this.status.camera ||
      next.models !== this.status.models ||
      next.hands !== this.status.hands ||
      next.frame !== this.status.frame ||
      next.face !== this.status.face ||
      next.region !== this.status.region ||
      Math.abs(next.regionConfidence - this.status.regionConfidence) > 0.02 ||
      next.error !== this.status.error;
    this.status = next;
    if (changed) {
      for (const listener of this.statusListeners) listener(next);
    }
  }

  // ------------------------------------------------------------------- models

  async loadModels(): Promise<void> {
    if (this.handLandmarker && this.faceLandmarker) return;
    if (this.loadingModels) return this.loadingModels;
    const generation = ++this.generation;
    this.loadingModels = (async () => {
      const vision = await import("@mediapipe/tasks-vision");
      const fileset = await vision.FilesetResolver.forVisionTasks(WASM_PATH);
      if (generation !== this.generation) return; // superseded by a later load/dispose
      this.handLandmarker = await this.createWithFallback(
        (delegate) =>
          vision.HandLandmarker.createFromOptions(fileset, {
            baseOptions: { modelAssetPath: HAND_MODEL_PATH, delegate },
            runningMode: "VIDEO",
            numHands: 2,
            minHandDetectionConfidence: 0.5,
            minHandPresenceConfidence: 0.5,
            minTrackingConfidence: 0.5,
          }),
        "hand"
      );
      if (generation !== this.generation) {
        this.handLandmarker.close();
        this.handLandmarker = null;
        return;
      }
      this.faceLandmarker = await this.createWithFallback(
        (delegate) =>
          vision.FaceLandmarker.createFromOptions(fileset, {
            baseOptions: { modelAssetPath: FACE_MODEL_PATH, delegate },
            runningMode: "VIDEO",
            numFaces: 1,
            minFaceDetectionConfidence: 0.4,
            minFacePresenceConfidence: 0.4,
            minTrackingConfidence: 0.4,
            outputFaceBlendshapes: false,
            outputFacialTransformationMatrixes: false,
          }),
        "face"
      );
      if (generation !== this.generation) {
        this.faceLandmarker.close();
        this.faceLandmarker = null;
        return;
      }
      // Pose is optional: if it fails to load, region classification just
      // loses body regions and falls back to face/eyes + plain clipping.
      try {
        this.poseLandmarker = await this.createWithFallback(
          (delegate) =>
            vision.PoseLandmarker.createFromOptions(fileset, {
              baseOptions: { modelAssetPath: POSE_MODEL_PATH, delegate },
              runningMode: "VIDEO",
              numPoses: 1,
              minPoseDetectionConfidence: 0.3,
              minPosePresenceConfidence: 0.3,
              minTrackingConfidence: 0.3,
            }),
          "pose"
        );
      } catch (error) {
        console.warn("[engine] pose landmarker unavailable; region mapping limited to face", error);
      }
      if (generation !== this.generation) {
        this.poseLandmarker?.close();
        this.poseLandmarker = null;
        return;
      }
      this.patchStatus({ models: "ready" });
    })();
    return this.loadingModels;
  }

  /**
   * GPU is noticeably faster but is picky about WebGL contexts; CPU is the safe
   * fallback. Try GPU first and silently degrade. `?cpu=1` in the URL pins the
   * CPU delegate (diagnostics for machines where GPU inference silently
   * returns empty results instead of throwing).
   */
  private async createWithFallback<T>(
    create: (delegate: "GPU" | "CPU") => Promise<T>,
    label: string
  ): Promise<T> {
    if (typeof window !== "undefined" && new URLSearchParams(window.location.search).get("cpu") === "1") {
      console.warn(`[engine] pinning CPU delegate for ${label} via ?cpu=1`);
      return await create("CPU");
    }
    try {
      return await create("GPU");
    } catch (error) {
      console.warn(`[engine] GPU delegate unavailable for ${label}; falling back to CPU`, error);
      return await create("CPU");
    }
  }

  // ------------------------------------------------------------------ camera

  attach(video: HTMLVideoElement): void {
    this.video = video;
  }

  start(): void {
    if (this.rafId !== null) return;
    this.lastVideoTime = -1;
    this.lastTimestamp = 0;
    this.lastFrameAt = performance.now();
    this.rafId = requestAnimationFrame(this.tick);
  }

  stop(): void {
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
  }

  /** Resets all tracking state, e.g. when the camera is turned off. */
  reset(): void {
    this.stop();
    this.selection = INITIAL_SELECTION;
    this.lastFaceBox = null;
    this.lastFaceAt = 0;
    this.faceState = "none";
    this.regionLock = { kind: null, label: "—", confidence: 0 };
    this.frameSmoother.reset();
    this.cornerSmoother.reset();
    this.cornerHeld = 0;
    this.patchStatus({
      camera: "off",
      hands: 0,
      frame: "inactive",
      face: "none",
    });
  }

  setCameraStatus(camera: AppStatus["camera"], error: string | null = null): void {
    this.patchStatus({ camera, error });
  }

  setModelsStatus(models: AppStatus["models"], error: string | null = null): void {
    this.patchStatus({ models, error });
  }

  dispose(): void {
    this.stop();
    this.generation += 1; // invalidate any in-flight loadModels()
    this.loadingModels = null;
    this.snapshotListeners.clear();
    this.statusListeners.clear();
    this.handLandmarker?.close();
    this.faceLandmarker?.close();
    this.poseLandmarker?.close();
    this.handLandmarker = null;
    this.faceLandmarker = null;
    this.poseLandmarker = null;
  }

  // ------------------------------------------------------------------ region
  // Hysteresis lives in lib/regions.ts (advanceRegion) so it is unit-testable;
  // the engine only threads the lock state through frames.

  // -------------------------------------------------------------------- loop

  private tick = (now: number): void => {
    this.rafId = requestAnimationFrame(this.tick);
    const video = this.video;
    if (!video || !this.handLandmarker || !this.faceLandmarker) return;
    if (video.readyState < 2 || video.paused || video.ended) return;
    if (!video.videoWidth || !video.videoHeight) return;

    // Only process frames the camera actually produced.
    if (video.currentTime === this.lastVideoTime) return;
    this.lastVideoTime = video.currentTime;

    // MediaPipe video mode requires strictly increasing timestamps.
    const timestamp = now > this.lastTimestamp ? now : this.lastTimestamp + 1;
    this.lastTimestamp = timestamp;

    const dt = Math.min(Math.max((now - this.lastFrameAt) / 1000, 0), 0.1);
    this.lastFrameAt = now;
    if (dt > 0) {
      const instant = 1 / dt;
      this.fpsEma = this.fpsEma === 0 ? instant : this.fpsEma * 0.9 + instant * 0.1;
    }

    const width = video.videoWidth;
    const height = video.videoHeight;

    // ---------------------------------------------------------- hand frame
    const handResult = this.handLandmarker.detectForVideo(video, timestamp);
    const detection: HandFrameDetection = detectHandFrame(
      handResult.landmarks,
      width,
      height
    );
    const rawFrame = calculateFrame(detection.corners);
    const validity = isValidQuad(detection.corners, width, height);
    const hasCorners = detection.corners.length === 4;

    const advance = advanceSelection(this.selection, {
      valid: validity.valid && hasCorners,
      hasCorners,
    });
    this.selection = advance.state;
    const active = selectionIsActive(this.selection.phase);

    if (advance.deactivated) {
      this.frameSmoother.reset();
      this.cornerSmoother.reset();
      this.cornerHeld = 0;
      this.lastFaceBox = null;
      this.faceState = "none";
      this.faceAlign = { scale: 1, rotation: 0, tx: 0, ty: 0 };
    }

    // Corners are smoothed from the FORMING stage onward — never raw →
    // rendered — and a detection blink holds the last position for a few
    // frames instead of emptying instantly (see planCornerFrame). The window
    // is published whether or not the selection is active; every consumer
    // gates the visible clip on `frameActive`.
    const plan = planCornerFrame(
      this.cornerHeld,
      hasCorners && validity.valid,
      active
    );
    this.cornerHeld = plan.held;
    if (plan.clear) this.cornerSmoother.reset();
    if (plan.feed) this.cornerSmoother.update(detection.corners, dt);
    const windowCorners = this.cornerSmoother.value ?? [];

    let frame: FrameRect | null = null;
    if (active) {
      if (hasCorners && validity.valid) {
        if (rawFrame) frame = this.frameSmoother.update(rawFrame, dt);
      } else {
        // Temporary dropout: hold the last smoothed rectangle instead of
        // blanking it. The smoothers keep their state, so nothing snaps when
        // detection returns.
        frame = this.frameSmoother.value;
      }
    }

    // --------------------------------------------------------------- face
    let faceBox: Box | null = null;
    let faceInFrame = false;
    let faceLandmarksThisFrame: import("./types").NormalizedLandmark[] = [];
    if (active && frame) {
      const faceResult = this.faceLandmarker.detectForVideo(video, timestamp);
      const landmarks = faceResult.faceLandmarks?.[0];
      faceLandmarksThisFrame = landmarks ?? [];
      const detected = computeFaceBox(landmarks, width, height);
      if (detected) {
        faceBox = detected;
        this.lastFaceBox = detected;
        this.lastFaceAt = now;
      } else if (this.lastFaceBox && now - this.lastFaceAt < FACE_HOLD_MS) {
        faceBox = this.lastFaceBox;
      }

      if (faceBox) {
        faceInFrame = faceInSelection(faceBox, frame);
        this.faceState = faceInFrame ? "in-frame" : "outside";
      } else {
        this.faceState = "none";
      }

      // Face→template alignment: only while the selection captures the face.
      // The result is smoothed (tau 0.15s) so the media glides instead of
      // snapping when landmarks jitter.
      const target = faceInFrame
        ? faceAlignment(userFacePoints(landmarks ?? null), width, height)
        : IDENTITY_SIMILARITY;
      const alpha = smoothingAlpha(dt, 0.15);
      const cur = this.faceAlign;
      this.faceAlign = {
        scale: cur.scale + (target.scale - cur.scale) * alpha,
        rotation: cur.rotation + (target.rotation - cur.rotation) * alpha,
        tx: cur.tx + (target.tx - cur.tx) * alpha,
        ty: cur.ty + (target.ty - cur.ty) * alpha,
      };
    } else if (!active) {
      this.faceAlign = { scale: 1, rotation: 0, tx: 0, ty: 0 };
    }

    // --------------------------------------------------- media window effect
    // The media is visible whenever the frame is active — the frame is the
    // trigger, not the face. Face detection stays as a secondary indicator.

    // ------------------------------------------------------- full-body pose
    // Runs on EVERY frame the camera produces. Full-body tracking must not
    // depend on the face tracker or on the selection being active: the 33
    // pose landmarks are available from the first frame, so the debug
    // skeleton draws before any window is ever formed. Region classification
    // below is the only thing that needs a selection.
    let poseLandmarksThisFrame: import("./types").NormalizedLandmark[] = [];
    if (this.poseLandmarker) {
      const poseResult = this.poseLandmarker.detectForVideo(video, timestamp);
      poseLandmarksThisFrame = poseResult.landmarks?.[0] ?? [];
    }

    // ---------------------------------------------- region classification
    let regionScoresThisFrame: ClassificationResult["scores"] = [];
    if (active && frame) {
      // The window the hands enclose, in normalized coordinates — the same
      // space the pose/face landmarks live in, so no hardcoded screen coords.
      const selection = quadToNormBox(windowCorners, width, height);
      const classified = classifyRegion(
        selection,
        poseLandmarksThisFrame.length ? poseLandmarksThisFrame : null,
        faceLandmarksThisFrame.length ? faceLandmarksThisFrame : null
      );
      regionScoresThisFrame = classified.scores;

      this.regionLock = advanceRegion(
        this.regionLock,
        classified,
        smoothingAlpha(dt, REGION_CONFIDENCE_TAU)
      );
    } else {
      this.regionLock = { kind: null, label: "—", confidence: 0 };
    }

    // -------------------------------------------------------------- status
    this.patchStatus({
      hands: detection.handCount,
      frame: active ? "active" : "inactive",
      face: active ? this.faceState : "none",
      region: this.regionLock.kind,
      regionConfidence: this.regionLock.confidence,
    });

    // Region transform is disabled for now — the media stays full-frame
    // behind the clipping window without any zoom/pan. The classifier still
    // runs for the debug readout but does not affect rendering.
    const regionTransform = null as import("./regionMapping").RegionTransform | null;
    // MediaPipe's raw hand output — the input side of the coordinate chain.
    const rawHandLandmarks = handResult.landmarks ?? [];
    const snapshot: Snapshot = {
      hands: rawHandLandmarks.map((lm) => toPixelLandmarks(lm, width, height)),
      handLandmarksNorm: rawHandLandmarks,
      rawFrame,
      frame,
      faceBox,
      faceInSelection: faceInFrame,
      faceLandmarks: faceLandmarksThisFrame,
      corners: detection.corners,
      windowCorners,
      frameActive: active,
      region: this.regionLock,
      regionTransform,
      faceAlign: active ? this.faceAlign : null,
      poseLandmarks: poseLandmarksThisFrame,
      fps: this.fpsEma,
      reason: detection.corners.length === 4 ? validity.reason : detection.reason,
      videoWidth: width,
      videoHeight: height,
    };

    // Diagnostic hook for manual inspection / automated checks.
    if (typeof window !== "undefined") {
      (window as unknown as { __handFrameDebug?: unknown }).__handFrameDebug = {
        handLandmarkCount: rawHandLandmarks.length,
        rawHandLandmarks,
        faceLandmarkCount: faceLandmarksThisFrame.length,
        poseLandmarkCount: poseLandmarksThisFrame.length,
        detection,
        validity,
        selection: this.selection,
        region: this.regionLock,
        regionScores: regionScoresThisFrame,
        snapshot,
      };
    }

    for (const listener of this.snapshotListeners) listener(snapshot);
  };
}

export { HAND_CONNECTIONS, rectCorners };
export type { Point };
