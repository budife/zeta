import type { Box, FrameRect, Point, VectorTransform } from "./types";

/**
 * The preview is rendered as a selfie mirror: the video is flipped
 * horizontally with CSS, so every overlay coordinate must be flipped back to
 * line up with what the user sees.
 */
export const MIRROR_PREVIEW = true;

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

/** CSS placement for an oriented rectangle, centered with a -50% translate. */
export function placeFrame(
  rect: FrameRect,
  videoWidth: number,
  videoHeight: number
): Placement {
  const left = mirrorX(rect.cx / videoWidth);
  return {
    left: `${left * 100}%`,
    top: `${(rect.cy / videoHeight) * 100}%`,
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
  const right = mirrorX((box.x + box.width) / videoWidth);
  const left = mirrorX(box.x / videoWidth);
  return {
    left: `${Math.min(left, right) * 100}%`,
    top: `${(box.y / videoHeight) * 100}%`,
    width: `${Math.abs(right - left) * 100}%`,
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
  return {
    left: `${mirrorX(vector.cx / videoWidth) * 100}%`,
    top: `${(vector.cy / videoHeight) * 100}%`,
    width: `${(vector.size / videoWidth) * 100}%`,
    height: `${(vector.size / videoHeight) * 100}%`,
    transform: `translate(-50%, -50%) rotate(${
      MIRROR_PREVIEW ? -vector.rotation : vector.rotation
    }deg)`,
  };
}

/** Maps a video-space point to stage pixels (used by the canvas debug layer). */
export function toStagePixels(
  point: Point,
  videoWidth: number,
  videoHeight: number,
  stageWidth: number,
  stageHeight: number
): Point {
  return {
    x: mirrorX(point.x / videoWidth) * stageWidth,
    y: (point.y / videoHeight) * stageHeight,
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
      const x = mirrorX(p.x / videoWidth) * 100;
      const y = (p.y / videoHeight) * 100;
      return `${x.toFixed(3)}% ${y.toFixed(3)}%`;
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
