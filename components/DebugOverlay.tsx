"use client";

import { useEffect, useState } from "react";
import type { Snapshot } from "@/lib/types";
import { HandTracker } from "./HandTracker";
import { FaceTracker } from "./FaceTracker";
import { RegionTracker } from "./RegionTracker";
import { templateRegionFor } from "@/lib/templateRegions";

export type DebugOverlayProps = {
  subscribe: (listener: (snapshot: Snapshot) => void) => () => void;
  enabled: boolean;
};

/**
 * Optional diagnostics: hand skeleton, face box + landmark sampling, and a
 * readout of every value the pipeline is producing. Default off.
 */
export function DebugOverlay({ subscribe, enabled }: DebugOverlayProps) {
  const [stats, setStats] = useState<Snapshot | null>(null);

  useEffect(() => {
    if (!enabled) {
      setStats(null);
      return;
    }
    // Throttle React state updates: the canvas layers draw every frame, the
    // text panel does not need to.
    let latest: Snapshot | null = null;
    let queued = false;
    const off = subscribe((snapshot) => {
      latest = snapshot;
      if (queued) return;
      queued = true;
      requestAnimationFrame(() => {
        queued = false;
        setStats(latest);
      });
    });
    return off;
  }, [subscribe, enabled]);

  if (!enabled) return null;

  return (
    <>
      <HandTracker subscribe={subscribe} enabled={enabled} />
      <FaceTracker subscribe={subscribe} enabled={enabled} />
      <RegionTracker subscribe={subscribe} enabled={enabled} />
      <div className="debug-panel" role="status">
        <div className="debug-panel__title">DEBUG</div>
        <dl className="debug-list">
          <div>
            <dt>FPS</dt>
            <dd>{stats ? stats.fps.toFixed(0) : "—"}</dd>
          </div>
          <div>
            <dt>Hands</dt>
            <dd>{stats ? stats.hands.length : "—"}</dd>
          </div>
          <div>
            <dt>Video</dt>
            <dd>{stats ? `${stats.videoWidth}x${stats.videoHeight}` : "—"}</dd>
          </div>
          <div>
            <dt>Corners</dt>
            <dd>{stats ? stats.corners.length : "—"}</dd>
          </div>
          <div>
            <dt>Frame</dt>
            <dd>
              {stats && stats.rawFrame
                ? `${Math.round(stats.rawFrame.width)}x${Math.round(
                    stats.rawFrame.height
                  )} @ ${stats.rawFrame.rotation.toFixed(1)}°`
                : "—"}
            </dd>
          </div>
          <div>
            <dt>Face</dt>
            <dd>
              {stats && stats.faceBox
                ? `${Math.round(stats.faceBox.width)}x${Math.round(
                    stats.faceBox.height
                  )}${stats.faceInSelection ? " (in)" : " (out)"}`
                : "—"}
            </dd>
          </div>
          <div>
            <dt>Landmarks</dt>
            <dd>{stats ? stats.faceLandmarks.length : "—"}</dd>
          </div>
          <div>
            <dt>Pose</dt>
            <dd>{stats ? stats.poseLandmarks.length : "—"}</dd>
          </div>
          <div>
            <dt>Region</dt>
            <dd>{stats ? stats.region.label : "—"}</dd>
          </div>
          <div>
            <dt>Confidence</dt>
            <dd>{stats && stats.region.kind ? stats.region.confidence.toFixed(2) : "—"}</dd>
          </div>
          <div>
            <dt>Window</dt>
            <dd>
              {stats && stats.windowCorners.length === 4
                ? `${stats.windowCorners.length} corners`
                : "—"}
            </dd>
          </div>
          <div>
            <dt>Selection</dt>
            <dd>
              {stats && stats.frame
                ? `x${Math.round(stats.frame.cx)} y${Math.round(stats.frame.cy)} ${Math.round(
                    stats.frame.width
                  )}x${Math.round(stats.frame.height)} @ ${stats.frame.rotation.toFixed(1)}°`
                : "—"}
            </dd>
          </div>
          <div>
            <dt>Template</dt>
            <dd>
              {(() => {
                const box = templateRegionFor(stats?.region.kind ?? null);
                return `${box.x},${box.y} ${box.width}x${box.height}`;
              })()}
            </dd>
          </div>
          <div>
            <dt>State</dt>
            <dd>{stats ? stats.reason : "—"}</dd>
          </div>
        </dl>
      </div>
    </>
  );
}
