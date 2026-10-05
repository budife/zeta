"use client";

import { useEffect, useRef, useState } from "react";
import { clipPathPolygon } from "@/lib/stage";
import { regionTransformStyle } from "@/lib/regionMapping";
import type { Snapshot } from "@/lib/types";

export type MediaLayerProps = {
  subscribe: (listener: (snapshot: Snapshot) => void) => () => void;
  /** Media URL: any image (SVG/PNG/JPG/WEBP/GIF) or video (MP4/WebM) the browser can play. */
  src: string;
};

/**
 * Two nested responsibilities, deliberately split across two DOM layers:
 *
 *   MediaLayer            (root, opacity only)
 *   └── ClipWindow        (clip-path only — the hand-made window)
 *       └── TransformedMedia  (transform only — zoom / pan / rotation of content)
 *           └── <img> / <video>   (object-fit: cover)
 *
 * The clip and the transform must never share an element: a CSS transform is
 * applied to the element *including its clip*, so transforming a clipped layer
 * would move the window itself. Keeping them on separate elements means the
 * zoom cannot change the window's position or size.
 *
 * Opacity follows `snapshot.frameActive` (the selection state machine) — never
 * `windowCorners.length` — so a one-frame detection dropout does not blink.
 *
 * All values are written straight to the DOM from the snapshot, so React never
 * re-renders at frame rate.
 */
export function MediaLayer({ subscribe, src }: MediaLayerProps) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const clipRef = useRef<HTMLDivElement | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const mediaRef = useRef<HTMLVideoElement | null>(null);
  const [isVideo, setIsVideo] = useState(false);

  // Videos need to be told to play; <img> and <svg> do not.
  useEffect(() => {
    setIsVideo(/\.(mp4|webm|ogg|mov)(\?|#|$)/i.test(src));
  }, [src]);

  useEffect(() => {
    if (!isVideo) return;
    const video = mediaRef.current;
    if (!video) return;
    video.play().catch((error) => {
      // Autoplay can be blocked until a user gesture; the video stays paused
      // on its first frame, which is still a valid poster.
      console.warn("[MediaLayer] video autoplay blocked", error);
    });
  }, [isVideo, src]);

  useEffect(() => {
    const off = subscribe((snapshot) => {
      const root = rootRef.current;
      const clip = clipRef.current;
      const content = contentRef.current;
      if (!root || !clip || !content) return;

      const { windowCorners, videoWidth, videoHeight, regionTransform, frameActive } =
        snapshot;

      // Visibility is controlled by clip-path: when the frame is inactive we
      // shrink the clip to a zero-area shape so the media is invisible but the
      // element stays mounted. The camera behind is always visible.
      if (windowCorners.length === 4 && frameActive) {
        clip.style.clipPath = `polygon(${clipPathPolygon(
          windowCorners,
          videoWidth,
          videoHeight
        )})`;
      } else {
        clip.style.clipPath = "inset(50%)";
      }

      // Content: transform only. No region → content stays full-screen
      // (plain clipping), which is the correct fallback.
      if (regionTransform) {
        content.style.transformOrigin = `${(regionTransform.originX * 100).toFixed(
          2
        )}% ${(regionTransform.originY * 100).toFixed(2)}%`;
        content.style.transform = regionTransformStyle(regionTransform);
      } else {
        content.style.transformOrigin = "50% 50%";
        content.style.transform = "none";
      }
    });
    return off;
  }, [subscribe]);

  return (
    <div ref={rootRef} className="media-layer" aria-hidden="true">
      <div ref={clipRef} className="media-layer__clip">
        <div ref={contentRef} className="media-layer__content">
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