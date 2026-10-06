"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { CameraView } from "@/components/CameraView";
import { DebugOverlay } from "@/components/DebugOverlay";
import { HandFrame } from "@/components/HandFrame";
import { MediaLayer } from "@/components/MediaLayer";
import { StatusPanel } from "@/components/StatusPanel";
import { useHandFrameEngine } from "@/hooks/useHandFrameEngine";

/** Default media shown through the hand-made window. */
const DEFAULT_MEDIA = "/vectors/template.svg";

export default function HomePage() {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [debug, setDebug] = useState(false);
  // Media shown through the hand-made window. Defaults to the bundled template;
  // the user can upload any image or video the browser can play.
  const [media, setMedia] = useState(DEFAULT_MEDIA);
  // Match the stage to the real camera frame so overlays stay aligned even for
  // 4:3 or square sensors (object-fit would otherwise crop the picture).
  const [videoSize, setVideoSize] = useState<{ width: number; height: number } | null>(null);

  const {
    status,
    startCamera,
    stopCamera,
    subscribeSnapshot,
  } = useHandFrameEngine();

  const cameraReady = status.camera === "ready";
  const modelsLoading = status.models === "loading";
  const frameActive = status.frame === "active";

  const handleStart = useCallback(() => {
    void startCamera(videoRef.current);
  }, [startCamera]);

  const handleStop = useCallback(() => {
    stopCamera(videoRef.current);
  }, [stopCamera]);

  // Upload Media: any image or video the browser can play becomes the layer
  // shown through the window. Object URLs are released on replace/unmount.
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    return () => {
      if (media.startsWith("blob:")) URL.revokeObjectURL(media);
    };
  }, [media]);

  const handleUpload = useCallback((event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    setMedia((previous) => {
      if (previous.startsWith("blob:")) URL.revokeObjectURL(previous);
      return URL.createObjectURL(file);
    });
    // Reset so picking the same file again still fires onChange.
    event.target.value = "";
  }, []);

  const handleResetMedia = useCallback(() => {
    setMedia((previous) => {
      if (previous.startsWith("blob:")) URL.revokeObjectURL(previous);
      return DEFAULT_MEDIA;
    });
  }, []);

  return (
    <main className="app">
      <header className="app__header">
        <div>
          <h1>Hand Frame → Vector Character</h1>
          <p className="app__subtitle">
            Make a rectangle with both hands. It becomes a window into a full-screen character — only the part inside your hands shows through.
          </p>
        </div>
        <button
          type="button"
          className={`toggle-button ${debug ? "toggle-button--on" : ""}`}
          onClick={() => setDebug((value) => !value)}
          aria-pressed={debug}
        >
          Debug {debug ? "ON" : "OFF"}
        </button>
      </header>

      <section
        className="stage"
        style={videoSize ? { aspectRatio: `${videoSize.width} / ${videoSize.height}` } : undefined}
      >
        <CameraView
          ref={videoRef}
          status={status.camera}
          models={status.models}
          errorMessage={status.error}
          onStart={handleStart}
          onStop={handleStop}
          onVideoSize={setVideoSize}
        />

        {cameraReady && (
          <>
            <MediaLayer
              subscribe={subscribeSnapshot}
              src={media}
              faceAlignEnabled={media === DEFAULT_MEDIA}
            />
            <HandFrame subscribe={subscribeSnapshot} active={frameActive} debug={debug} />
            <DebugOverlay subscribe={subscribeSnapshot} enabled={debug} />
          </>
        )}
      </section>

      <section className="controls">
        <StatusPanel status={status} />

        {!cameraReady && (
          <button
            type="button"
            className="primary-button primary-button--wide"
            onClick={handleStart}
            disabled={modelsLoading}
          >
            {modelsLoading ? "Loading models…" : "Start Camera"}
          </button>
        )}

        {cameraReady && (
          <>
            <div className="media-controls">
              <input ref={fileInputRef} type="file" accept="image/*,video/*" onChange={handleUpload} style={{ display: "none" }} />
              <button type="button" className="ghost-button" onClick={() => fileInputRef.current?.click()}>Upload Media</button>
              {media !== DEFAULT_MEDIA && <button type="button" className="ghost-button ghost-button--subtle" onClick={handleResetMedia}>Use Template</button>}
              <span className="media-controls__name">{media === DEFAULT_MEDIA ? "template.svg" : "uploaded"}</span>
            </div>
            <button type="button" className="ghost-button" onClick={handleStop}>Stop Camera</button>
          </>
        )}
      </section>

      <footer className="app__footer">
        <span>All tracking runs locally in the browser. No frames leave the device.</span>
      </footer>
    </main>
  );
}
