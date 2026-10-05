"use client";

import { useEffect, useRef } from "react";
import { HAND_CONNECTIONS } from "@/lib/engine";
import { toStagePixels } from "@/lib/stage";
import type { Snapshot } from "@/lib/types";

export type HandTrackerProps = {
  subscribe: (listener: (snapshot: Snapshot) => void) => () => void;
  enabled: boolean;
};

/**
 * Debug layer: draws the MediaPipe hand skeleton (21 landmarks per hand).
 * Purely diagnostic — hidden unless debug mode is on.
 */
export function HandTracker({ subscribe, enabled }: HandTrackerProps) {
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
      const { hands, videoWidth, videoHeight } = snapshot;
      if (hands.length === 0) return;

      for (const hand of hands) {
        const pts = hand.map((p) =>
          toStagePixels(p, videoWidth, videoHeight, width, height)
        );

        ctx.lineWidth = 2;
        ctx.strokeStyle = "rgba(125, 211, 252, 0.85)";
        ctx.beginPath();
        for (const [a, b] of HAND_CONNECTIONS) {
          ctx.moveTo(pts[a].x, pts[a].y);
          ctx.lineTo(pts[b].x, pts[b].y);
        }
        ctx.stroke();

        for (let i = 0; i < pts.length; i++) {
          const isTip = i === 4 || i === 8 || i === 12 || i === 16 || i === 20;
          ctx.beginPath();
          ctx.arc(pts[i].x, pts[i].y, isTip ? 5 : 2.6, 0, Math.PI * 2);
          ctx.fillStyle = isTip ? "#fbbf24" : "#e2e8f0";
          ctx.fill();
        }
      }
    });
    return off;
  }, [subscribe, enabled]);

  if (!enabled) return null;
  return <canvas ref={canvasRef} className="debug-canvas" aria-hidden="true" />;
}
