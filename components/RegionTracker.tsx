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

      const resolved =
        kind === null ? null : resolveRegion(kind, poseLandmarks, faceLandmarks);
      const box = resolved?.box ?? null;

      // `resolveRegion` works in normalized [0..1]; placeBox takes video
      // pixels. Convert explicitly — passing the NormBox straight through
      // collapsed the box to the top-left corner at zero size.
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
      // Only the landmarks that actually drove this classification — the full
      // 33-point skeleton is PoseTracker's job, and drawing both would make it
      // impossible to tell which points won.
      const points = resolved?.points ?? [];
      if (points.length === 0) return;

      ctx.fillStyle = "rgba(52, 211, 153, 0.95)";
      for (const lm of points) {
        const p = toStagePixels(
          normalizedToVideo(lm, videoWidth, videoHeight),
          videoWidth,
          videoHeight,
          width,
          height
        );
        ctx.beginPath();
        ctx.arc(p.x, p.y, 3.4, 0, Math.PI * 2);
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

/**
 * Resolved region: its bounds plus the exact landmarks that produced them.
 *
 * Region bounds come from pose landmarks for body parts and from the face mesh
 * for eyes/face. Both are returned in normalized [0..1] coordinates, matching
 * what `regionBox` works in.
 */
function resolveRegion(
  kind: RegionKind,
  poseLandmarks: Snapshot["poseLandmarks"],
  faceLandmarks: Snapshot["faceLandmarks"]
) {
  const poseDef = POSE_REGIONS.find((r) => r.kind === kind);
  if (poseDef && poseLandmarks.length > 0) {
    const box = regionBox(poseLandmarks, poseDef.indices);
    if (box) return { box, points: pick(poseLandmarks, poseDef.indices) };
  }
  const faceDef = FACE_REGIONS.find((r) => r.kind === kind);
  if (faceDef && faceLandmarks.length > 0) {
    const box = regionBox(faceLandmarks, faceDef.indices);
    if (box) return { box, points: pick(faceLandmarks, faceDef.indices) };
  }
  return { box: null, points: [] };
}

function pick(landmarks: Snapshot["poseLandmarks"], indices: number[]) {
  const out = [];
  for (const i of indices) {
    const lm = landmarks[i];
    if (lm) out.push(lm);
  }
  return out;
}
