import type { Box, FrameRect, Point, VectorTransform } from "./types";
import type { Similarity } from "./faceAlignment";

/**
 * ── The single coordinate mapping chain ─────────────────────────────────────
 *
 * MediaPipe emits landmarks normalized to [0..1] of the video frame. Every
 * renderer in this app must reach the stage through exactly these links, in
 * this order, and nowhere else:
 *
 *   1. normalizedToVideo()  [0..1]        → video intrinsic px (×W, ×H)
 *   2. toStageFraction()    video px      → stage fraction 0..1 (cover + mirror)
 *   3. toStagePixels()      video px      → stage px  (= link 2 × stage size)
 *
 * Links 2 and 3 share one body (`toStageFraction`), so they cannot drift.
 *
 * Cover invariant: app/page.tsx sizes `.stage` to the video's aspect ratio,
 * so `object-fit: cover` has zero offset and a uniform scale — a video
 * fraction IS a stage fraction. The invariant is enforced by construction
 * (the stage is *derived* from videoWidth/videoHeight, not assumed to match)
 * and the debug panel reports both bounds so a divergence is visible.
 *
 * The mirror is applied exactly ONCE, at link 2, and MIRROR_PREVIEW below is
 * the only place that decides whether it happens — `MIRROR_TRANSFORM` is the
 * CSS counterpart, so the DOM mirror and the math mirror cannot disagree.
 */

/**
 * The preview is rendered as a selfie mirror: the video is flipped
 * horizontally with CSS, so every overlay coordinate must be flipped back to
 * line up with what the user sees.
 */
export const MIRROR_PREVIEW = true;

/**
 * CSS transform producing that same mirror. The camera video and the media
 * layer use this instead of a hardcoded `scaleX(-1)`, so the DOM mirror and
 * `MIRROR_PREVIEW` share one source of truth.
 */
export const MIRROR_TRANSFORM = MIRROR_PREVIEW ? "scaleX(-1)" : "none";

export type Placement = {
  left: string;
  top: string;
  width: string;
  height: string;
  transform: string;
};

function mirrorX(x: number): number {
  return MIRROR_PREVIEW ? 1 - x : x;
}

/** Link 1 — MediaPipe normalized [0..1] → video intrinsic pixels. */
export function normalizedToVideo(point: Point, videoWidth: number, videoHeight: number): Point {
  return { x: point.x * videoWidth, y: point.y * videoHeight };
}

/** Link 2 — video intrinsic px → stage fraction 0..1 (cover, then mirror). */
export function toStageFraction(point: Point, videoWidth: number, videoHeight: number): Point {
  return {
    x: mirrorX(point.x / videoWidth),
    y: point.y / videoHeight,
  };
}

/** CSS placement for an oriented rectangle, centered with a -50% translate. */
export function placeFrame(
  rect: FrameRect,
  videoWidth: number,
  videoHeight: number
): Placement {
  const center = toStageFraction({ x: rect.cx, y: rect.cy }, videoWidth, videoHeight);
  return {
    left: `${center.x * 100}%`,
    top: `${center.y * 100}%`,
    width: `${(rect.width / videoWidth) * 100}%`,
    height: `${(rect.height / videoHeight) * 100}%`,
    // A horizontal mirror is a reflection, which reverses rotation direction.
    transform: `translate(-50%, -50%) rotate(${
      MIRROR_PREVIEW ? -rect.rotation : rect.rotation
    }deg)`,
  };
}

/** CSS placement for an axis-aligned box (top-left anchored). */
export function placeBox(
  box: Box,
  videoWidth: number,
  videoHeight: number
): Placement {
  const right = toStageFraction({ x: box.x + box.width, y: 0 }, videoWidth, videoHeight);
  const left = toStageFraction({ x: box.x, y: 0 }, videoWidth, videoHeight);
  return {
    left: `${Math.min(left.x, right.x) * 100}%`,
    top: `${(box.y / videoHeight) * 100}%`,
    width: `${Math.abs(right.x - left.x) * 100}%`,
    height: `${(box.height / videoHeight) * 100}%`,
    transform: "none",
  };
}

/** CSS placement for a square vector character. */
export function placeVector(
  vector: VectorTransform,
  videoWidth: number,
  videoHeight: number
): Placement {
  const center = toStageFraction({ x: vector.cx, y: vector.cy }, videoWidth, videoHeight);
  return {
    left: `${center.x * 100}%`,
    top: `${center.y * 100}%`,
    width: `${(vector.size / videoWidth) * 100}%`,
    height: `${(vector.size / videoHeight) * 100}%`,
    transform: `translate(-50%, -50%) rotate(${
      MIRROR_PREVIEW ? -vector.rotation : vector.rotation
    }deg)`,
  };
}

/**
 * Link 3 — video intrinsic px → stage pixels.
 *
 * Thin wrapper over `toStageFraction`, so percentage overlays (CSS left/top)
 * and pixel overlays (canvas) can never disagree by even a fraction of a
 * pixel.
 */
export function toStagePixels(
  point: Point,
  videoWidth: number,
  videoHeight: number,
  stageWidth: number,
  stageHeight: number
): Point {
  const f = toStageFraction(point, videoWidth, videoHeight);
  return { x: f.x * stageWidth, y: f.y * stageHeight };
}

/**
 * Normalized box (lib/regions, 0..1) → video-pixel box.
 *
 * Keeps the two box spaces explicit: `regionBox()` and the classifier work in
 * normalized coordinates, while every CSS placement helper takes video pixels.
 * Passing a NormBox straight to `placeBox()` silently collapses it to the
 * top-left corner — this is the conversion that prevents that.
 */
export function normBoxToVideo(
  box: { x: number; y: number; width: number; height: number },
  videoWidth: number,
  videoHeight: number
): Box {
  return {
    x: box.x * videoWidth,
    y: box.y * videoHeight,
    width: box.width * videoWidth,
    height: box.height * videoHeight,
  };
}

/**
 * CSS `clip-path` polygon for the clipping window, in percentages of the
 * stage. The media layer fills the whole stage and is clipped to the
 * quadrilateral the hands form, so only the part of the media inside the
 * window is visible. Coordinates are mirrored like every other overlay.
 */
export function clipPathPolygon(
  corners: Point[],
  videoWidth: number,
  videoHeight: number
): string {
  return corners
    .map((p) => {
      const f = toStageFraction(p, videoWidth, videoHeight);
      return `${(f.x * 100).toFixed(3)}% ${(f.y * 100).toFixed(3)}%`;
    })
    .join(", ");
}

/**
 * Maps a point on the display (in fraction of stage, 0..1) to the
 * corresponding pixel in the source video, accounting for CSS
 * `object-fit: cover` centering and mirror.
 *
 * Both camera and media use object-fit: cover on the same stage, so this
 * mapping works for either. The display X is already in mirrored space
 * (matching what the user sees on screen).
 */
export function displayToSourceVideo(
  displayX: number,
  displayY: number,
  videoWidth: number,
  videoHeight: number,
  stageWidth: number,
  stageHeight: number
): { x: number; y: number } {
  const unmirroredX = MIRROR_PREVIEW ? 1 - displayX : displayX;
  const px = unmirroredX * stageWidth;
  const py = displayY * stageHeight;
  const cover = Math.max(stageWidth / videoWidth, stageHeight / videoHeight);
  const renderedW = videoWidth * cover;
  const renderedH = videoHeight * cover;
  const offsetX = (stageWidth - renderedW) / 2;
  const offsetY = (stageHeight - renderedH) / 2;
  const sourceX = (px - offsetX) / cover;
  const sourceY = (py - offsetY) / cover;
  return {
    x: Math.round(Math.max(0, Math.min(videoWidth, sourceX))),
    y: Math.round(Math.max(0, Math.min(videoHeight, sourceY))),
  };
}

/**
 * Given the four window corners (in video-pixel space, already from mirrorX),
 * compute the bounding box in template viewBox coordinates.
 *
 * The template is rendered with object-fit: cover on the same stage as the
 * camera, so the same cover math applies with the template's natural size
 * (1100×620).
 *
 * Returns { x, y, width, height } in template viewBox pixels, or null if the
 * corners are invalid.
 */
export function windowToTemplateBox(
  corners: Point[],
  videoWidth: number,
  videoHeight: number,
  templateW: number,
  templateH: number
): { x: number; y: number; width: number; height: number } | null {
  if (corners.length !== 4) return null;

  // Corners are in video-pixel space, already mirrored (mirrorX applied).
  // Find the axis-aligned bounding box of the corners in video space.
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const c of corners) {
    minX = Math.min(minX, c.x);
    minY = Math.min(minY, c.y);
    maxX = Math.max(maxX, c.x);
    maxY = Math.max(maxY, c.y);
  }

  // Convert video-pixel coords to fractional [0..1] of the video.
  // At this point the X is already mirrored (mirrorX applied), so we DON'T
  // mirror again — the fraction is in mirrored display space.
  const fracX = minX / videoWidth;
  const fracY = minY / videoHeight;
  const fracW = (maxX - minX) / videoWidth;
  const fracH = (maxY - minY) / videoHeight;

  // These fractions are in display space (mirrored). Map to template source
  // using the same object-fit: cover math.
  // Treat the stage dimensions as equal to the video for this calculation:
  // the fractions are relative to the stage which matches the video aspect.
  const stageW = videoWidth;
  const stageH = videoHeight;

  const cover = Math.max(stageW / templateW, stageH / templateH);
  const renderedW = templateW * cover;
  const renderedH = templateH * cover;
  const offsetX = (stageW - renderedW) / 2;
  const offsetY = (stageH - renderedH) / 2;

  // Map the display rect back to template source pixels.
  // Note: display X is already mirrored, so source X is just (displayPx - offset) / cover.
  const sx = (fracX * stageW - offsetX) / cover;
  const sy = (fracY * stageH - offsetY) / cover;
  const sw = (fracW * stageW) / cover;
  const sh = (fracH * stageH) / cover;

  return {
    x: Math.round(Math.max(0, sx)),
    y: Math.round(Math.max(0, sy)),
    width: Math.round(Math.min(templateW - Math.max(0, sx), sw)),
    height: Math.round(Math.min(templateH - Math.max(0, sy), sh)),
  };
}

/** A CSS 2D matrix: `x' = a·x + c·y + e`, `y' = b·x + d·y + f`. */
export type CssMatrix = { a: number; b: number; c: number; d: number; e: number; f: number };

/**
 * Composes the selfie mirror with a face-alignment similarity into the single
 * CSS matrix the media layer applies with `transform-origin: 0 0`.
 *
 * Derivation — the stage is sized to the video's aspect ratio (app/page.tsx),
 * so video pixels and stage pixels differ only by the uniform scale
 * `k = stageWidth / videoWidth`, and the object-fit: cover offset is zero:
 *
 *   similarity S in video px → stage px
 *     x1 = a·x + c·y + e,   y1 = b·x + d·y + f     (e,f already × k)
 *   horizontal mirror M about the stage centre
 *     x2 = stageWidth − x1, y2 = y1
 *
 *   composed  (a,b,c,d,e,f) = (−a, b, −c, d, stageWidth − e, f)
 */
export function mediaMatrix(
  align: Similarity | null,
  videoWidth: number,
  stageWidth: number
): CssMatrix {
  const s = align ? align.scale : 1;
  const rot = align ? align.rotation : 0;
  const cos = Math.cos(rot);
  const sin = Math.sin(rot);
  const a = s * cos;
  const b = s * sin;
  const c = -s * sin;
  const d = s * cos;
  const k = videoWidth > 0 ? stageWidth / videoWidth : 1;
  const e = (align ? align.tx : 0) * k;
  const f = (align ? align.ty : 0) * k;
  return { a: -a, b, c: -c, d, e: stageWidth - e, f };
}
