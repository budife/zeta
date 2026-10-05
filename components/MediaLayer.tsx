"use client";

import { useEffect, useRef, useState } from "react";
import { clipPathPolygon, MIRROR_PREVIEW } from "@/lib/stage";
import type { Snapshot } from "@/lib/types";

export type MediaLayerProps = {
  subscribe: (listener: (snapshot: Snapshot) => void) => () => void;
  src: string;
};

export function MediaLayer({ subscribe, src }: MediaLayerProps) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const clipRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const imgRef = useRef<HTMLImageElement | null>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => {
      imgRef.current = img;
      setLoaded(true);
    };
    img.src = src;
  }, [src]);

  useEffect(() => {
    if (!loaded) return;
    const off = subscribe((snapshot: Snapshot) => {
      const clip = clipRef.current;
      const canvas = canvasRef.current;
      const img = imgRef.current;
      if (!clip || !canvas || !img) return;

      const { windowCorners, videoWidth, videoHeight, frameActive, lipDeformation } =
        snapshot;

      if (windowCorners.length === 4 && frameActive) {
        clip.style.clipPath = `polygon(${clipPathPolygon(
          windowCorners,
          videoWidth,
          videoHeight
        )})`;
      } else {
        clip.style.clipPath = "inset(50%)";
      }

      const rect = clip.getBoundingClientRect();
      const cw = Math.round(rect.width);
      const ch = Math.round(rect.height);
      if (cw === 0 || ch === 0) return;

      if (canvas.width !== cw || canvas.height !== ch) {
        canvas.width = cw;
        canvas.height = ch;
      }

      const ctx = canvas.getContext("2d");
      if (!ctx) return;

      ctx.clearRect(0, 0, cw, ch);

      const iw = img.naturalWidth || 1;
      const ih = img.naturalHeight || 1;
      const cover = Math.max(cw / iw, ch / ih);
      const drawW = iw * cover;
      const drawH = ih * cover;
      const ox = (cw - drawW) / 2;
      const oy = (ch - drawH) / 2;
      ctx.drawImage(img, ox, oy, drawW, drawH);

      if (!lipDeformation || !lipDeformation.deformedContour || lipDeformation.deformedContour.length < 3) {
        return;
      }

      const restContour = lipDeformation.deformedContour;

      const toCanvasX = (nx: number) => {
        const mx = MIRROR_PREVIEW ? 1 - nx : nx;
        return ox + mx * drawW;
      };
      const toCanvasY = (ny: number) => oy + ny * drawH;

      const pts = restContour.map((p) => ({
        x: toCanvasX(p.x),
        y: toCanvasY(p.y),
      }));

      ctx.save();
      ctx.beginPath();
      ctx.moveTo(pts[0].x, pts[0].y);
      for (let i = 1; i < pts.length; i++) {
        ctx.lineTo(pts[i].x, pts[i].y);
      }
      ctx.closePath();

      ctx.fillStyle = "rgba(229, 62, 62, 0.55)";
      ctx.fill();
      ctx.strokeStyle = "rgba(197, 48, 48, 0.4)";
      ctx.lineWidth = 1.5;
      ctx.stroke();
      ctx.restore();
    });
    return off;
  }, [subscribe, loaded]);

  return (
    <div ref={rootRef} className="media-layer" aria-hidden="true">
      <div ref={clipRef} className="media-layer__clip">
        <canvas ref={canvasRef} className="media-layer__canvas" />
      </div>
    </div>
  );
}
