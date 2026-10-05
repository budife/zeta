import type { Point } from "./types";
import {
  TEMPLATE_VIEWBOX,
  templateRegionFor,
  type TemplateRegionBox,
} from "./templateRegions";
import type { RegionKind } from "./regions";

/**
 * How the media layer must be transformed so the selected template region
 * lands inside the hand-made window.
 *
 * The media stays full-screen and clipped to the window; this transform pans
 * and scales the whole layer so the *matched region* — not the whole picture —
 * sits in the window. Framing the person's eyes therefore shows the template's
 * eyes, instead of cropping whatever coordinates the window happens to cover.
 */
export type RegionTransform = {
  /** Fractional position of the region's center within the template viewBox. */
  originX: number;
  originY: number;
  /**
   * Scale applied to the full-screen layer. 1 = region fills the stage exactly
   * (i.e. plain full-screen clip). >1 zooms in on the region.
   */
  scale: number;
  /** Rotation in degrees, mirroring the window's tilt. */
  rotation: number;
};

export type MapRegionOptions = {
  /** Window rotation in degrees (already mirrored for the stage). */
  rotation?: number;
  /**
   * How much of the stage the matched region should occupy. 1 = fill it; 0.8
   * leaves 20% margin so the region is visibly framed rather than edge-to-edge.
   */
  fill?: number;
};

/**
 * Computes the transform that aligns a template region with the window.
 *
 * The layer is conceptually infinite (object-fit: cover already scales the
 * template to fill the stage); this transform sets `transform-origin` to the
 * region's center and scales around it, which moves that region into the
 * middle of the stage. The clip-path then cuts it to the window shape.
 *
 * `scale` is derived from the ratio between the stage-relative region size and
 * the window size, so a small window on a big region zooms in and a big window
 * on a small region zooms out — the region stays framed, the picture is never
 * squashed into the box.
 */
export function mapRegionTransform(
  kind: RegionKind | null,
  window: { width: number; height: number },
  videoWidth: number,
  videoHeight: number,
  options: MapRegionOptions = {}
): RegionTransform {
  const fill = options.fill ?? 0.9;
  const region = templateRegionFor(kind);

  const vbW = TEMPLATE_VIEWBOX.width;
  const vbH = TEMPLATE_VIEWBOX.height;

  // One cover scale for both axes, exactly like CSS `object-fit: cover` on an
  // aspect-mismatched source. Using separate scaleX/scaleY (the previous
  // implementation) does not match what the browser does.
  const cover = Math.max(videoWidth / vbW, videoHeight / vbH);
  const renderedW = vbW * cover;
  const renderedH = vbH * cover;

  // `cover` centers the source, so the leftover on each axis is split evenly.
  // This is the offset the old code never accounted for.
  const offsetX = (videoWidth - renderedW) / 2;
  const offsetY = (videoHeight - renderedH) / 2;

  // Region center in stage pixels *after* cover — this is what transform-origin
  // must be, not the raw viewBox fraction.
  const centerX = offsetX + (region.x + region.width / 2) * cover;
  const centerY = offsetY + (region.y + region.height / 2) * cover;

  const originX = centerX / Math.max(videoWidth, 1);
  const originY = centerY / Math.max(videoHeight, 1);

  // Region size in stage pixels after cover.
  const regionW = Math.max(region.width * cover, 1e-6);
  const regionH = Math.max(region.height * cover, 1e-6);

  // Zoom so the region covers `fill` of the window. A window bigger than the
  // region zooms in, a window smaller than the region zooms out — the region
  // stays framed either way, and the picture is never squashed into the box.
  const scale = Math.max(window.width / regionW, window.height / regionH) * fill;

  return {
    originX,
    originY,
    scale,
    rotation: options.rotation ?? 0,
  };
}

/**
 * CSS transform string for the media layer, anchored at the region's center.
 * The layer already fills the stage, so this is purely scale + rotation.
 */
export function regionTransformStyle(t: RegionTransform): string {
  return `scale(${t.scale.toFixed(4)}) rotate(${t.rotation.toFixed(2)}deg)`;
}

/** Center of a template region in viewBox units (debug overlay). */
export function templateRegionCenter(region: TemplateRegionBox): Point {
  return {
    x: region.x + region.width / 2,
    y: region.y + region.height / 2,
  };
}
