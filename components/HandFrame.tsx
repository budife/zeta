"use client";

import { useEffect, useRef } from "react";
import { placeFrame, toStageFraction } from "@/lib/stage";
import type { Snapshot } from "@/lib/types";

export type HandFrameProps = {
  subscribe: (listener: (snapshot: Snapshot) => void) => () => void;
  active: boolean;
  /**
   * Debug only. This whole component is a diagnostic layer: when it is off,
   * nothing renders at all and no subscription runs. The hand-made window
   * itself is drawn by `MediaLayer`'s clip-path, which does not depend on this
   * component — so hiding the markers never touches tracking.
   */
  debug?: boolean;
};

/**
 * Debug overlay for the hand-made selection: the four yellow fingertip dots,
 * the fitted candidate rectangle, and the outline of the clipped quadrilateral.
 *
 * Every visual here is debug-only. With debug off the component renders
 * nothing and subscribes to nothing — not merely opacity-hidden, so no debug
 * element can ever participate in layout or hit-testing in production. The
 * window itself keeps working: `MediaLayer` clips to the same `windowCorners`
 * independently.
 *
 * The dots follow `windowCorners` — the SAME corners the clip-path uses — in
 * both states, so they sit on the visible edge of the window once active and
 * are already smoothed while the window is still forming (never raw →
 * rendered).
 */
export function HandFrame({ subscribe, active, debug = false }: HandFrameProps) {
  const candidateRef = useRef<HTMLDivElement | null>(null);
  const outlineRef = useRef<SVGPolygonElement | null>(null);
  const cornerRefs = useRef<Array<HTMLDivElement | null>>([]);

  useEffect(() => {
    if (!debug) return;
    const off = subscribe((snapshot) => {
      const { rawFrame, windowCorners, videoWidth, videoHeight } = snapshot;

      // Candidate: fitted rectangle preview while forming.
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

      // Outline: stroke the exact polygon the media is clipped to.
      if (outlineRef.current) {
        if (active && windowCorners.length === 4) {
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

      // Four fingertip dots — never dashed, never blue. One source: the
      // smoothed corners the clip uses, in both states.
      cornerRefs.current.forEach((el, i) => {
        if (!el) return;
        const corner = windowCorners[i];
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

  if (!debug) return null;

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
