/**
 * Shared ASCII rendering helpers — one pipeline, five visual variants.
 *
 * The engine downsamples the camera frame to a grid of cells, maps each
 * cell's luminance to a character from ASCII_RAMP, then draws the characters
 * on the output canvas. Each variant differs only in palette and optional
 * overlay — the sampling and character-mapping logic is shared.
 *
 * Everything in this file is pure (no DOM) so it can be unit-tested.
 */

/**
 * Density ramp from darkest to lightest. Classic 10-level ramp used by
 * most real-time ASCII renderers — each character occupies roughly the
 * same ink area so the luminance steps read evenly.
 */
export const ASCII_RAMP = " .:-=+*#%@" as const;

/**
 * Maps a luminance value (0..255) to an index into ASCII_RAMP.
 * Uses standard Rec.709 luminance weights.
 */
export function asciiRampIndex(r: number, g: number, b: number): number {
  const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  const t = Math.max(0, Math.min(1, lum / 255));
  return Math.round(t * (ASCII_RAMP.length - 1));
}

/**
 * Grid geometry for a given stage size and cell size (css px).
 * Returns integer cols/rows so the character grid tiles exactly.
 */
export function asciiGridForStage(
  stageWidth: number,
  stageHeight: number,
  cellWidth: number,
  cellHeight: number
): { cols: number; rows: number } {
  const cols = Math.max(1, Math.floor(stageWidth / cellWidth));
  const rows = Math.max(1, Math.floor(stageHeight / cellHeight));
  return { cols, rows };
}

/** Visual variants of the ASCII renderer. */
export type AsciiVariant = "live" | "matrix" | "rgb" | "trail" | "holo";

/** Per-variant colour palette. */
export type AsciiPalette = {
  /** Background fill colour (drawn before characters). */
  bg: string;
  /** Primary character colour for mid-to-bright luminance. */
  fg: string;
  /** Accent colour for the brightest characters (top of ramp). */
  accent: string;
  /** Scan-line overlay colour; "" = no scanlines. */
  scan: string;
  /** Whether per-cell colour is derived from the source pixel (true) or forced monochrome (false). */
  useSourceColor: boolean;
};

const PALETTES: Record<AsciiVariant, AsciiPalette> = {
  live: {
    bg: "#000000",
    fg: "#c8c8c8",
    accent: "#ffffff",
    scan: "",
    useSourceColor: false,
  },
  matrix: {
    bg: "#000000",
    fg: "#00cc44",
    accent: "#88ff88",
    scan: "",
    useSourceColor: false,
  },
  rgb: {
    bg: "#000000",
    fg: "#e0e0e0",
    accent: "#ffffff",
    scan: "",
    useSourceColor: true,
  },
  trail: {
    bg: "#000000",
    fg: "#88ccff",
    accent: "#ffffff",
    scan: "",
    useSourceColor: false,
  },
  holo: {
    bg: "#020818",
    fg: "#00b4d8",
    accent: "#90e0ef",
    scan: "rgba(0, 180, 216, 0.08)",
    useSourceColor: false,
  },
};

/** Palette for a variant. */
export function asciiPalette(variant: AsciiVariant): AsciiPalette {
  return PALETTES[variant] ?? PALETTES.live;
}

/**
 * Cell size (css px) that gives roughly `targetCols` columns for a stage
 * of `stageWidth` — used to pick a readable font size automatically.
 * Character cells are ~0.6× wide and ~1.2× tall for a typical monospace.
 */
export function asciiCellSize(stageWidth: number, targetCols: number = 80): {
  cellW: number;
  cellH: number;
} {
  const cellW = Math.max(4, stageWidth / Math.max(10, targetCols));
  const cellH = Math.round(cellW * 1.4);
  return { cellW: Math.round(cellW), cellH };
}

/**
 * Whether a luminance value should use the accent colour (top of ramp).
 * Keeps the brightest 15 % of the ramp in the accent hue.
 */
export function isAccentChar(index: number): boolean {
  return index >= ASCII_RAMP.length - 2;
}
