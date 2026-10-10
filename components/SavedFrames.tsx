"use client";

import { useEffect, useRef } from "react";
import { toStageFraction } from "@/lib/stage";
import type { Snapshot } from "@/lib/types";

export type SavedFramesProps = {
  subscribe: (listener: (snapshot: Snapshot) => void) => () => void;
};

/**
 * Renders the outlines of every saved frame (PART E). Unlike HandFrame this
 * is NOT debug-gated: saved frames are user-facing, so they stay visible
 * regardless of debug mode.
 *
 * Each saved frame is a static SVG polygon at its saved position — it never
 * moves when the live frame updates, because the corners come from the
 * immutable snapshots the engine published.
 */
export function SavedFrames({ subscribe }: SavedFramesProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const off = subscribe((snapshot) => {
      const container = containerRef.current;
      if (!container) return;
      const { savedCorners, videoWidth, videoHeight } = snapshot;

      // Rebuild the SVG children only when the count changes (a save or a
      // clear). Position updates reuse the existing elements.
      const existing = container.querySelectorAll("polygon");
      if (existing.length !== savedCorners.length) {
        container.innerHTML = "";
        for (let i = 0; i < savedCorners.length; i++) {
          const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
          svg.setAttribute("viewBox", "0 0 100 100");
          svg.setAttribute("preserveAspectRatio", "none");
          svg.classList.add("saved-frame");
          const polygon = document.createElementNS("http://www.w3.org/2000/svg", "polygon");
          polygon.classList.add("saved-frame__polygon");
          svg.appendChild(polygon);
          container.appendChild(svg);
        }
      }

      // Update positions.
      const svgs = container.querySelectorAll("svg");
      for (let i = 0; i < savedCorners.length && i < svgs.length; i++) {
        const polygon = svgs[i].querySelector("polygon");
        if (!polygon) continue;
        const points = savedCorners[i]
          .map((p) => {
            const f = toStageFraction(p, videoWidth, videoHeight);
            return `${(f.x * 100).toFixed(3)},${(f.y * 100).toFixed(3)}`;
          })
          .join(" ");
        polygon.setAttribute("points", points);
      }
    });
    return off;
  }, [subscribe]);

  return (
    <div ref={containerRef} className="saved-frames-layer" aria-hidden="true" />
  );
}
