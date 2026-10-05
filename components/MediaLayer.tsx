"use client";

import { useEffect, useRef, useState } from "react";
import { clipPathPolygon } from "@/lib/stage";
import type { Snapshot } from "@/lib/types";

export type MediaLayerProps = {
  subscribe: (listener: (snapshot: Snapshot) => void) => () => void;
  /** Media URL: any image (SVG/PNG/JPG/WEBP/GIF) or video (MP4/WebM) the browser can play. */
  src: string;
};

/**
 * Two nested responsibilities, split across two DOM layers:
 *
 *   MediaLayer            (root, opacity 1, no background)
 *   └── ClipWindow        (clip-path only — the hand-made window)
 *       └── MediaContent   (full-frame, untransformed — object-fit: cover)
 *           └── <img> / <video>
 *
 * The clip and the transform must never share an element (CSS transform
 * applies to the element *including* its clip). For now the content has no
 * transform at all — the media stays full-frame behind the window. Region
 * mapping (zoom/pan) is disabled.
 *
 * Visibility is controlled by clip-path: `inset(50%)` (zero-area) when
 * inactive, the hand-made polygon when active. No opacity toggling — the
 * camera is always visible through transparent areas.
 */
export function MediaLayer({ subscribe, src }: MediaLayerProps) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const clipRef = useRef<HTMLDivElement | null>(null);
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
      // Autoplay can be blocked until a user gesture; the video stays paused
      // on its first frame, which is still a valid poster.
      console.warn("[MediaLayer] video autoplay blocked", error);
    });
  }, [isVideo, src]);

  useEffect(() => {
    const off = subscribe((snapshot) => {
      const root = rootRef.current;
      const clip = clipRef.current;
      if (!root || !clip) return;

      const { windowCorners, videoWidth, videoHeight, frameActive } =
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
    });
    return off;
  }, [subscribe]);

  return (
    <div ref={rootRef} className="media-layer" aria-hidden="true">
      <div ref={clipRef} className="media-layer__clip">
        <div className="media-layer__content">
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