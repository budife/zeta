import type { RegionKind } from "./regions";

/**
 * Where each semantic region sits inside `public/vectors/template.svg`.
 *
 * The template's viewBox is `0 0 1100 620`; every box here is expressed in
 * that viewBox space so the numbers are stable regardless of the stage size.
 *
 * **This file is the only place to tune what each region shows.** The tracking
 * code never reads template geometry — it only asks "which region did the user
 * frame?" and looks the answer up here. Adjust a box below and the mapping
 * changes, without touching any detection logic.
 *
 * The boxes are first estimates for the bundled placeholder art; refine them to
 * match your own template (see README → "Media yang ditampilkan melalui
 * window").
 *
 * Coordinates: `x, y` = top-left of the region, `width/height` = its size,
 * all in viewBox units.
 */
export type TemplateRegionBox = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export const TEMPLATE_VIEWBOX = { width: 1100, height: 620 } as const;

export const TEMPLATE_REGIONS: Partial<Record<RegionKind, TemplateRegionBox>> = {
  // The head occupies the upper third of the placeholder art.
  eyes: { x: 330, y: 150, width: 440, height: 120 },
  face: { x: 300, y: 110, width: 500, height: 460 },
  head: { x: 270, y: 60, width: 560, height: 560 },
  neck: { x: 480, y: 540, width: 140, height: 90 },
  torso: { x: 300, y: 560, width: 500, height: 460 },
  "left-arm": { x: 130, y: 480, width: 240, height: 480 },
  "right-arm": { x: 730, y: 480, width: 240, height: 480 },
  "left-hand": { x: 110, y: 920, width: 180, height: 180 },
  "right-hand": { x: 810, y: 920, width: 180, height: 180 },
  "left-leg": { x: 380, y: 980, width: 200, height: 420 },
  "right-leg": { x: 520, y: 980, width: 200, height: 420 },
};

/**
 * Fallback box used when the classified region has no template entry (or when
 * the classifier returns null). Falls back to plain clipping behavior: the
 * whole template fills the stage.
 */
export const TEMPLATE_REGION_DEFAULT: TemplateRegionBox = {
  x: 0,
  y: 0,
  width: TEMPLATE_VIEWBOX.width,
  height: TEMPLATE_VIEWBOX.height,
};

export function templateRegionFor(kind: RegionKind | null): TemplateRegionBox {
  if (kind === null) return TEMPLATE_REGION_DEFAULT;
  return TEMPLATE_REGIONS[kind] ?? TEMPLATE_REGION_DEFAULT;
}
