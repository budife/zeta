"use client";

import { useEffect, useRef, useState, type RefObject } from "react";
import { clipPathPolygon, mediaMatrix, MIRROR_TRANSFORM } from "@/lib/stage";
import { effectClass, motionClass } from "@/lib/effects";
import type { Snapshot } from "@/lib/types";
import type { MenuPick } from "@/lib/modes";

export type MediaLayerProps = {
  subscribe: (listener: (snapshot: Snapshot) => void) => () => void;
  /**
   * The live content mode (spec §22: template, effect and motion are
   * mutually exclusive modes). Decides WHAT renders inside the window:
   *
   *   template → the asset (src) behind the mirror∘align matrix
   *   effect   → the fx overlay only; the camera shows through untouched
   *   motion   → a camera copy inside an animated wrapper (the media moves)
   *   null     → nothing; raw camera through the window
   */
  contentMode: MenuPick["kind"] | null;
  /** Template/upload asset path — only rendered while contentMode is "template". */
  src: string | null;
  /**
   * Apply face→template alignment (lib/faceAlignment). Only valid for the
   * bundled template whose face anchors are configured in templateRegions —
   * uploaded media has unknown landmarks and must stay untransformed.
   */
  faceAlignEnabled?: boolean;
  /** Live effect id — renders the overlay only while contentMode is "effect". */
  effect?: string | null;
  /** Live motion id — animates the camera copy while contentMode is "motion". */
  motion?: string | null;
  /** The live camera element; its stream is mirrored into the motion copy. */
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
 *       └── FxOverlay        (effect mode; sibling AFTER the others, clipped
 *                             with the window so effects only touch what
 *                             shows through it)
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
  faceAlignEnabled = true,
  effect = null,
  motion = null,
  cameraVideoRef = null,
}: MediaLayerProps) {
  const clipRef = useRef<HTMLDivElement | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const mediaRef = useRef<HTMLVideoElement | null>(null);
  const motionVideoRef = useRef<HTMLVideoElement | null>(null);
  const [isVideo, setIsVideo] = useState(false);

  // Render gates: each mode owns exactly one layer (mutual exclusion).
  const fxClass = contentMode === "effect" && effect ? effectClass(effect) : "";
  const motionCss = contentMode === "motion" && motion ? motionClass(motion) : "";

  useEffect(() => {
    setIsVideo(src ? /\.(mp4|webm|ogg|mov)(\?|#|$)/i.test(src) : false);
  }, [src]);

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
        {fxClass && <div className={`media-layer__fx ${fxClass}`} />}
      </div>
    </div>
  );
}
