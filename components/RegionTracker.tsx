"use client";

import { useEffect, useRef } from "react";
import { normBoxToVideo, normalizedToVideo, placeBox, toStagePixels } from "@/lib/stage";
import { FACE_REGIONS, POSE_REGIONS, regionBox, type RegionKind } from "@/lib/regions";
import type { Snapshot } from "@/lib/types";

export type RegionTrackerProps = {
  subscribe: (listener: (snapshot: Snapshot) => void) => () => void;
  enabled: boolean;
};

/** Colored highlight of the classified region: pose points + region box. */
export function RegionTracker({ subscribe, enabled }: RegionTrackerProps) {
  const boxRef = useRef<HTMLDivElement | null>(null);
  const labelRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    if (!enabled) return;
    const off = subscribe((snapshot) => {
      const { region, poseLandmarks, faceLandmarks, videoWidth, videoHeight } = snapshot;
      const kind: RegionKind | null = region.kind;

      // `resolveRegionBox` works in normalized [0..1]; placeBox takes video
      // pixels. Convert explicitly — passing the NormBox straight through
      // collapsed the box to the top-left corner at zero size.
      const box =
        kind === null
          ? null
          : resolveRegionBox(kind, poseLandmarks, faceLandmarks);
      const videoBox = box ? normBoxToVideo(box, videoWidth, videoHeight) : null;

      if (boxRef.current) {
        if (videoBox) {
          Object.assign(boxRef.current.style, placeBox(videoBox, videoWidth, videoHeight));
          boxRef.current.style.opacity = "1";
        } else {
          boxRef.current.style.opacity = "0";
        }
      }
      if (labelRef.current) {
        if (videoBox && kind) {
          Object.assign(labelRef.current.style, placeBox(videoBox, videoWidth, videoHeight));
          labelRef.current.textContent = `${region.label} ${(region.confidence * 100).toFixed(0)}%`;
          labelRef.current.style.opacity = "1";
        } else {
          labelRef.current.style.opacity = "0";
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
      if (poseLandmarks.length === 0) return;

      // Pose skeleton points for the active region so the operator can see
      // exactly which landmarks drove the classification.
      ctx.fillStyle = "rgba(52, 211, 153, 0.9)";
      for (const lm of poseLandmarks) {
        const p = toStagePixels(
          normalizedToVideo(lm, videoWidth, videoHeight),
          videoWidth,
          videoHeight,
          width,
          height
        );
        ctx.beginPath();
        ctx.arc(p.x, p.y, 2.2, 0, Math.PI * 2);
        ctx.fill();
      }
    });
    return off;
  }, [subscribe, enabled]);

  if (!enabled) return null;
  return (
    <div className="region-tracker-layer" aria-hidden="true">
      <div ref={boxRef} className="region-box" />
      <div ref={labelRef} className="region-label" />
      <canvas ref={canvasRef} className="debug-canvas" />
    </div>
  );
}

/** Region bounds come from pose landmarks for body parts, face mesh for eyes/face. */
function resolveRegionBox(
  kind: RegionKind,
  poseLandmarks: Snapshot["poseLandmarks"],
  faceLandmarks: Snapshot["faceLandmarks"]
) {
  const poseDef = POSE_REGIONS.find((r) => r.kind === kind);
  if (poseDef && poseLandmarks.length > 0) {
    const box = regionBox(poseLandmarks, poseDef.indices);
    if (box) return box;
  }
  const faceDef = FACE_REGIONS.find((r) => r.kind === kind);
  if (faceDef && faceLandmarks.length > 0) {
    return regionBox(faceLandmarks, faceDef.indices);
  }
  return null;
}
