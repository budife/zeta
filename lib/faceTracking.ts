import type { Box, FrameRect, NormalizedLandmark, Point } from "./types";
import { boxContainsCenter, clamp, toRectLocal } from "./geometry";

/**
 * Turns the Face Landmarker result into an axis-aligned bounding box in
 * video-pixel space.
 *
 * The face landmarker publishes ~478 landmarks that hug the face oval, so a
 * min/max over all of them is a reliable, cheap bounding box.
 */
export function computeFaceBox(
  landmarks: NormalizedLandmark[] | undefined | null,
  width: number,
  height: number
): Box | null {
  if (!landmarks || landmarks.length === 0) return null;

  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const lm of landmarks) {
    const x = lm.x * width;
    const y = lm.y * height;
    minX = Math.min(minX, x);
    maxX = Math.max(maxX, x);
    minY = Math.min(minY, y);
    maxY = Math.max(maxY, y);
  }

  const pad = 0.06;
  const w = maxX - minX;
  const h = maxY - minY;
  minX -= w * pad;
  maxX += w * pad;
  minY -= h * pad;
  maxY += h * pad;

  return {
    x: clamp(minX, 0, width),
    y: clamp(minY, 0, height),
    width: clamp(maxX - minX, 0, width),
    height: clamp(maxY - minY, 0, height),
  };
}

export function boxCenter(box: Box): Point {
  return boxContainsCenter(box);
}

export function boxArea(box: Box): number {
  return box.width * box.height;
}

/** Intersection area of two axis-aligned boxes. */
export function intersectArea(a: Box, b: Box): number {
  const x1 = Math.max(a.x, b.x);
  const y1 = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.width, b.x + b.width);
  const y2 = Math.min(a.y + a.height, b.y + b.height);
  if (x2 <= x1 || y2 <= y1) return 0;
  return (x2 - x1) * (y2 - y1);
}

/**
 * Axis-aligned approximation of an oriented rectangle — only used for cheap
 * coverage math. The strict test itself (`faceInSelection`) is rotation-aware.
 */
export function frameBoundingBox(frame: FrameRect): Box {
  const cos = Math.abs(Math.cos((frame.rotation * Math.PI) / 180));
  const sin = Math.abs(Math.sin((frame.rotation * Math.PI) / 180));
  const w = frame.width * cos + frame.height * sin;
  const h = frame.width * sin + frame.height * cos;
  return {
    x: frame.cx - w / 2,
    y: frame.cy - h / 2,
    width: w,
    height: h,
  };
}

/**
 * Is the face inside the hand-made selection?
 *
 * Two tests, both generous:
 *   1. the face center sits inside the (rotated) frame rectangle, expanded by
 *      `margin`, OR
 *   2. at least `minCoverage` of the face box overlaps the frame box.
 */
export function faceInSelection(
  face: Box,
  frame: FrameRect,
  options: { margin?: number; minCoverage?: number } = {}
): boolean {
  const margin = options.margin ?? 1.15;
  const minCoverage = options.minCoverage ?? 0.25;

  const local = toRectLocal(boxCenter(face), frame);
  const centerInside =
    Math.abs(local.x) <= (frame.width / 2) * margin &&
    Math.abs(local.y) <= (frame.height / 2) * margin;
  if (centerInside) return true;

  const coverage =
    intersectArea(face, frameBoundingBox(frame)) / Math.max(boxArea(face), 1);
  return coverage >= minCoverage;
}
