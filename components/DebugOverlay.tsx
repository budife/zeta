"use client";

import { useEffect, useRef, useState } from "react";
import type { NormalizedLandmark, Snapshot } from "@/lib/types";
import { normalizedToVideo, toStagePixels } from "@/lib/stage";
import { HAND_LANDMARK } from "@/lib/geometry";
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
 *
 * The coordinate rows print BOTH ends of the mapping chain for the fingertip
 * anchors — the raw MediaPipe value and the stage pixel it renders at — so the
 * mapping can be verified by eye before any selection logic is touched.
 */
export function DebugOverlay({ subscribe, enabled }: DebugOverlayProps) {
  const panelRef = useRef<HTMLDivElement | null>(null);
  const [stats, setStats] = useState<Snapshot | null>(null);
  const [stageSize, setStageSize] = useState<{ w: number; h: number } | null>(null);

  useEffect(() => {
    if (!enabled) {
      setStats(null);
      setStageSize(null);
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
        // The panel is absolutely positioned inside .stage, so offsetParent
        // IS the stage: real, measured bounds rather than an assumption.
        const stageEl = panelRef.current?.offsetParent;
        if (stageEl instanceof HTMLElement) {
          const r = stageEl.getBoundingClientRect();
          setStageSize((prev) =>
            prev && prev.w === r.width && prev.h === r.height
              ? prev
              : { w: Math.round(r.width), h: Math.round(r.height) }
          );
        }
      });
    });
    return off;
  }, [subscribe, enabled]);

  if (!enabled) return null;

  const videoW = stats?.videoWidth ?? 0;
  const videoH = stats?.videoHeight ?? 0;
  const videoAspect = videoH > 0 ? videoW / videoH : 0;
  const stageAspect = stageSize && stageSize.h > 0 ? stageSize.w / stageSize.h : 0;
  const aspectOk =
    videoAspect > 0 &&
    stageAspect > 0 &&
    Math.abs(videoAspect - stageAspect) < 0.01;

  return (
    <>
      <HandTracker subscribe={subscribe} enabled={enabled} />
      <FaceTracker subscribe={subscribe} enabled={enabled} />
      <RegionTracker subscribe={subscribe} enabled={enabled} />
      <div ref={panelRef} className="debug-panel" role="status">
        <div className="debug-panel__title">DEBUG</div>
        <dl className="debug-list">
          <div>
            <dt>FPS</dt>
            <dd>{stats ? stats.fps.toFixed(0) : "—"}</dd>
          </div>
          <div>
            <dt>Video</dt>
            <dd>{stats ? `${videoW}×${videoH} (${videoAspect.toFixed(3)})` : "—"}</dd>
          </div>
          <div>
            <dt>Stage</dt>
            <dd>
              {stageSize
                ? `${stageSize.w}×${stageSize.h} (${stageAspect.toFixed(3)})`
                : "—"}
            </dd>
          </div>
          <div>
            <dt>Mapping</dt>
            <dd>
              {videoAspect === 0 || stageAspect === 0
                ? "—"
                : aspectOk
                  ? "cover OK"
                  : "ASPECT MISMATCH"}
            </dd>
          </div>
          {(["H0", "H1"] as const).map((label, handIndex) => (
            <CoordRow
              key={label}
              label={label}
              landmarks={stats?.handLandmarksNorm[handIndex]}
              videoWidth={videoW}
              videoHeight={videoH}
              stageWidth={stageSize?.w ?? 0}
              stageHeight={stageSize?.h ?? 0}
            />
          ))}
          <div>
            <dt>Hands</dt>
            <dd>{stats ? stats.hands.length : "—"}</dd>
          </div>
          <div>
            <dt>Corners</dt>
            <dd>{stats ? stats.corners.length : "—"}</dd>
          </div>
          <div>
            <dt>Frame</dt>
            <dd>
              {stats && stats.rawFrame
                ? `${Math.round(stats.rawFrame.width)}×${Math.round(
                    stats.rawFrame.height
                  )} @ ${stats.rawFrame.rotation.toFixed(1)}°`
                : "—"}
            </dd>
          </div>
          <div>
            <dt>Face</dt>
            <dd>
              {stats && stats.faceBox
                ? `${Math.round(stats.faceBox.width)}×${Math.round(
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
                  )}×${Math.round(stats.frame.height)} @ ${stats.frame.rotation.toFixed(1)}°`
                : "—"}
            </dd>
          </div>
          <div>
            <dt>Template</dt>
            <dd>
              {(() => {
                const box = templateRegionFor(stats?.region.kind ?? null);
                return `${box.x},${box.y} ${box.width}×${box.height}`;
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

/**
 * One row per hand: the raw normalized coordinates of the two frame anchors
 * (thumb tip, index tip) and the stage pixels they are drawn at.
 */
function CoordRow({
  label,
  landmarks,
  videoWidth,
  videoHeight,
  stageWidth,
  stageHeight,
}: {
  label: string;
  landmarks: NormalizedLandmark[] | undefined;
  videoWidth: number;
  videoHeight: number;
  stageWidth: number;
  stageHeight: number;
}) {
  const anchor = (index: number): string => {
    const lm = landmarks?.[index];
    if (!lm || stageWidth === 0 || stageHeight === 0 || videoWidth === 0) return "—";
    const stage = toStagePixels(
      normalizedToVideo(lm, videoWidth, videoHeight),
      videoWidth,
      videoHeight,
      stageWidth,
      stageHeight
    );
    return `${lm.x.toFixed(2)},${lm.y.toFixed(2)} → ${Math.round(stage.x)},${Math.round(
      stage.y
    )}`;
  };

  return (
    <>
      <div>
        <dt>{`${label} thumb`}</dt>
        <dd>{anchor(HAND_LANDMARK.thumbTip)}</dd>
      </div>
      <div>
        <dt>{`${label} index`}</dt>
        <dd>{anchor(HAND_LANDMARK.indexTip)}</dd>
      </div>
    </>
  );
}
