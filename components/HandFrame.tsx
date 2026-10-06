"use client";

import { useEffect, useRef } from "react";
import { placeFrame, toStageFraction } from "@/lib/stage";
import type { Snapshot } from "@/lib/types";

export type HandFrameProps = {
  subscribe: (listener: (snapshot: Snapshot) => void) => () => void;
  active: boolean;
  /**
   * Debug only: the fitted candidate rectangle and the blue outline polygon.
   * In production the UI shows nothing but the four yellow fingertip dots.
   */
  debug?: boolean;
};

/**
 * Draws the hand-made selection.
 *
 * Production (debug off): exactly four yellow dots, one per fingertip corner
 * (thumb + index of each hand). The dots follow `windowCorners` — the SAME
 * smoothed corners the clip-path uses — in both states, so they sit on the
 * visible edge of the window once active and are already smoothed while the
 * window is still forming (never raw → rendered).
 *
 * Debug: additionally the fitted candidate rectangle (dashed) and the outline
 * of the clipped quadrilateral. No dashed blue line is ever rendered in
 * production.
 */
export function HandFrame({ subscribe, active, debug = false }: HandFrameProps) {
  const candidateRef = useRef<HTMLDivElement | null>(null);
  const outlineRef = useRef<SVGPolygonElement | null>(null);
  const cornerRefs = useRef<Array<HTMLDivElement | null>>([]);

  useEffect(() => {
    const off = subscribe((snapshot) => {
      const { rawFrame, windowCorners, videoWidth, videoHeight } = snapshot;

      // Debug-only candidate: fitted rectangle preview while forming.
      if (candidateRef.current) {
        if (debug && rawFrame && !active) {
          Object.assign(
            candidateRef.current.style,
            placeFrame(rawFrame, videoWidth, videoHeight)
          );
          candidateRef.current.style.opacity = "1";
        } else {
          candidateRef.current.style.opacity = "0";
        }
      }

      // Debug-only outline: stroke the exact polygon the media is clipped to.
      if (outlineRef.current) {
        if (debug && active && windowCorners.length === 4) {
          outlineRef.current.setAttribute(
            "points",
            windowCorners
              .map((p) => {
                const f = toStageFraction(p, videoWidth, videoHeight);
                return `${(f.x * 100).toFixed(3)},${(f.y * 100).toFixed(3)}`;
              })
              .join(" ")
          );
          outlineRef.current.style.opacity = "1";
        } else {
          outlineRef.current.style.opacity = "0";
        }
      }

      // Four fingertip dots — always rendered, never dashed, never blue.
      // One source: the smoothed corners the clip uses, in both states.
      const dotPoints = windowCorners;
      cornerRefs.current.forEach((el, i) => {
        if (!el) return;
        const corner = dotPoints[i];
        if (!corner) {
          el.style.opacity = "0";
          return;
        }
        const p = toStageFraction(corner, videoWidth, videoHeight);
        el.style.opacity = "1";
        el.style.left = `${p.x * 100}%`;
        el.style.top = `${p.y * 100}%`;
      });
    });
    return off;
  }, [subscribe, active, debug]);

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
