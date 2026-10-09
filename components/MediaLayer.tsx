"use client";

import { useEffect, useRef, useState, type RefObject } from "react";
import { clipPathPolygon, mediaMatrix, MIRROR_TRANSFORM } from "@/lib/stage";
import { motionClass, type BlurLevel } from "@/lib/effects";
import { EffectEngine } from "@/lib/effectEngine";
import { MotionEngine, isCanvasMotion } from "@/lib/motionEngine";
import { OverlayRenderer, isOverlayTemplate, type OverlayTemplateId } from "@/lib/overlayTemplates";
import { mediaKindFromSource } from "@/lib/media";
import type { Snapshot } from "@/lib/types";
import type { MenuPick } from "@/lib/modes";

export type MediaLayerProps = {
  subscribe: (listener: (snapshot: Snapshot) => void) => () => void;
  /**
   * The live content mode (spec §22: template, effect and motion are
   * mutually exclusive modes). Decides WHAT renders inside the window:
   *
   *   template → the asset (src) behind the mirror∘align matrix
   *   effect   → a canvas processing the REAL camera pixels (blur, particles,
   *              grading, glitch) — nothing overlays, the frame itself changes
   *   motion   → a camera copy inside an animated wrapper (the media moves)
   *   null     → nothing; raw camera through the window
   */
  contentMode: MenuPick["kind"] | null;
  /** Template/upload asset path — only rendered while contentMode is "template". */
  src: string | null;
  /** MIME type for uploaded blob URLs; asset paths can infer from extension. */
  srcMimeType?: string | null;
  /**
   * Apply face→template alignment (lib/faceAlignment). Only valid for the
   * bundled template whose face anchors are configured in templateRegions —
   * uploaded media has unknown landmarks and must stay untransformed.
   */
  faceAlignEnabled?: boolean;
  /** Live effect id — runs the engine only while contentMode is "effect". */
  effect?: string | null;
  /** Blur intensity while the blur effect is live (control row cycles it). */
  blurLevel?: BlurLevel;
  /** Live motion id — animates the camera copy while contentMode is "motion". */
  motion?: string | null;
  /** The live camera element; effect mode samples it, motion mode mirrors it. */
  cameraVideoRef?: RefObject<HTMLVideoElement | null> | null;
};

/**
 * Layer stack — clip and transform are deliberately on DIFFERENT elements
 * (transforming the clipped element would drag the window along):
 *
 *   MediaLayer               (root, opacity 1, no background)
 *   └── ClipWindow           (clip-path only — the hand-made window; it is
 *                             NEVER animated — window geometry is sacred)
 *       ├── MediaContent     (template mode; transform only — mirror + face
 *       │   └── <img>/<video>   alignment)
 *       ├── MotionWrapper    (motion mode; animated full-size wrapper holding
 *       │   └── camera <video>  a mirrored copy of the live camera)
 *       └── EffectCanvas     (effect mode; processed-camera canvas, never
 *           └── <canvas>        transformed — the clip stays the only cut)
 *
 * Exactly one of the three renders per contentMode — the mutual-exclusion
 * rule is what keeps the window showing camera+effect in effect mode (no
 * template image ever leaks in) and camera-only in motion mode.
 *
 * Visibility is controlled by clip-path: `inset(50%)` (zero-area) when
 * inactive, the hand-made polygon when active. No opacity toggling — the
 * camera is always visible through transparent areas.
 *
 * Face alignment is a similarity transform (scale + rotate + translate) solved
 * in video-pixel space by lib/faceAlignment.ts, converted to a CSS matrix
 * here. The mirror is composed into the same matrix so the two never fight.
 */
export function MediaLayer({
  subscribe,
  contentMode,
  src,
  srcMimeType = null,
  faceAlignEnabled = true,
  effect = null,
  blurLevel = "medium",
  motion = null,
  cameraVideoRef = null,
}: MediaLayerProps) {
  const clipRef = useRef<HTMLDivElement | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const mediaRef = useRef<HTMLVideoElement | null>(null);
  const motionVideoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const motionCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const overlayCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const engineRef = useRef<EffectEngine | null>(null);
  const motionEngineRef = useRef<MotionEngine | null>(null);
  const overlayRendererRef = useRef<OverlayRenderer | null>(null);
  const [isVideo, setIsVideo] = useState(false);

  // Render gates: each mode owns exactly one layer (mutual exclusion).
  const effectCanvas = contentMode === "effect" && effect ? effect : null;
  const motionCss =
    contentMode === "motion" && motion && !isCanvasMotion(motion)
      ? motionClass(motion)
      : "";
  // Canvas motions (echo, freeze, shutter, portal, reality-zoom) render via
  // MotionEngine instead of the CSS motion wrapper.
  const canvasMotion =
    contentMode === "motion" && motion && isCanvasMotion(motion) ? motion : null;
  // Overlay templates (face-wireframe, cyber-mask, …) render a canvas on top
  // of the camera instead of an <img>/<video> media element.
  const overlayTemplate =
    contentMode === "template" && src !== null && isOverlayTemplate(src)
      ? (src as OverlayTemplateId)
      : null;

  // Effect engine lifecycle: one engine per (effect id, blur level). Its
  // presence doubles as the render gate inside the snapshot callback, so the
  // callback needs no contentMode/effect deps and never re-subscribes.
  useEffect(() => {
    if (!effectCanvas) {
      engineRef.current?.dispose();
      engineRef.current = null;
      return;
    }
    const canvas = canvasRef.current;
    if (!canvas) return;
    const engine = new EffectEngine(canvas, effectCanvas, blurLevel);
    engineRef.current = engine;
    return () => {
      engine.dispose();
      if (engineRef.current === engine) engineRef.current = null;
    };
  }, [effectCanvas, blurLevel]);

  // Motion engine lifecycle: one engine per canvas-motion id.
  useEffect(() => {
    if (!canvasMotion) {
      motionEngineRef.current?.dispose();
      motionEngineRef.current = null;
      return;
    }
    const canvas = motionCanvasRef.current;
    if (!canvas) return;
    const engine = new MotionEngine(canvas, canvasMotion);
    motionEngineRef.current = engine;
    return () => {
      engine.dispose();
      if (motionEngineRef.current === engine) motionEngineRef.current = null;
    };
  }, [canvasMotion]);

  // Overlay template lifecycle: one renderer per overlay id.
  useEffect(() => {
    if (!overlayTemplate) {
      overlayRendererRef.current?.dispose();
      overlayRendererRef.current = null;
      return;
    }
    const canvas = overlayCanvasRef.current;
    if (!canvas) return;
    const renderer = new OverlayRenderer(canvas, overlayTemplate);
    overlayRendererRef.current = renderer;
    return () => {
      renderer.dispose();
      if (overlayRendererRef.current === renderer) overlayRendererRef.current = null;
    };
  }, [overlayTemplate]);

  useEffect(() => {
    setIsVideo(mediaKindFromSource(src, srcMimeType) === "video");
  }, [src, srcMimeType]);

  useEffect(() => {
    if (!isVideo || !src) return;
    const video = mediaRef.current;
    if (!video) return;
    video.play().catch((error) => {
      console.warn("[MediaLayer] video autoplay blocked", error);
    });
  }, [isVideo, src]);

  useEffect(() => {
    const off = subscribe((snapshot) => {
      const clip = clipRef.current;
      if (!clip) return;

      const { windowCorners, videoWidth, videoHeight, frameActive, faceAlign } =
        snapshot;

      // ---- clip window (this element is never transformed, never animated) ----
      if (windowCorners.length === 4 && frameActive) {
        clip.style.clipPath = `polygon(${clipPathPolygon(
          windowCorners,
          videoWidth,
          videoHeight
        )})`;
      } else {
        clip.style.clipPath = "inset(50%)";
      }

      // ---- motion copy: mirror the live camera stream into the window ----
      // The stream lands on the camera element asynchronously (startCamera),
      // so the copy picks it up here, at frame rate, whenever it differs.
      const copy = motionVideoRef.current;
      const camera = cameraVideoRef?.current ?? null;
      if (copy && camera && copy.srcObject !== camera.srcObject) {
        copy.srcObject = camera.srcObject;
        copy.play().catch(() => {
          /* muted copy: autoplay is allowed; ignore late rejections */
        });
      }

      // ---- effect canvas: process the live camera inside the window ----
      // Runs BEFORE the template-only transform block below: in effect mode
      // contentRef is absent, so anything placed after those guards would
      // never execute.
      const engine = engineRef.current;
      if (engine) {
        if (
          camera &&
          camera.videoWidth > 0 &&
          frameActive &&
          windowCorners.length === 4
        ) {
          engine.render({
            video: camera,
            width: clip.clientWidth,
            height: clip.clientHeight,
            videoWidth,
            videoHeight,
            corners: windowCorners,
            now: performance.now(),
          });
        } else {
          engine.clear();
        }
      }

      // ---- motion canvas: frame-history / pixel motions (echo, freeze, …) ----
      const motionEngine = motionEngineRef.current;
      if (motionEngine) {
        if (camera && camera.videoWidth > 0 && frameActive) {
          motionEngine.render({
            video: camera,
            width: clip.clientWidth,
            height: clip.clientHeight,
            videoWidth,
            videoHeight,
            now: performance.now(),
          });
        } else {
          motionEngine.clear();
        }
      }

      // ---- overlay template: face/pose landmarks drawn on camera ----
      const overlay = overlayRendererRef.current;
      if (overlay) {
        overlay.render({
          faceLandmarks: snapshot.faceLandmarks,
          poseLandmarks: snapshot.poseLandmarks,
          width: clip.clientWidth,
          height: clip.clientHeight,
          now: performance.now(),
        });
      }

      // ---- media transform (template mode only; the element may be absent) ----
      const content = contentRef.current;
      if (!content) return;

      // Mirror ∘ face-alignment, composed into one matrix in lib/stage.ts so
      // the math is unit-testable and cannot drift from the spec.
      const stageW = clip.clientWidth;
      if (stageW === 0 || videoWidth <= 0) return;

      const align = faceAlignEnabled && faceAlign ? faceAlign : null;
      const m = mediaMatrix(align, videoWidth, stageW);

      content.style.transformOrigin = "0 0";
      content.style.transform = `matrix(${m.a}, ${m.b}, ${m.c}, ${m.d}, ${m.e}, ${m.f})`;
    });
    return off;
  }, [subscribe, faceAlignEnabled, cameraVideoRef]);

  return (
    <div className="media-layer" aria-hidden="true">
      <div ref={clipRef} className="media-layer__clip">
        {contentMode === "template" && src !== null && (
          <div
            ref={contentRef}
            className="media-layer__content"
            style={{ transform: MIRROR_TRANSFORM }}
          >
            {isVideo ? (
              <video
                ref={mediaRef}
                className="media-layer__media"
                src={src}
                autoPlay
                loop
                muted
                playsInline
              />
            ) : (
              <img className="media-layer__media" src={src} alt="" />
            )}
          </div>
        )}
        {motionCss && (
          <div className={`media-layer__motion ${motionCss}`}>
            {/* Mirrored copy of the live camera: the media the motion
                animates. The window (clip) stays put — only this moves. */}
            <video
              ref={motionVideoRef}
              className="media-layer__media"
              style={{ transform: MIRROR_TRANSFORM }}
              autoPlay
              loop
              muted
              playsInline
            />
          </div>
        )}
        {canvasMotion && <canvas ref={motionCanvasRef} className="media-layer__effect" />}
        {overlayTemplate && <canvas ref={overlayCanvasRef} className="media-layer__effect" />}
        {effectCanvas && <canvas ref={canvasRef} className="media-layer__effect" />}
      </div>
    </div>
  );
}
