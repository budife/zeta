"use client";

import { useEffect, useRef } from "react";
import { windowToTemplateBox } from "@/lib/stage";
import type { Snapshot } from "@/lib/types";

/** Natural size of public/vectors/template.svg (viewBox). */
const TEMPLATE_W = 1100;
const TEMPLATE_H = 620;

export type TemplateCropPreviewProps = {
  subscribe: (listener: (snapshot: Snapshot) => void) => () => void;
};

/**
 * "Selection preview" — the slice of the template currently inside the
 * hand-made window, shown as a small standalone image (the Photo 2 the user
 * asked for).
 *
 * Same crop math as the main MediaLayer (`windowToTemplateBox`), but instead
 * of clipping a full-screen layer we position a scaled copy of the template
 * inside a fixed viewport so the crop box exactly fills it.
 */
export function TemplateCropPreview({ subscribe }: TemplateCropPreviewProps) {
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const imgRef = useRef<HTMLImageElement | null>(null);

  useEffect(() => {
    const off = subscribe((snapshot: Snapshot) => {
      const viewport = viewportRef.current;
      const img = imgRef.current;
      if (!viewport || !img) return;

      const { windowCorners, videoWidth, videoHeight, frameActive } = snapshot;

      const box =
        frameActive && windowCorners.length === 4
          ? windowToTemplateBox(
              windowCorners,
              videoWidth,
              videoHeight,
              TEMPLATE_W,
              TEMPLATE_H
            )
          : null;

      if (!box || box.width < 4 || box.height < 4) {
        viewport.style.opacity = "0";
        return;
      }
      viewport.style.opacity = "1";

      const vw = viewport.clientWidth || 240;
      const vh = viewport.clientHeight || 135;

      // Scale the template so the crop box fills the viewport (cover-style).
      const scale = Math.max(vw / box.width, vh / box.height);

      img.style.width = `${TEMPLATE_W * scale}px`;
      img.style.height = `${TEMPLATE_H * scale}px`;
      img.style.left = `${-box.x * scale}px`;
      img.style.top = `${-box.y * scale}px`;
    });
    return off;
  }, [subscribe]);

  return (
    <div className="crop-preview">
      <div className="crop-preview__label">Selection Preview</div>
      <div ref={viewportRef} className="crop-preview__viewport">
        <img
          ref={imgRef}
          className="crop-preview__img"
          src="/vectors/template.svg"
          alt="Selected area of the template"
          draggable={false}
        />
      </div>
    </div>
  );
}
