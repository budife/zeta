"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { HandFrameEngine } from "@/lib/engine";
import { INITIAL_MODE } from "@/lib/modes";
import { DEFAULT_SELECTION } from "@/lib/menuModel";
import type { AppStatus, Snapshot } from "@/lib/types";

const DEFAULT_STATUS: AppStatus = {
  camera: "off",
  models: "loading",
  mode: INITIAL_MODE,
  menuTop: null,
  selectionMode: "template",
  template: DEFAULT_SELECTION.template,
  effect: DEFAULT_SELECTION.effect,
  motion: DEFAULT_SELECTION.motion,
  hands: 0,
  frame: "inactive",
  face: "none",
  region: null,
  regionConfidence: 0,
  error: null,
};

/**
 * Wires the realtime engine to React.
 *
 * Continuous per-frame data is deliberately *not* stored in state: overlays
 * subscribe via `subscribeSnapshot` and write transforms straight to the DOM.
 * Only the discrete `status` object goes through React, and the engine only
 * emits it when something actually changed.
 */
export function useHandFrameEngine() {
  const engineRef = useRef<HandFrameEngine | null>(null);
  const [status, setStatus] = useState<AppStatus>(DEFAULT_STATUS);

  if (!engineRef.current) {
    engineRef.current = new HandFrameEngine();
  }

  const engine = engineRef.current;

  // Preload the MediaPipe models in the background so the Start Camera button
  // is warm.
  useEffect(() => {
    let active = true;
    engine
      .loadModels()
      .then(() => {
        if (active) engine.setModelsStatus("ready");
      })
      .catch((error: unknown) => {
        if (!active) return;
        console.error("[useHandFrameEngine] model load failed", error);
        engine.setModelsStatus(
          "error",
          error instanceof Error ? error.message : "Failed to load MediaPipe models"
        );
      });
    return () => {
      active = false;
    };
  }, [engine]);

  useEffect(() => {
    const off = engine.onStatus(setStatus);
    return () => {
      off();
    };
  }, [engine]);

  useEffect(() => {
    return () => {
      engine.dispose();
    };
  }, [engine]);

  const startCamera = useCallback(
    async (video: HTMLVideoElement | null) => {
      if (!video) return;
      engine.attach(video);
      engine.setCameraStatus("starting");
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: "user" },
          audio: false,
        });
        video.srcObject = stream;
        await video.play();
        engine.setCameraStatus("ready");
        engine.start();
      } catch (error) {
        console.error("[useHandFrameEngine] camera failed", error);
        engine.setCameraStatus(
          "error",
          error instanceof Error ? error.message : "Camera access denied"
        );
      }
    },
    [engine]
  );

  const stopCamera = useCallback(
    (video: HTMLVideoElement | null) => {
      engine.reset();
      if (video) {
        const stream = video.srcObject as MediaStream | null;
        stream?.getTracks().forEach((track) => track.stop());
        video.srcObject = null;
      }
    },
    [engine]
  );

  const subscribeSnapshot = useCallback(
    (listener: (snapshot: Snapshot) => void) => engine.onSnapshot(listener),
    [engine]
  );

  const handleModeEvent = useCallback(
    (event: import("@/lib/modes").ModeEvent) => engine.handleModeEvent(event),
    [engine]
  );

  return {
    status,
    startCamera,
    stopCamera,
    subscribeSnapshot,
    handleModeEvent,
    engine,
  };
}
