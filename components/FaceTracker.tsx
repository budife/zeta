"use client";

import { useEffect, useRef } from "react";
import { normalizedToVideo, placeBox, toStagePixels } from "@/lib/stage";
import type { Snapshot } from "@/lib/types";

export type FaceTrackerProps = {
  subscribe: (listener: (snapshot: Snapshot) => void) => () => void;
  enabled: boolean;
};

/**
 * Debug layer: draws the face bounding box plus a sparse set of the 478 face
 * landmarks so it is easy to see what the detector locked onto.
 */
export function FaceTracker({ subscribe, enabled }: FaceTrackerProps) {
  const boxRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    if (!enabled) return;
    const off = subscribe((snapshot) => {
      const { faceBox, faceLandmarks, videoWidth, videoHeight } = snapshot;

      if (boxRef.current) {
        if (faceBox) {
          Object.assign(boxRef.current.style, placeBox(faceBox, videoWidth, videoHeight));
          boxRef.current.style.opacity = "1";
        } else {
          boxRef.current.style.opacity = "0";
        }
      }

      const canvas = canvasRef.current;
      if (!canvas) return;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;

      const { width, height } = canvas.getBoundingClientRect();
      if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width;
        canvas.height = height;
      }
      ctx.clearRect(0, 0, width, height);
      if (faceLandmarks.length === 0) return;

      // Sparse sampling of the 478-point mesh: enough to read the face shape
      // without painting the whole tessellation every frame.
      const step = 6;
      ctx.fillStyle = "rgba(244, 114, 182, 0.9)";
      for (let i = 0; i < faceLandmarks.length; i += step) {
        const lm = faceLandmarks[i];
        const p = toStagePixels(
          normalizedToVideo(lm, videoWidth, videoHeight),
          videoWidth,
          videoHeight,
          width,
          height
        );
        ctx.beginPath();
        ctx.arc(p.x, p.y, 1.8, 0, Math.PI * 2);
        ctx.fill();
      }
    });
    return off;
  }, [subscribe, enabled]);

  if (!enabled) return null;
  return (
    <div className="face-tracker-layer" aria-hidden="true">
      <div ref={boxRef} className="face-box" />
      <canvas ref={canvasRef} className="debug-canvas" />
    </div>
  );
}
