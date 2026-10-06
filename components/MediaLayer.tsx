"use client";

import { useEffect, useRef, useState } from "react";
import { clipPathPolygon, mediaMatrix, MIRROR_TRANSFORM } from "@/lib/stage";
import type { Snapshot } from "@/lib/types";

export type MediaLayerProps = {
  subscribe: (listener: (snapshot: Snapshot) => void) => () => void;
  src: string;
  /**
   * Apply face→template alignment (lib/faceAlignment). Only valid for the
   * bundled template whose face anchors are configured in templateRegions —
   * uploaded media has unknown landmarks and must stay untransformed.
   */
  faceAlignEnabled?: boolean;
};

/**
 * Layer stack — clip and transform are deliberately on DIFFERENT elements
 * (transforming the clipped element would drag the window along):
 *
 *   MediaLayer               (root, opacity 1, no background)
 *   └── ClipWindow           (clip-path only — the hand-made window)
 *       └── MediaContent     (transform only — mirror + face alignment)
 *           └── <img>/<video>
 *
 * Visibility is controlled by clip-path: `inset(50%)` (zero-area) when
 * inactive, the hand-made polygon when active. No opacity toggling — the
 * camera is always visible through transparent areas.
 *
 * Face alignment is a similarity transform (scale + rotate + translate) solved
 * in video-pixel space by lib/faceAlignment.ts, converted to a CSS matrix
 * here. The mirror is composed into the same matrix so the two never fight.
 */
export function MediaLayer({ subscribe, src, faceAlignEnabled = true }: MediaLayerProps) {
  const clipRef = useRef<HTMLDivElement | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const mediaRef = useRef<HTMLVideoElement | null>(null);
  const [isVideo, setIsVideo] = useState(false);
  useEffect(() => {
    setIsVideo(/\.(mp4|webm|ogg|mov)(\?|#|$)/i.test(src));
  }, [src]);

  useEffect(() => {
    if (!isVideo) return;
    const video = mediaRef.current;
    if (!video) return;
    video.play().catch((error) => {
      console.warn("[MediaLayer] video autoplay blocked", error);
    });
  }, [isVideo, src]);

  useEffect(() => {
    const off = subscribe((snapshot) => {
      const clip = clipRef.current;
      const content = contentRef.current;
      if (!clip || !content) return;

      const { windowCorners, videoWidth, videoHeight, frameActive, faceAlign } =
        snapshot;

      // ---- clip window (this element is never transformed) ----
      if (windowCorners.length === 4 && frameActive) {
        clip.style.clipPath = `polygon(${clipPathPolygon(
          windowCorners,
          videoWidth,
          videoHeight
        )})`;
      } else {
        clip.style.clipPath = "inset(50%)";
      }

      // ---- media transform (this element is never clipped) ----
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
  }, [subscribe, faceAlignEnabled]);

  return (
    <div className="media-layer" aria-hidden="true">
      <div ref={clipRef} className="media-layer__clip">
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
      </div>
    </div>
  );
}
