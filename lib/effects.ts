/**
 * Appearance mapping: a picked effect/motion id → the CSS hook that renders
 * it, plus the effect cycle the double-pinch gesture walks.
 *
 * Deliberately dumb: every effect and motion is pure CSS (globals.css) — no
 * canvas, no per-frame JS — so this file only has to (a) whitelist ids so a
 * stray status value can never inject a class, and (b) keep the cycle order
 * identical to the menu's list. The renderers consume the classes:
 *
 *   effectClass → .media-layer__fx  (overlay inside the hand window)
 *   motionClass → .media-layer__motion (a full-size wrapper INSIDE the clip,
 *                                      so only the media moves — the window
 *                                      geometry never does)
 */

import { EFFECT_ITEMS } from "./menuModel";

const EFFECT_CLASSES: Record<string, string> = {
  blur: "fx--blur",
  rain: "fx--rain",
  snow: "fx--snow",
  cyberpunk: "fx--cyberpunk",
  glitch: "fx--glitch",
};

const MOTION_CLASSES: Record<string, string> = {
  shake: "motion--shake",
  float: "motion--float",
  zoom: "motion--zoom",
  pulse: "motion--pulse",
  parallax: "motion--parallax",
};

/** CSS modifier for an effect id; "" (render nothing) for none/unknown. */
export function effectClass(effect: string): string {
  return EFFECT_CLASSES[effect] ?? "";
}

/** CSS modifier for a motion id; "" (render nothing) for none/unknown. */
export function motionClass(motion: string): string {
  return MOTION_CLASSES[motion] ?? "";
}

/**
 * The next effect in menu order, wrapping (decision 1: double pinch cycles
 * the EFFECT only — template and motion are untouched). Null (no content) or
 * an unknown id starts the cycle at the first effect instead of throwing:
 * status can only hold known ids anyway.
 */
export function nextEffect(current: string | null): string {
  const index = EFFECT_ITEMS.findIndex((item) => item.id === current);
  return EFFECT_ITEMS[(index + 1) % EFFECT_ITEMS.length].id;
}
