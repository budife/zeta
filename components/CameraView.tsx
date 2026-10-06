"use client";

import { forwardRef, useCallback, useEffect, useState } from "react";
import { MIRROR_TRANSFORM } from "@/lib/stage";
import type { AppStatus } from "@/lib/types";

export type CameraViewProps = {
  status: AppStatus["camera"];
  models: AppStatus["models"];
  errorMessage: string | null;
  onStart: () => void;
  onStop: () => void;
  onVideoSize?: (size: { width: number; height: number }) => void;
};

/**
 * Owns the <video> element and the camera lifecycle. Nothing is processed here:
 * the element is handed to the engine through the forwarded ref.
 */
export const CameraView = forwardRef<HTMLVideoElement, CameraViewProps>(
  function CameraView({ status, models, errorMessage, onStart, onStop, onVideoSize }, ref) {
    const [ready, setReady] = useState(false);

    const handleLoadedMetadata = useCallback(
      (event: React.SyntheticEvent<HTMLVideoElement>) => {
        setReady(true);
        const target = event.currentTarget;
        if (target.videoWidth && target.videoHeight) {
          onVideoSize?.({ width: target.videoWidth, height: target.videoHeight });
        }
      },
      [onVideoSize]
    );

    useEffect(() => {
      if (status !== "ready") setReady(false);
    }, [status]);

    const cameraOff = status === "off" || status === "error";
    const starting = status === "starting";

    return (
      <div className="camera-view">
        {/* Selfie mirror comes from MIRROR_PREVIEW in lib/stage.ts, so the DOM
            flip and the overlay math can never disagree. */}
        <video
          ref={ref}
          className="camera-video"
          autoPlay
          playsInline
          muted
          style={{ transform: MIRROR_TRANSFORM }}
          onLoadedMetadata={handleLoadedMetadata}
          data-ready={ready}
        />

        {cameraOff && (
          <div className="camera-placeholder">
            <div className="camera-placeholder-card">
              <div className="camera-icon" aria-hidden="true">
                <svg viewBox="0 0 24 24" width="34" height="34" fill="none">
                  <path
                    d="M3 8.5A2.5 2.5 0 0 1 5.5 6h1.2l1.2-1.8A1.5 1.5 0 0 1 9.15 3.6h5.7a1.5 1.5 0 0 1 1.25.6L17.3 6h1.2A2.5 2.5 0 0 1 21 8.5v9A2.5 2.5 0 0 1 18.5 20h-13A2.5 2.5 0 0 1 3 17.5v-9Z"
                    stroke="currentColor"
                    strokeWidth="1.5"
                  />
                  <circle cx="12" cy="13" r="3.6" stroke="currentColor" strokeWidth="1.5" />
                </svg>
              </div>
              <h2>Frame the moment</h2>
              <p>
                {models === "loading"
                  ? "Loading hand & face models…"
                  : models === "error"
                    ? "Models failed to load. Check the network and reload."
                    : "Make a rectangle with both hands to select your face."}
              </p>
              <button
                type="button"
                className="primary-button"
                onClick={onStart}
                disabled={models === "loading" || models === "error"}
              >
                {starting ? "Starting…" : "Start Camera"}
              </button>
              {errorMessage && <p className="error-text">{errorMessage}</p>}
            </div>
          </div>
        )}

        {status === "ready" && (
          <button
            type="button"
            className="stop-button"
            onClick={onStop}
            aria-label="Stop camera"
            title="Stop camera"
          >
            <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor">
              <rect x="6" y="6" width="12" height="12" rx="2.5" />
            </svg>
            Stop
          </button>
        )}
      </div>
    );
  }
);
