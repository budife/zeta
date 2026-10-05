"use client";

import { useEffect, useRef } from "react";
import type { Snapshot } from "@/lib/types";
import { MIRROR_PREVIEW } from "@/lib/stage";

export type LipOverlayProps = {
  subscribe: (listener: (snapshot: Snapshot) => void) => () => void;
  enabled: boolean;
};

/**
 * SVG overlay that draws a deformable lip contour on top of the character.
 * The lip path is deformed in real-time based on finger interaction (grab/drag).
 *
 * Positioned in the same coordinate space as the clipping window (stage
 * percentages), the lip follows the face landmarks mapped to the stage.
 */
export function LipOverlay({ subscribe, enabled }: LipOverlayProps) {
  const pathRef = useRef<SVGPathElement | null>(null);

  useEffect(() => {
    if (!enabled) return;
    const off = subscribe((snapshot) => {
      const path = pathRef.current;
      if (!path) return;

      const { lipDeformation, videoWidth, videoHeight } = snapshot;

      if (
        !lipDeformation ||
        !lipDeformation.deformedContour ||
        lipDeformation.deformedContour.length < 3
      ) {
        path.style.opacity = "0";
        return;
      }

      // The deformed contour is in normalized coordinates [0..1] of the video.
      // Map to stage percentage (same as clip-path uses):
      const points = lipDeformation.deformedContour
        .map((p) => {
          const x = ((MIRROR_PREVIEW ? 1 - p.x : p.x) * 100).toFixed(3);
          const y = (p.y * 100).toFixed(3);
          return `${x},${y}`;
        })
        .join(" ");

      path.setAttribute("d", `M${points}Z`);
      path.style.opacity = "1";
    });
    return off;
  }, [subscribe, enabled]);

  if (!enabled) return null;

  return (
    <svg
      className="lip-overlay"
      viewBox="0 0 100 100"
      preserveAspectRatio="none"
      aria-hidden="true"
    >
      <path
        ref={pathRef}
        className="lip-overlay__path"
        d=""
      />
    </svg>
  );
}