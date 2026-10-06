"use client";

import { useEffect, useRef } from "react";
import { POSE_CONNECTIONS } from "@/lib/regions";
import { normalizedToVideo, toStagePixels } from "@/lib/stage";
import type { Snapshot } from "@/lib/types";

export type PoseTrackerProps = {
  subscribe: (listener: (snapshot: Snapshot) => void) => () => void;
  enabled: boolean;
};

/** Joint indices worth drawing larger so the body reads at a glance. */
const MAJOR_JOINTS = new Set([
  0, // nose
  11, 12, // shoulders
  23, 24, // hips
  25, 26, // knees
  27, 28, // ankles
]);

/**
 * Debug layer: the full 33-point MediaPipe pose skeleton.
 *
 * Purely diagnostic — nothing renders unless debug mode is on. Pose runs every
 * frame regardless of the selection, so this skeleton is live from the first
 * camera frame, before any window is formed.
 *
 * Landmarks arrive normalized; they go through the same mapping chain as
 * everything else (normalized → video px → stage px), so the skeleton lands on
 * the same pixels the hand frame and the clip do.
 */
export function PoseTracker({ subscribe, enabled }: PoseTrackerProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    if (!enabled) return;
    const off = subscribe((snapshot) => {
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
      const { poseLandmarks, videoWidth, videoHeight } = snapshot;
      if (poseLandmarks.length === 0) return;

      const pts = poseLandmarks.map((lm) =>
        toStagePixels(
          normalizedToVideo(lm, videoWidth, videoHeight),
          videoWidth,
          videoHeight,
          width,
          height
        )
      );

      ctx.lineWidth = 2;
      ctx.strokeStyle = "rgba(167, 139, 250, 0.9)";
      ctx.beginPath();
      for (const [a, b] of POSE_CONNECTIONS) {
        if (!pts[a] || !pts[b]) continue;
        ctx.moveTo(pts[a].x, pts[a].y);
        ctx.lineTo(pts[b].x, pts[b].y);
      }
      ctx.stroke();

      for (let i = 0; i < pts.length; i++) {
        const major = MAJOR_JOINTS.has(i);
        ctx.beginPath();
        ctx.arc(pts[i].x, pts[i].y, major ? 4.5 : 2.6, 0, Math.PI * 2);
        ctx.fillStyle = major ? "#fbbf24" : "#c4b5fd";
        ctx.fill();
      }
    });
    return off;
  }, [subscribe, enabled]);

  if (!enabled) return null;
  return <canvas ref={canvasRef} className="debug-canvas" aria-hidden="true" />;
}
