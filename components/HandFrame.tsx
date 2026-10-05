"use client";

import { useEffect, useRef } from "react";
import { MIRROR_PREVIEW, placeFrame, toStagePixels } from "@/lib/stage";
import type { Snapshot } from "@/lib/types";

export type HandFrameProps = {
  subscribe: (listener: (snapshot: Snapshot) => void) => () => void;
  active: boolean;
};

/**
 * Draws the hand-made selection. While the hands are still forming the frame,
 * a dashed "candidate" rectangle previews the fit. Once the frame validates,
 * the outline follows the ACTUAL quadrilateral the hands form (straight edges
 * between the four fingertips) rather than a fitted rectangle — the outline is
 * the visible edge of the clipping window, so it must match it exactly.
 */
export function HandFrame({ subscribe, active }: HandFrameProps) {
  const candidateRef = useRef<HTMLDivElement | null>(null);
  const outlineRef = useRef<SVGPolygonElement | null>(null);
  const cornerRefs = useRef<Array<HTMLDivElement | null>>([]);

  useEffect(() => {
    const off = subscribe((snapshot) => {
      const { rawFrame, windowCorners, videoWidth, videoHeight, corners } = snapshot;

      // Candidate: still the fitted rectangle, a rough preview while forming.
      if (candidateRef.current) {
        if (rawFrame && !active) {
          Object.assign(
            candidateRef.current.style,
            placeFrame(rawFrame, videoWidth, videoHeight)
          );
          candidateRef.current.style.opacity = "1";
        } else {
          candidateRef.current.style.opacity = "0";
        }
      }

      // Active window: stroke the exact polygon the media is clipped to.
      if (outlineRef.current) {
        if (active && windowCorners.length === 4) {
          outlineRef.current.setAttribute(
            "points",
            windowCorners
              .map((p) => {
                const x = (MIRROR_PREVIEW ? 1 - p.x / videoWidth : p.x / videoWidth) * 100;
                const y = (p.y / videoHeight) * 100;
                return `${x.toFixed(3)},${y.toFixed(3)}`;
              })
              .join(" ")
          );
          outlineRef.current.style.opacity = "1";
        } else {
          outlineRef.current.style.opacity = "0";
        }
      }

      cornerRefs.current.forEach((el, i) => {
        if (!el) return;
        const corner = corners[i];
        if (!corner) {
          el.style.opacity = "0";
          return;
        }
        const p = toStagePixels(corner, videoWidth, videoHeight, 1, 1);
        el.style.opacity = "1";
        el.style.left = `${p.x * 100}%`;
        el.style.top = `${p.y * 100}%`;
      });
    });
    return off;
  }, [subscribe, active]);

  return (
    <div className="hand-frame-layer" aria-hidden="true">
      <div ref={candidateRef} className="frame-rect frame-rect--candidate" />
      <svg className="frame-outline" viewBox="0 0 100 100" preserveAspectRatio="none">
        <polygon
          ref={outlineRef}
          className="frame-outline__polygon"
          points=""
        />
      </svg>
      {[0, 1, 2, 3].map((i) => (
        <div
          key={i}
          ref={(el) => {
            cornerRefs.current[i] = el;
          }}
          className="frame-corner"
        />
      ))}
    </div>
  );
}
