"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { CameraView } from "@/components/CameraView";
import { DebugOverlay } from "@/components/DebugOverlay";
import { HandFrame } from "@/components/HandFrame";
import { SavedFrames } from "@/components/SavedFrames";
import { MediaLayer } from "@/components/MediaLayer";
import { StatusPanel } from "@/components/StatusPanel";
import { useHandFrameEngine } from "@/hooks/useHandFrameEngine";
import { MainMenu } from "@/components/MainMenu";
import { nextBlurLevel, type BlurLevel } from "@/lib/effects";
import type { ModeEvent } from "@/lib/modes";

/** Default media shown through the hand-made window. */
const DEFAULT_MEDIA = "/vectors/template.svg";

export default function HomePage() {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [debug, setDebug] = useState(false);
  // An uploaded image/video overrides the selected template's asset; the
  // template path itself is derived from the engine's menu pick. Object URLs
  // are released on replace/unmount (the [media] effect below).
  const [uploaded, setUploaded] = useState<string | null>(null);
  const [uploadedMime, setUploadedMime] = useState<string | null>(null);
  // Match the stage to the real camera frame so overlays stay aligned even for
  // 4:3 or square sensors (object-fit would otherwise crop the picture).
  const [videoSize, setVideoSize] = useState<{ width: number; height: number } | null>(null);
  // Blur intensity (soft/medium/strong) while the blur effect is live —
  // local UI state; the engine picks it up through MediaLayer's prop.
  const [blurLevel, setBlurLevel] = useState<BlurLevel>("medium");

  const handleBlurLevel = useCallback(() => {
    setBlurLevel((current) => nextBlurLevel(current));
  }, []);

  const {
    status,
    startCamera,
    stopCamera,
    subscribeSnapshot,
    handleModeEvent,
  } = useHandFrameEngine();

  // What (if anything) shows through the window: only the template category
  // renders content — effect/motion modes leave the raw camera visible
  // (spec §22: the three categories are mutually exclusive modes). An
  // uploaded file overrides the selected template's asset; object URLs are
  // released on replace/unmount (the [media] effect below).
  const media =
    status.contentMode === "template" && status.template
      ? (uploaded ?? `/vectors/${status.template}.svg`)
      : null;
  const cameraReady = status.camera === "ready";
  const modelsLoading = status.models === "loading";
  const frameActive = status.frame === "active";
  const menuOpen = status.mode === "MENU_OPEN" || status.mode === "MENU_SELECT";

  const handleStart = useCallback(() => {
    void startCamera(videoRef.current);
  }, [startCamera]);

  const handleStop = useCallback(() => {
    stopCamera(videoRef.current);
  }, [stopCamera]);

  // Upload Media: any image or video the browser can play becomes the layer
  // shown through the window. Object URLs are released on replace/unmount.
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // Release the object URL when the uploaded file is REPLACED or cleared —
  // keyed on `uploaded`, not on derived `media`, so merely leaving template
  // mode (media → null) never revokes a URL the state still holds.
  useEffect(() => {
    return () => {
      if (uploaded?.startsWith("blob:")) URL.revokeObjectURL(uploaded);
    };
  }, [uploaded]);

  const handleUpload = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0];
      if (!file) return;
      setUploaded(URL.createObjectURL(file));
      setUploadedMime(file.type || null);
      // The upload row's pick: contentMode becomes "template" with the
      // uploaded asset on top (media derives uploaded over status.template).
      // Dispatched DIRECTLY so handleMenuEvent's "a template pick supersedes
      // the upload" rule does not clear the file we just chose.
      handleModeEvent({ type: "itemSelected", item: { kind: "template", id: "upload" } });
      // Reset so picking the same file again still fires onChange.
      event.target.value = "";
    },
    [handleModeEvent]
  );

  const handleResetMedia = useCallback(() => {
    setUploaded(null);
    setUploadedMime(null);
    // "Use Template" also means: make template.svg the selected template.
    handleModeEvent({ type: "itemSelected", item: { kind: "template", id: "template" } });
  }, [handleModeEvent]);

  // Menu events reach the engine; a template pick also supersedes any
  // uploaded layer (the menu's choice wins) — except the upload row itself,
  // which is about to replace it with the user's own file.
  const handleMenuEvent = useCallback(
    (event: ModeEvent) => {
      if (
        event.type === "itemSelected" &&
        event.item?.kind === "template" &&
        event.item.id !== "upload"
      ) {
        setUploaded(null);
        setUploadedMime(null);
      }
      handleModeEvent(event);
    },
    [handleModeEvent]
  );

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
              contentMode={status.contentMode}
              src={media}
              templateId={status.template}
              srcMimeType={media === uploaded ? uploadedMime : null}
              faceAlignEnabled={media === DEFAULT_MEDIA}
              effect={status.effect}
              blurLevel={blurLevel}
              motion={status.motion}
              cameraVideoRef={videoRef}
            />
            <HandFrame subscribe={subscribeSnapshot} active={frameActive} debug={debug} />
            <SavedFrames subscribe={subscribeSnapshot} />
            {menuOpen && (
              <MainMenu
                subscribe={subscribeSnapshot}
                mode={status.mode}
                menuTop={status.menuTop}
                contentMode={status.contentMode}
                template={status.template}
                effect={status.effect}
                motion={status.motion}
                onUpload={() => fileInputRef.current?.click()}
                onEvent={handleMenuEvent}
              />
            )}
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
              {/* Only when a non-default template asset is live — in
                  effect/motion mode there is no media to reset (the menu is
                  the way back to TEMPLATE). */}
              {media !== null && media !== DEFAULT_MEDIA && (
                <button type="button" className="ghost-button ghost-button--subtle" onClick={handleResetMedia}>Use Template</button>
              )}
              {/* Blur intensity cycle — only while the blur effect is live. */}
              {status.contentMode === "effect" && status.effect === "blur" && (
                <button type="button" className="ghost-button" onClick={handleBlurLevel}>
                  Blur: {blurLevel[0].toUpperCase() + blurLevel.slice(1)}
                </button>
              )}
              <span className="media-controls__name">
                {media === null ? "" : media.startsWith("blob:") ? "uploaded" : media.split("/").pop()}
              </span>
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
