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
import {
  advanceMode,
  gestureAllowed,
  handFrameAllowed,
  INITIAL_MODE,
  type AppMode,
  type ModeEvent,
} from "./modes";
import { SwipeTracker, SWIPE_CONFIG, pickSwipeHand } from "./swipe";
import { PinchCycleDetector } from "./pinch";
import { nextEffect } from "./effects";
import { EMPTY_SELECTION, TOP_LEVEL_ITEMS, selectionPatch, type TopLevelItem } from "./menuModel";
import { computeFaceBox, faceInSelection } from "./faceTracking";
import { smoothingAlpha } from "./smoothing";
import { StickyFrameTracker, FORMING_HOLD_FRAMES } from "./frameTracker";
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

  /**
   * The sticky window tracker. Owns the four corners as one object: smooths
   * them while the hands are visible, coasts them along their last velocity
   * through short dropouts, and reports `lost` only when the hands have been
   * gone long enough to release the selection.
   */
  private tracker = new StickyFrameTracker();

  private selection: SelectionState = INITIAL_SELECTION;

  /**
   * The application mode (lib/modes.ts). Frame formation — the tracker feed
   * AND the selection machine — only runs in FRAME_SEARCH / FRAME_LOCKED; in
   * every other mode both are frozen exactly where they are, so a perfect L
   * in IDLE produces nothing (TEST 1) and an open menu can neither fabricate
   * nor destroy a locked window (its geometry survives until the user picks
   * an item). Changed only through `dispatchMode`, so status stays in sync.
   */
  private mode: AppMode = INITIAL_MODE;

  /** Two-finger swipe state — see lib/swipe.ts. Runs every frame. */
  private swipeTracker = new SwipeTracker();
  /** Double-pinch effect cycling + pinch-held state for the freeze guard. */
  private pinchCycle = new PinchCycleDetector();

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
    mode: INITIAL_MODE,
    menuTop: null,
    contentMode: null,
    template: EMPTY_SELECTION.template,
    effect: EMPTY_SELECTION.effect,
    motion: EMPTY_SELECTION.motion,
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
    // Every field that can arrive through a menu payload is part of the
    // diff: menuTop/contentMode and the three selections change without the
    // mode ever moving (submenu switches, pinch effect cycles), so leaving
    // them out would leave React rendering a stale panel.
    const changed =
      next.camera !== this.status.camera ||
      next.models !== this.status.models ||
      next.mode !== this.status.mode ||
      next.menuTop !== this.status.menuTop ||
      next.contentMode !== this.status.contentMode ||
      next.template !== this.status.template ||
      next.effect !== this.status.effect ||
      next.motion !== this.status.motion ||
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

  // -------------------------------------------------------------------- mode

  /**
   * Feeds an event to the mode machine (lib/modes.ts). Called by the swipe
   * detector, the menu UI, and the selection-machine sync inside `tick`.
   * Illegal events are no-ops, so callers never need the transition graph.
   */
  handleModeEvent(event: ModeEvent): void {
    // Menu payloads are recorded BEFORE the mode moves, so a listener that
    // reacts to the new mode already sees the pick that caused it.
    this.recordMenuPick(event);
    const next = advanceMode(this.mode, event);
    this.applyMode(next);
    if (next === "RESETTING") {
      // Slice H: the RESETTING side effects run synchronously. The machine
      // models "clearing" as its own state (RESETTING -> resetDone -> IDLE)
      // so an animated reset could observe it later; today the clear is
      // instant and the whole chain settles within this one call.
      this.clearFrameState();
      this.applyMode(advanceMode(this.mode, { type: "resetDone" }));
    }
  }

  /**
   * Keeps `AppStatus`'s menu fields in sync with the payloads the menu
   * renderer sends (`openSubmenu.top`, `itemSelected.item`). The machine
   * itself never reads these — only the UI does, via status.
   */
  private recordMenuPick(event: ModeEvent): void {
    if (event.type === "openSubmenu") {
      const top = event.top as TopLevelItem | undefined;
      if (top && TOP_LEVEL_ITEMS.includes(top)) this.patchStatus({ menuTop: top });
    } else if (event.type === "itemSelected" && event.item) {
      // One content mode at a time: the patch sets contentMode and nulls
      // the other two categories (selectionPatch is that rule's source).
      this.patchStatus(selectionPatch(event.item.kind, event.item.id));
    }
  }

  private applyMode(next: AppMode): void {
    if (next === this.mode) return;
    this.mode = next;
    this.patchStatus({ mode: next });
  }

  /**
   * The frame half of a reset: window, selection, face state, region lock —
   * everything that depends on the locked window. Shared by the camera-off
   * `reset()` and by the swipe-left gesture reset (Slice H), so the two can
   * never drift apart on what "clearing everything" means. The content
   * (contentMode + template/effect/motion) is cleared too: spec §22 says a
   * reset leaves "nothing is showing" until the user picks again.
   */
  private clearFrameState(): void {
    this.selection = INITIAL_SELECTION;
    this.lastFaceBox = null;
    this.lastFaceAt = 0;
    this.faceState = "none";
    this.faceAlign = { scale: 1, rotation: 0, tx: 0, ty: 0 };
    this.regionLock = { kind: null, label: "—", confidence: 0 };
    this.tracker.reset();
    this.patchStatus({
      frame: "inactive",
      face: "none",
      contentMode: null,
      template: null,
      effect: null,
      motion: null,
    });
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
    this.clearFrameState();
    this.swipeTracker.reset();
    this.mode = INITIAL_MODE;
    this.patchStatus({
      camera: "off",
      mode: INITIAL_MODE,
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
    // Gesture strictness depends on phase: full strictness while SEARCHING /
    // CANDIDATE (the user must mean the frame), forgiving once LOCKED — the L
    // is never re-validated after lock, only the anchors need to stay readable.
    const wasActive = selectionIsActive(this.selection.phase);
    const handResult = this.handLandmarker.detectForVideo(video, timestamp);
    // MediaPipe's raw hand output — the input side of the coordinate chain.
    const rawHandLandmarks = handResult.landmarks ?? [];
    const pixelHands = rawHandLandmarks.map((lm) => toPixelLandmarks(lm, width, height));

    // --------------------------------------------------------------- swipe
    // The detector runs every frame (its window/cooldown state must stay
    // fresh) and picks its hand via pickSwipeHand(): label "Right" first,
    // image-left fallback — MediaPipe's handedness assumes a mirrored input
    // while we feed it the raw frame, so labels can come back reversed and
    // must not be the only gate. swipeDown opens the menu wherever it is
    // allowed (IDLE / FRAME_SEARCH / FRAME_LOCKED — the geometry-preservation
    // guard in the frame feed below keeps the locked window intact while the
    // sign is held, TEST 11); swipeLeft resets from FRAME_LOCKED, running its
    // RESETTING side effects synchronously inside handleModeEvent (Slice H).
    const swipeHandIndex = pickSwipeHand(
      pixelHands,
      handResult.handednesses ?? null,
      SWIPE_CONFIG.hand
    );
    const swipe = this.swipeTracker.update(
      swipeHandIndex >= 0 ? pixelHands[swipeHandIndex] : null,
      timestamp
    );
    if (swipe === "swipeDown" && gestureAllowed(this.mode, "swipeDown")) {
      this.handleModeEvent({ type: "openMenu" });
    }
    if (swipe === "swipeLeft" && gestureAllowed(this.mode, "swipeLeft")) {
      this.handleModeEvent({ type: "reset" });
    }

    // -------------------------------------------------------------- pinch
    // Decision 1: the FIRST pinch means nothing (it only starts the window
    // and freezes the frame feed via `held` below — degenerate gesture
    // geometry is not tracking loss, same rule as the swipe sign); the
    // SECOND pinch inside the window advances the EFFECT through
    // lib/effects.nextEffect — never the template or the motion, and only
    // while the effect IS the live content mode (spec: in template/motion
    // mode the pinch must not change anything). Consumed only in
    // FRAME_LOCKED (the gesture matrix decides where it means anything);
    // every other mode the detector still runs so its window and edge state
    // stay fresh.
    const pinchDouble = this.pinchCycle.update(rawHandLandmarks, timestamp);
    if (pinchDouble && gestureAllowed(this.mode, "pinch") && this.status.contentMode === "effect") {
      // The cycle goes through selectionPatch too: an effect arriving by
      // gesture keeps contentMode on "effect" and nulls template/motion
      // exactly like a menu pick does.
      this.patchStatus(selectionPatch("effect", nextEffect(this.status.effect)));
    }

    // -------------------------------------------------------------- pointer
    // Index fingertip of the pointing hand, in raw video pixels: the same
    // hand pick as the swipe (right-preferred), falling back to any single
    // visible hand — the menu cursor should never go dead just because the
    // preferred hand is out of frame. Consumed by the menu layer through the
    // coordinate chain; published in every mode so the debug overlay is
    // always honest.
    const pointerHand = swipeHandIndex;
    const pointerLm =
      pointerHand >= 0 ? rawHandLandmarks[pointerHand][8] : null; // landmark 8 = index tip
    const pointer = pointerLm ? { x: pointerLm.x * width, y: pointerLm.y * height } : null;

    // Handedness labels as reported, for the debug readout — this is the
    // row that settles whether the camera's labels are trustworthy.
    const handednessLabels = (handResult.handednesses ?? []).map(
      (h, i) => `${i}:${h?.[0]?.categoryName ?? "?"} ${(h?.[0]?.score ?? 0).toFixed(2)}`
    );

    // MODE GATE (spec AK / TEST 1): frame formation runs only in FRAME_SEARCH
    // and FRAME_LOCKED. Landmarks are still detected everywhere (the debug
    // overlay and, later, the menu pointer read them), but outside the frame
    // modes the tracker feed and the selection machine below are skipped
    // entirely — frozen where they are, so IDLE produces nothing and an open
    // menu can neither fabricate nor destroy a locked window.
    const frameEnabled = handFrameAllowed(this.mode);

    // Slice G — geometry-preservation guard (decision 1 / TEST 11): while
    // the swipe sign is held IN FRAME_LOCKED, the gesture itself degrades the
    // frame's right-hand anchors — the quad deforms toward the flicking hand,
    // goes degenerate, or outruns MediaPipe — and that is the user SPEAKING
    // to the app, not tracking loss. Freezing the tracker feed and the
    // selection machine on the sign is what lets swipeDown open the menu over
    // the SAME window. The pinch guard rides the same switch (decision 1,
    // same rule): while thumb and index are closed the hand's geometry is
    // degenerate by design, so pinchCycle.held freezes the feed as well —
    // its double-pinch consumer above is unaffected.
    const gestureFrozen =
      this.mode === "FRAME_LOCKED" &&
      (this.swipeTracker.gestureHeld || this.pinchCycle.held);
    const feedFrame = frameEnabled && !gestureFrozen;

    const detection: HandFrameDetection = detectHandFrame(
      handResult.landmarks,
      width,
      height,
      wasActive ? "track" : "acquire"
    );
    const rawFrame = calculateFrame(detection.corners);
    const validity = isValidQuad(detection.corners, width, height);
    const hasCorners = detection.corners.length === 4;
    const usable = feedFrame && hasCorners && validity.valid;

    // The tracker is fed BEFORE the selection machine reads its state, so the
    // state describes this frame. Only usable corners are fed; a frame where
    // the hands are present but the shape is degenerate counts as a miss, and
    // the window holds its last good shape instead of collapsing.
    if (feedFrame) {
      this.tracker.update(usable ? detection.corners : null, dt);
      // While still FORMING the window is not yet a selection, so stale dots
      // are cleared shortly after the hands leave. A live selection holds for
      // the full grace budget — the machine, not the tracker, decides when it
      // ends.
      if (!wasActive && this.tracker.missedFrames > FORMING_HOLD_FRAMES) {
        this.tracker.reset();
      }
    }
    const windowCorners = this.tracker.value ?? [];

    // RELEASE RULE: while locked, the selection is only invalid when the
    // tracker has given up — i.e. the hands were genuinely gone for
    // maxMissedFrames. A tilted, trapezoid, or momentarily misread frame never
    // counts toward release on its own. While acquiring, the strict quad check
    // still gates the initial lock. (Both blocks share `feedFrame`: the
    // gesture guard freezes the whole selection advance, tracker included.)
    if (feedFrame) {
      const advance = advanceSelection(this.selection, {
        valid: wasActive ? this.tracker.state !== "lost" : usable,
        hasCorners,
      });
      this.selection = advance.state;

      if (advance.deactivated) {
        this.tracker.reset();
        this.lastFaceBox = null;
        this.faceState = "none";
        this.faceAlign = { scale: 1, rotation: 0, tx: 0, ty: 0 };
      }
    }
    const active = selectionIsActive(this.selection.phase);

    // MODE SYNC: the selection machine drives FRAME_SEARCH <-> FRAME_LOCKED.
    // State-based rather than edge-based, so a window frozen while the menu
    // was open rejoins FRAME_LOCKED on its first tracked frame again (TEST 11)
    // without needing a fresh lock event.
    if (active && this.mode === "FRAME_SEARCH") {
      this.applyMode(advanceMode(this.mode, { type: "frameLocked" }));
    } else if (!active && this.mode === "FRAME_LOCKED") {
      this.applyMode(advanceMode(this.mode, { type: "frameReleased" }));
    }

    // The fitted rect is derived from the same corners the clip uses — one
    // source of truth, no second smoother adding its own lag on top.
    let frame: FrameRect | null = null;
    if (active && windowCorners.length === 4) {
      frame = calculateFrame(windowCorners);
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
    const snapshot: Snapshot = {
      hands: pixelHands,
      handLandmarksNorm: rawHandLandmarks,
      rawFrame,
      frame,
      faceBox,
      faceInSelection: faceInFrame,
      faceLandmarks: faceLandmarksThisFrame,
      corners: detection.corners,
      pointer,
      handedness: handednessLabels,
      swipe: this.swipeTracker.debugState(timestamp, swipeHandIndex),
      windowCorners,
      frameActive: active,
      selectionPhase: this.selection.phase,
      missedFrames: this.tracker.missedFrames,
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
        mode: this.mode,
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
