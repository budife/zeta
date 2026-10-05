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
