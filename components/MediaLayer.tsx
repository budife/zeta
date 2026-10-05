"use client";

import { useEffect, useRef, useState } from "react";
import { clipPathPolygon } from "@/lib/stage";
import type { Snapshot } from "@/lib/types";

export type MediaLayerProps = {
  subscribe: (listener: (snapshot: Snapshot) => void) => () => void;
  src: string;
};

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