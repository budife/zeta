/**
 * Appearance mapping: effect/motion ids, their render tuning, and the cycles
 * the UI walks.
 *
 *   motions stay pure CSS — motionClass() returns the .motion--* hook the
 *     MediaLayer wrapper animates (globals.css)
 *   effects are rendered on a canvas from REAL camera pixels
 *     (lib/effectEngine.ts) — this file only whitelists ids and carries the
 *     per-effect tuning, so a stray status value can never reach the renderer
 *
 * The cycle orders (nextEffect / nextBlurLevel) must stay identical to the
 * menu's list.
 */

import { EFFECT_ITEMS } from "./menuModel";

const MOTION_CLASSES: Record<string, string> = {
  shake: "motion--shake",
  float: "motion--float",
  zoom: "motion--zoom",
  pulse: "motion--pulse",
  parallax: "motion--parallax",
};

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

/* ── Effect rendering parameters (canvas pipeline) ───────────────────────────
 *
 * The effect renderer (lib/effectEngine.ts) processes real camera pixels on a
 * canvas inside the hand window. Each effect declares its tuning here: blur
 * radius/quality, edge feather, how often the processed layer may re-render,
 * and particle counts. Radii and feathers are tuned at REFERENCE_WIDTH and
 * scaled by the engine to the actual stage width, so the look is resolution
 * independent.
 */

/** Ids the EFFECTS menu can produce — the whitelist for `status.effect`. */
export type EffectId = "blur" | "rain" | "snow" | "cyberpunk" | "glitch";

/** The blur intensity cycle, shown on the control row while blur is active. */
export type BlurLevel = "soft" | "medium" | "strong";

export const BLUR_LEVELS: readonly BlurLevel[] = ["soft", "medium", "strong"];

/** Stage width (css px) the radii/feathers below are tuned at. */
export const REFERENCE_WIDTH = 1280;

export type EffectParams = {
  /** Blur radius in css px at REFERENCE_WIDTH; 0 for effects that never blur. */
  blurRadius: number;
  /** "low" renders the blur from a half-resolution offscreen (strong level). */
  blurQuality: "high" | "low";
  /** Soft alpha falloff at the window edge, css px at REFERENCE_WIDTH. */
  edgeFeather: number;
  /** Cap on effect renders per second; the snapshot loop still drives it. */
  updateRate: number;
  /** Live rain/snow particles; 0 for non-particle effects. */
  particleCount: number;
};

export const EFFECT_TUNING: Record<EffectId, EffectParams> = {
  blur: { blurRadius: 14, blurQuality: "high", edgeFeather: 16, updateRate: 60, particleCount: 0 },
  rain: { blurRadius: 0, blurQuality: "high", edgeFeather: 10, updateRate: 60, particleCount: 150 },
  snow: { blurRadius: 0, blurQuality: "high", edgeFeather: 12, updateRate: 60, particleCount: 120 },
  cyberpunk: { blurRadius: 0, blurQuality: "high", edgeFeather: 10, updateRate: 30, particleCount: 0 },
  glitch: { blurRadius: 0, blurQuality: "high", edgeFeather: 8, updateRate: 60, particleCount: 0 },
};

export const BLUR_TUNING: Record<BlurLevel, EffectParams> = {
  soft: { ...EFFECT_TUNING.blur, blurRadius: 6, edgeFeather: 10 },
  medium: { ...EFFECT_TUNING.blur },
  strong: { blurRadius: 28, blurQuality: "low", edgeFeather: 24, updateRate: 30, particleCount: 0 },
};

/**
 * The params to render `effect` at the given blur level. Non-blur effects
 * ignore the level (their intensity is fixed); an unknown id falls back to
 * neutral params instead of throwing — status can only hold known ids, but a
 * renderer should degrade rather than crash.
 */
export function effectParams(effect: string, level: BlurLevel = "medium"): EffectParams {
  if (effect === "blur") return BLUR_TUNING[level];
  return (
    EFFECT_TUNING[effect as EffectId] ?? {
      blurRadius: 0,
      blurQuality: "high",
      edgeFeather: 12,
      updateRate: 60,
      particleCount: 0,
    }
  );
}

/** The next blur intensity in menu order, wrapping (soft → medium → strong → soft). */
export function nextBlurLevel(current: BlurLevel): BlurLevel {
  const index = BLUR_LEVELS.indexOf(current);
  return BLUR_LEVELS[(index + 1) % BLUR_LEVELS.length];
}

/**
 * Converts a px value tuned at REFERENCE_WIDTH to the actual stage width, so
 * blur radius, feather and stroke sizes look the same on a phone-sized stage
 * and on a full-screen one.
 */
export function scaledPx(px: number, stageWidth: number): number {
  return (px * stageWidth) / REFERENCE_WIDTH;
}
