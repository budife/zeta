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
  // Canvas-rendered motions: empty CSS class, MediaLayer uses MotionEngine.
  "reality-zoom": "",
  echo: "",
  freeze: "",
  shutter: "",
  portal: "",
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
export type EffectId =
  | "blur"
  | "rain"
  | "snow"
  | "fog"
  | "cyberpunk"
  | "glitch"
  | "comic"
  | "ascii-live"
  | "ascii-matrix"
  | "ascii-rgb"
  | "ascii-trail"
  | "ascii-holo"
  | "thermal"
  | "film"
  | "heat"
  | "holo"
  | "neon"
  | "particles"
  | "portal";

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
  fog: { blurRadius: 0, blurQuality: "high", edgeFeather: 14, updateRate: 30, particleCount: 0 },
  cyberpunk: { blurRadius: 0, blurQuality: "high", edgeFeather: 10, updateRate: 30, particleCount: 0 },
  glitch: { blurRadius: 0, blurQuality: "high", edgeFeather: 8, updateRate: 60, particleCount: 0 },
  comic: { blurRadius: 0, blurQuality: "high", edgeFeather: 10, updateRate: 60, particleCount: 0 },
  // ASCII family — low frame rate is fine (the grid is coarse).
  "ascii-live": { blurRadius: 0, blurQuality: "high", edgeFeather: 8, updateRate: 24, particleCount: 0 },
  "ascii-matrix": { blurRadius: 0, blurQuality: "high", edgeFeather: 8, updateRate: 24, particleCount: 0 },
  "ascii-rgb": { blurRadius: 0, blurQuality: "high", edgeFeather: 8, updateRate: 30, particleCount: 0 },
  "ascii-trail": { blurRadius: 0, blurQuality: "high", edgeFeather: 8, updateRate: 30, particleCount: 0 },
  "ascii-holo": { blurRadius: 0, blurQuality: "high", edgeFeather: 8, updateRate: 24, particleCount: 0 },
  // Colour / style effects
  thermal: { blurRadius: 0, blurQuality: "high", edgeFeather: 10, updateRate: 30, particleCount: 0 },
  film: { blurRadius: 0, blurQuality: "high", edgeFeather: 12, updateRate: 30, particleCount: 0 },
  heat: { blurRadius: 0, blurQuality: "high", edgeFeather: 10, updateRate: 30, particleCount: 0 },
  holo: { blurRadius: 0, blurQuality: "high", edgeFeather: 10, updateRate: 30, particleCount: 0 },
  neon: { blurRadius: 0, blurQuality: "high", edgeFeather: 10, updateRate: 30, particleCount: 0 },
  particles: { blurRadius: 0, blurQuality: "high", edgeFeather: 10, updateRate: 60, particleCount: 200 },
  portal: { blurRadius: 0, blurQuality: "high", edgeFeather: 12, updateRate: 30, particleCount: 0 },
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

/* ── Timing / character tunings ────────────────────────────────────────────
 *
 * How the temporal effects BEHAVE (when a glitch fires, how long the flash
 * lasts, …). Pure data + pure schedulers so the feel is unit-testable and the
 * engine stays free of magic numbers.
 */

/** Glitch is meant to be ever-present: short gaps, punchy bursts. */
export const GLITCH_TIMING = {
  /** Quiet between bursts, ms. */
  gapMinMs: 250,
  gapMaxMs: 750,
  /** How long each burst rages, ms. */
  burstMinMs: 240,
  burstMaxMs: 520,
  /** Displaced slice bands per burst. */
  bandsMin: 3,
  bandsMax: 6,
  /** Max horizontal slice shift, css px. */
  shiftMaxPx: 22,
  /** Chance a band gets the hue tint. */
  tintChance: 0.55,
  /** Chance a band gets inverted colours. */
  invertChance: 0.35,
  /** Corrupted mosaic blocks per burst. */
  blocksMin: 2,
  blocksMax: 5,
  /** Static noise rows drawn per burst frame. */
  noiseRows: 3,
} as const;

/** Schedules the next glitch burst from `now`. */
export function glitchSchedule(
  now: number,
  rng: () => number
): { end: number; next: number } {
  const end =
    now + GLITCH_TIMING.burstMinMs + rng() * (GLITCH_TIMING.burstMaxMs - GLITCH_TIMING.burstMinMs);
  const gap =
    GLITCH_TIMING.gapMinMs + rng() * (GLITCH_TIMING.gapMaxMs - GLITCH_TIMING.gapMinMs);
  return { end, next: end + gap };
}

/** Rain's showpiece: a rare strike with a double-pulse flash. */
export const LIGHTNING_TIMING = {
  /** Quiet between strikes, ms (4.5–9s). */
  gapMinMs: 4500,
  gapMaxMs: 9000,
  /** Whole flash envelope, ms. */
  flashMs: 160,
  /** How long the bolt itself stays drawn, ms. */
  boltMs: 70,
} as const;

/**
 * White-flash brightness at `t` ms after the strike: pulse 1 (0–70ms, strong),
 * a dead dip, then pulse 2 (95ms–flashMs, weaker). 0 outside the window.
 */
export function lightningAlpha(t: number): number {
  const { flashMs } = LIGHTNING_TIMING;
  if (t < 0 || t >= flashMs) return 0;
  if (t < 70) return 0.5 * Math.sin((Math.PI * t) / 70);
  if (t < 95) return 0;
  return 0.28 * Math.sin((Math.PI * (t - 95)) / (flashMs - 95));
}

/** Snow's wind gusts: short pushes separated by longer rests. */
export const GUST_TIMING = {
  activeMinMs: 1800,
  activeMaxMs: 3200,
  restMinMs: 6000,
  restMaxMs: 11000,
  /** Peak drift as a fraction of stage height per second (at full depth). */
  strength: 0.5,
} as const;

/** Fog's light shafts: a few soft beams slowly swaying. */
export const SHAFT_TUNING = {
  count: 3,
  /** Peak beam alpha (kept low — fog must stay mist, not spotlight). */
  alpha: 0.12,
  /** Beam width as a fraction of stage width. */
  widthFrac: 0.16,
  /** Full sway cycle, ms. */
  swayMs: 14000,
} as const;

/** Comic's manga speed-lines: periodic bursts from a random focus. */
export const COMIC_LINES_TIMING = {
  everyMinMs: 4000,
  everyMaxMs: 7500,
  activeMs: 700,
  count: 34,
} as const;
