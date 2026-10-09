/**
 * Effect engine — renders effects from REAL camera pixels on a canvas inside
 * the hand window (replacing the old CSS overlay layers, which composited
 * against a transparent backdrop instead of the frame).
 *
 * This file is staged by scripts/run-logic-tests.mjs like every other top-level
 * lib module, so everything reachable from tests must stay pure (no DOM, no
 * canvas). The DOM-touching `EffectEngine` class lives here too, but only its
 * parameter math and particle/polygon helpers are exercised by the logic
 * checks.
 *
 * Pipeline (per frame, inside MediaLayer's existing snapshot subscription):
 *
 *   camera <video> ──drawImage (cover+mirror matrix)──► sourceCanvas
 *     ──per-effect pass (blur / grading / particles / glitch)──► scratch
 *     ──feather mask (inset polygon, blurred alpha, destination-in)──► scratch
 *     ──composite──► <canvas> in stage px, inside the CSS clip-path
 *
 * The clip-path on the wrapper stays the ONLY geometric cut; the canvas itself
 * is never transformed, so the window edges follow the hand anchors exactly
 * (including trapezoids) while the feather softens the transition.
 */

import type { Point } from "./types";
import { cameraCoverTransform, stagePolygonPoints } from "./stage";
import {
  COMIC_LINES_TIMING,
  effectParams,
  scaledPx,
  glitchSchedule,
  GLITCH_TIMING,
  GUST_TIMING,
  LIGHTNING_TIMING,
  SHAFT_TUNING,
  lightningAlpha,
  type BlurLevel,
  type EffectParams,
} from "./effects";
import {
  ASCII_RAMP,
  asciiRampIndex,
  asciiGridForStage,
  asciiPalette,
  asciiCellSize,
  isAccentChar,
  type AsciiVariant,
} from "./ascii";

export type Box = { x: number; y: number; width: number; height: number };
export type Rng = () => number;

/**
 * One rain drop or snow flake, in stage css px. Velocities are px/second and
 * were captured relative to the stage height at spawn time, so particle speed
 * stays visually stable across resolutions.
 */
export type Particle = {
  x: number;
  y: number;
  vx: number;
  vy: number;
  /** Stroke width (rain) or radius (snow), css px. */
  size: number;
  alpha: number;
  /** 0 = far … 1 = near; drives streak length / flake shading. */
  depth: number;
  /** Sway phase (snow); advanced by stepParticle(). */
  phase: number;
  /** Sway amplitude, css px (0 for rain — wind is baked into vx). */
  sway: number;
};

/**
 * Shrinks a convex polygon by `distance` px: every edge moves inward along
 * its normal, and each vertex is the intersection of its two adjacent offset
 * edges. Used to build the feather mask — the blur samples inward from the
 * window boundary so the soft edge lands INSIDE the visible region (the
 * clip-path never eats into the falloff).
 *
 * Orientation-independent: the inward normal is picked by testing against the
 * centroid, so mirrored / clockwise / counter-clockwise corner orders all
 * work (the hand tracker's corner order is not contractual).
 *
 * Degenerate inputs (fewer than 3 points, zero area) pass through unchanged —
 * the mask then skips feathering for that frame instead of throwing.
 */
export function insetPolygon(points: readonly Point[], distance: number): Point[] {
  const n = points.length;
  if (n < 3 || !(distance > 0)) return points.slice();

  const area2 = signedArea2(points);
  if (Math.abs(area2) < 1e-9) return points.slice();

  let cx = 0;
  let cy = 0;
  for (const p of points) {
    cx += p.x;
    cy += p.y;
  }
  cx /= n;
  cy /= n;

  type Line = { px: number; py: number; dx: number; dy: number };
  const lines: Line[] = [];
  for (let i = 0; i < n; i++) {
    const p = points[i];
    const q = points[(i + 1) % n];
    const ex = q.x - p.x;
    const ey = q.y - p.y;
    const len = Math.hypot(ex, ey);
    if (len < 1e-9) {
      lines.push({ px: p.x, py: p.y, dx: ex, dy: ey });
      continue;
    }
    let nx = ey / len;
    let ny = -ex / len;
    if ((cx - p.x) * nx + (cy - p.y) * ny < 0) {
      nx = -nx;
      ny = -ny;
    }
    lines.push({ px: p.x + nx * distance, py: p.y + ny * distance, dx: ex, dy: ey });
  }

  const out: Point[] = [];
  for (let i = 0; i < n; i++) {
    const hit = intersectLines(lines[(i - 1 + n) % n], lines[i]);
    if (hit) {
      out.push(hit);
    } else {
      // Adjacent offset edges are parallel — fall back to pulling the vertex
      // toward the centroid by the same distance.
      out.push(towardCentroid(points[i], cx, cy, distance, points));
    }
  }

  const area2Out = signedArea2(out);
  if (Math.sign(area2Out) !== Math.sign(area2) || Math.abs(area2Out) < Math.abs(area2) * 0.2) {
    // Self-intersecting or collapsed result (possible for concave inputs):
    // uniform shrink toward the centroid instead.
    return points.map((p) => towardCentroid(p, cx, cy, distance, points));
  }
  return out;
}

function signedArea2(points: readonly Point[]): number {
  let s = 0;
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    const q = points[(i + 1) % points.length];
    s += p.x * q.y - q.x * p.y;
  }
  return s;
}

function intersectLines(
  l1: { px: number; py: number; dx: number; dy: number },
  l2: { px: number; py: number; dx: number; dy: number }
): Point | null {
  const cross = l1.dx * l2.dy - l1.dy * l2.dx;
  if (Math.abs(cross) < 1e-9) return null;
  const t = ((l2.px - l1.px) * l2.dy - (l2.py - l1.py) * l2.dx) / cross;
  return { x: l1.px + t * l1.dx, y: l1.py + t * l1.dy };
}

function towardCentroid(
  p: Point,
  cx: number,
  cy: number,
  distance: number,
  points: readonly Point[]
): Point {
  let minDist = Infinity;
  for (const q of points) {
    minDist = Math.min(minDist, Math.hypot(q.x - cx, q.y - cy));
  }
  const t = minDist > 1e-9 ? Math.min(0.5, (distance * Math.SQRT2) / minDist) : 0.5;
  return { x: p.x + (cx - p.x) * t, y: p.y + (cy - p.y) * t };
}

/* ── Particles ───────────────────────────────────────────────────────────── */

/**
 * Spawns a rain drop somewhere inside `box`, falling with a slight wind.
 * Speed and opacity scale with depth (0 = far, 1 = near), so the shower reads
 * as three-dimensional instead of a flat tile.
 */
export function createRainParticle(box: Box, stageHeight: number, rng: Rng): Particle {
  const depth = rng();
  const vy = (1.3 + depth * 1.4) * stageHeight;
  return {
    x: box.x + rng() * box.width,
    y: box.y + rng() * box.height,
    vx: 0.14 * vy, // fixed wind angle, consistent across all drops
    vy,
    size: 1 + depth * 1.6,
    alpha: 0.25 + depth * 0.45,
    depth,
    phase: 0,
    sway: 0,
  };
}

export type SnowLayer = "far" | "mid" | "near";

/**
 * Spawns a snow flake in `box`. Three layers fall at different speeds with
 * different sway and size — near flakes are bigger and slower to read as
 * closer to the camera (parallax).
 */
export function createSnowParticle(box: Box, stageHeight: number, layer: SnowLayer, rng: Rng): Particle {
  const cfg = {
    far: { vy: 0.1, sizeMin: 1, sizeMax: 1.8, alphaMin: 0.3, alphaMax: 0.45, swayMin: 4, swayMax: 8, depth: 0.15 },
    mid: { vy: 0.2, sizeMin: 1.8, sizeMax: 3, alphaMin: 0.45, alphaMax: 0.65, swayMin: 8, swayMax: 16, depth: 0.5 },
    near: { vy: 0.35, sizeMin: 3, sizeMax: 4.5, alphaMin: 0.65, alphaMax: 0.85, swayMin: 14, swayMax: 26, depth: 0.9 },
  }[layer];
  const u1 = rng();
  const u2 = rng();
  const u3 = rng();
  const u4 = rng();
  const u5 = rng();
  return {
    x: box.x + u1 * box.width,
    y: box.y + u2 * box.height,
    vx: 0,
    vy: cfg.vy * stageHeight,
    size: cfg.sizeMin + u3 * (cfg.sizeMax - cfg.sizeMin),
    alpha: cfg.alphaMin + u4 * (cfg.alphaMax - cfg.alphaMin),
    depth: cfg.depth,
    phase: u5 * Math.PI * 2,
    sway: cfg.swayMin + u4 * (cfg.swayMax - cfg.swayMin),
  };
}

/**
 * Advances one particle by `dt` seconds and keeps it inside a moving window:
 * flakes past the sides wrap around, anything that leaves the bottom respawns
 * near the top of the CURRENT box — so particles follow the hand window
 * instead of stranding outside it (the box changes every frame while the
 * hands move).
 */
export function stepParticle(p: Particle, dt: number, box: Box, rng: Rng): void {
  p.x += p.vx * dt;
  p.y += p.vy * dt;
  p.phase += dt * 1.7;

  if (box.width > 0) {
    const right = box.x + box.width;
    while (p.x < box.x) p.x += box.width;
    while (p.x > right) p.x -= box.width;
  }

  if (p.y > box.y + box.height + 8) {
    p.y = box.y - 4 - rng() * box.height * 0.1;
    if (box.width > 0) p.x = box.x + rng() * box.width;
  }
}

/* ── Engine (DOM canvas) ─────────────────────────────────────────────────── */

export type EffectFrame = {
  /** The live camera element to sample. */
  video: HTMLVideoElement;
  /** Window/stage size in css px (the canvas is sized to fill it). */
  width: number;
  height: number;
  /** Video intrinsic px the corners are expressed in (the snapshot's). */
  videoWidth: number;
  videoHeight: number;
  /** The four window corners in video px (mirrored display space). */
  corners: Point[];
  /** performance.now() of this snapshot. */
  now: number;
};

/** Live counters surfaced by the DebugOverlay (idle defaults when no engine). */
export type EffectStats = {
  effect: string;
  /** Blur radius actually applied this frame, css px (0 for non-blur). */
  blurRadius: number;
  /** Feather width at the window edge, css px. */
  feather: number;
  particles: number;
  /** Smoothed effect passes per second. */
  fps: number;
  /** Duration of the last full pass, ms. */
  lastMs: number;
};

export const effectStats: EffectStats = {
  effect: "",
  blurRadius: 0,
  feather: 0,
  particles: 0,
  fps: 0,
  lastMs: 0,
};

type Band = { y: number; h: number; dx: number; tint: boolean; invert: boolean };
/** A torn mosaic chunk: copied from the clean frame to a displaced spot. */
type Block = { sx: number; sy: number; w: number; h: number; dx: number; dy: number; invert: boolean };

/**
 * Renders one effect over the live camera inside the hand window.
 *
 * Lifecycle: created per (effect id, blur level) by MediaLayer, called from
 * the engine's snapshot subscription (no separate rAF), disposed on mode
 * change or unmount. One main canvas (React-owned) + one reusable scratch
 * canvas; all caches are dropped on resize/dispose so nothing leaks across
 * effect switches.
 *
 * Per pass: base camera (cover + mirror matrix, one drawImage) → effect
 * (blur pass / particles / grading overlays / glitch bands) → feather mask
 * (inset polygon with blurred alpha, destination-in). The CSS clip-path on
 * the wrapper stays the only geometric cut; the canvas is never transformed.
 */
export class EffectEngine {
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly scratch: HTMLCanvasElement;
  private readonly sctx: CanvasRenderingContext2D;
  private readonly effectId: string;
  private readonly params: EffectParams;

  private particles: Particle[] = [];
  private lastDraw = 0;
  private lastStep = 0;
  private lastPolygon: Point[] | null = null;

  // Cached decorations (rebuilt on canvas resize).
  private duotone: CanvasGradient | null = null;
  private duotoneKey = "";
  private scanPattern: CanvasPattern | null = null;
  private scanPeriod = 0;
  private comicPattern: CanvasPattern | null = null;
  private comicPeriod = 0;
  /** Drifting mist blobs, built once per engine (fog only). */
  private fogBlobs: Array<{
    ox: number;
    oy: number;
    r: number;
    speed: number;
    phase: number;
    alpha: number;
  }> | null = null;

  // Glitch burst timing (device px bands, ms clock).
  private glitchEnd = -Infinity;
  private glitchNext = 0;
  private glitchBands: Band[] = [];
  private glitchBlocks: Block[] = [];
  /** True device scale of the last fit(); new geometry is tuned in css px. */
  private scale = 1;

  // Rain lightning: strike schedule + the bolt drawn for the first beat.
  private nextStrike = 0;
  private strikeAt = -Infinity;
  private bolt: Point[] | null = null;

  // Snow wind gusts: push windows with a smooth bell envelope.
  private gustStart = -Infinity;
  private gustEnd = -Infinity;
  private gustNext = 0;

  // Comic speed-lines: periodic bursts from a fixed focus point.
  private linesStart = -Infinity;
  private linesEnd = -Infinity;
  private linesNext = 0;
  private lineAngles: number[] = [];
  private lineFocus: Point = { x: 0, y: 0 };

  // Cyberpunk chromatic aberration: two channel-isolated frame copies.
  private tempA: { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } | null = null;
  private tempB: { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } | null = null;

  constructor(canvas: HTMLCanvasElement, effectId: string, level: BlurLevel = "medium") {
    const ctx = canvas.getContext("2d");
    const scratch = document.createElement("canvas");
    const sctx = scratch.getContext("2d");
    if (!ctx || !sctx) {
      throw new Error("[EffectEngine] canvas 2d context unavailable");
    }
    this.canvas = canvas;
    this.ctx = ctx;
    this.scratch = scratch;
    this.sctx = sctx;
    this.effectId = effectId;
    this.params = effectParams(effectId, level);
  }

  /** One snapshot-driven pass. Cheap no-ops while the window is still. */
  render(frame: EffectFrame): void {
    const { video, width, height, videoWidth, videoHeight, corners, now } = frame;
    if (!(width > 0) || !(height > 0)) return;
    if (corners.length !== 4 || !(videoWidth > 0) || !(videoHeight > 0)) {
      this.clear();
      return;
    }

    const scale = this.fit(width, height);
    const polygon = stagePolygonPoints(corners, videoWidth, videoHeight).map((p) => ({
      x: p.x * width,
      y: p.y * height,
    }));

    // Hold the last frame between passes (updateRate), but always re-render
    // when the window moved — a stale feather would show inside the clip.
    const due = now - this.lastDraw >= 1000 / this.params.updateRate;
    if (!due && !this.polygonMoved(polygon)) return;

    const t0 = performance.now();
    this.drawBase(video, videoWidth, videoHeight, width, height, scale);
    this.applyEffect(polygon, width, height, scale, now);
    this.applyFeather(polygon, width, scale);

    const gap = now - this.lastDraw;
    this.lastDraw = now;
    this.lastPolygon = polygon;
    effectStats.effect = this.effectId;
    effectStats.blurRadius =
      this.effectId === "blur" ? round1(scaledPx(this.params.blurRadius, width)) : 0;
    effectStats.feather = round1(scaledPx(this.params.edgeFeather, width));
    effectStats.particles = this.particles.length;
    effectStats.lastMs = round1(performance.now() - t0);
    if (gap > 0 && gap < 1000) {
      effectStats.fps = Math.round(effectStats.fps + (1000 / gap - effectStats.fps) * 0.2);
    }
  }

  /** Blank the canvas (no window this frame). */
  clear(): void {
    const ctx = this.ctx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.filter = "none";
    ctx.globalCompositeOperation = "source-over";
    ctx.globalAlpha = 1;
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    this.lastPolygon = null;
  }

  /** Release every buffer and cache; safe to call twice. */
  dispose(): void {
    this.particles = [];
    this.glitchBands = [];
    this.glitchBlocks = [];
    this.bolt = null;
    this.lineAngles = [];
    this.tempA = null;
    this.tempB = null;
    this.lastPolygon = null;
    this.duotone = null;
    this.scanPattern = null;
    this.comicPattern = null;
    this.fogBlobs = null;
    this.canvas.width = 0;
    this.canvas.height = 0;
    effectStats.effect = "";
    effectStats.blurRadius = 0;
    effectStats.feather = 0;
    effectStats.particles = 0;
    effectStats.fps = 0;
    effectStats.lastMs = 0;
  }

  /* ── passes ───────────────────────────────────────────────────────────── */

  /** Sizes the backing store (dpr ≤ 2, capped) and returns the true scale. */
  private fit(cssW: number, cssH: number): number {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    let scale = dpr;
    if (cssW * scale > 1600) scale = 1600 / cssW;
    const w = Math.max(1, Math.round(cssW * scale));
    const h = Math.max(1, Math.round(cssH * scale));
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
      this.lastPolygon = null; // realloc clears the bitmap → force a full pass
      this.duotone = null;
      this.duotoneKey = "";
      this.scanPattern = null;
      this.scanPeriod = 0;
      this.comicPattern = null;
      this.comicPeriod = 0;
    }
    this.scale = w / cssW;
    return this.scale;
  }

  private polygonMoved(polygon: Point[]): boolean {
    const last = this.lastPolygon;
    if (!last || last.length !== polygon.length) return true;
    let total = 0;
    for (let i = 0; i < polygon.length; i++) {
      total += Math.abs(polygon[i].x - last[i].x) + Math.abs(polygon[i].y - last[i].y);
    }
    return total > 1.5; // sub-pixel drift never forces a re-render
  }

  private ensureScratch(w: number, h: number): void {
    if (this.scratch.width !== w || this.scratch.height !== h) {
      this.scratch.width = w;
      this.scratch.height = h;
    }
  }

  /** Lazily create/resize one channel-isolation canvas (chromatic aberration). */
  private reuseChannelTemp(
    temp: { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } | null,
    w: number,
    h: number
  ): { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } | null {
    if (temp && temp.canvas.width === w && temp.canvas.height === h) return temp;
    const canvas = temp?.canvas ?? document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    return { canvas, ctx };
  }

  /** The camera frame itself: cover + mirror through one matrix, one draw. */
  private drawBase(
    video: HTMLVideoElement,
    videoWidth: number,
    videoHeight: number,
    cssW: number,
    cssH: number,
    scale: number
  ): void {
    const ctx = this.ctx;
    const sw = this.canvas.width;
    const sh = this.canvas.height;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalCompositeOperation = "source-over";
    ctx.globalAlpha = 1;
    ctx.clearRect(0, 0, sw, sh);
    const m = cameraCoverTransform(cssW, cssH, videoWidth, videoHeight);
    ctx.setTransform(m.a * scale, m.b * scale, m.c * scale, m.d * scale, m.e * scale, m.f * scale);
    // Cyberpunk's colour grade belongs to the camera draw itself, so it
    // processes real pixels (the old CSS backdrop-filter could not). Comic
    // gets its vivid print contrast the same way, before the cell pass.
    ctx.filter =
      this.effectId === "cyberpunk"
        ? "saturate(1.7) contrast(1.25) hue-rotate(-12deg)"
        : this.effectId === "comic"
          ? "saturate(1.6) contrast(1.7)"
          : "none";
    ctx.drawImage(video, 0, 0, videoWidth, videoHeight);
    ctx.filter = "none";
    ctx.setTransform(1, 0, 0, 1, 0, 0);
  }

  private applyEffect(polygon: Point[], cssW: number, cssH: number, scale: number, now: number): void {
    switch (this.effectId) {
      case "blur":
        this.blurPass(cssW, scale);
        break;
      case "rain":
        this.particlePass("rain", polygon, cssW, cssH, scale, now);
        break;
      case "snow":
        this.particlePass("snow", polygon, cssW, cssH, scale, now);
        break;
      case "fog":
        this.fogPass(cssW, cssH, scale, now);
        break;
      case "cyberpunk":
        this.cyberPass(scale, now);
        break;
      case "glitch":
        this.glitchPass(scale, now);
        break;
      case "comic":
        this.comicPass(scale, now);
        break;
      case "ascii-live":
      case "ascii-matrix":
      case "ascii-rgb":
      case "ascii-trail":
      case "ascii-holo":
        this.asciiPass(this.effectId.replace("ascii-", "") as AsciiVariant, cssW, cssH, scale, now);
        break;
      case "thermal":
        this.thermalPass(scale);
        break;
      case "film":
        this.filmPass(scale, now);
        break;
      case "heat":
        this.heatPass(scale, now);
        break;
      case "holo":
        this.holoPass(scale, now);
        break;
      case "neon":
        this.neonPass(scale);
        break;
      case "particles":
        this.burstParticlePass(polygon, cssW, cssH, scale, now);
        break;
      case "portal":
        this.portalEffectPass(scale, now);
        break;
    }
  }

  /**
   * Blurs the camera pixels. The strong level renders through a half-size
   * offscreen (≈¼ the filter cost) and lets the upscale add softness — that
   * is what `blurQuality: "low"` buys.
   */
  private blurPass(cssW: number, scale: number): void {
    const ctx = this.ctx;
    const sw = this.canvas.width;
    const sh = this.canvas.height;
    const radius = scaledPx(this.params.blurRadius, cssW) * scale;
    if (radius < 0.5) return;
    this.ensureScratch(sw, sh);
    const sctx = this.sctx;
    sctx.setTransform(1, 0, 0, 1, 0, 0);
    sctx.filter = "none";

    if (this.params.blurQuality === "low") {
      // Half-res pass drawn into the TOP-LEFT REGION of the full-size
      // scratch — the canvas never reallocates (a resize would clear it and
      // cost an allocation per frame).
      const w2 = Math.max(1, sw >> 1);
      const h2 = Math.max(1, sh >> 1);
      sctx.clearRect(0, 0, w2, h2);
      sctx.filter = `blur(${(radius * 0.5).toFixed(1)}px)`;
      sctx.drawImage(ctx.canvas, 0, 0, sw, sh, 0, 0, w2, h2);
      sctx.filter = "none";
      ctx.clearRect(0, 0, sw, sh);
      ctx.imageSmoothingQuality = "high";
      ctx.drawImage(this.scratch, 0, 0, w2, h2, 0, 0, sw, sh);
      ctx.imageSmoothingQuality = "medium";
    } else {
      sctx.clearRect(0, 0, sw, sh);
      sctx.drawImage(ctx.canvas, 0, 0); // clean base for the filter pass
      ctx.clearRect(0, 0, sw, sh);
      ctx.filter = `blur(${radius.toFixed(1)}px)`;
      ctx.drawImage(this.scratch, 0, 0);
      ctx.filter = "none";
    }
  }

  /**
   * Rain/snow over the sharp camera: particles live in stage css px (the
   * mirror is already baked into the base), spawn inside the window's bounding
   * box and respawn relative to its CURRENT position, so they follow the
   * hands instead of stranding outside the window.
   */
  private particlePass(
    kind: "rain" | "snow",
    polygon: Point[],
    cssW: number,
    cssH: number,
    scale: number,
    now: number
  ): void {
    const box = boundingBox(polygon);
    if (box.width < 24 || box.height < 24) return;
    if (this.particles.length !== this.params.particleCount) this.seed(box, cssH);
    if (this.particles.length === 0) return;

    // Snow wind gusts: schedule the next push (or evaluate the running one).
    let gustEnv = 0;
    if (kind === "snow") {
      if (now >= this.gustEnd) {
        if (now >= this.gustNext) {
          this.gustStart = now;
          this.gustEnd =
            now +
            GUST_TIMING.activeMinMs +
            Math.random() * (GUST_TIMING.activeMaxMs - GUST_TIMING.activeMinMs);
          this.gustNext =
            this.gustEnd +
            GUST_TIMING.restMinMs +
            Math.random() * (GUST_TIMING.restMaxMs - GUST_TIMING.restMinMs);
        }
      } else {
        const progress = (now - this.gustStart) / Math.max(1, this.gustEnd - this.gustStart);
        gustEnv = 0.5 - 0.5 * Math.cos(Math.PI * 2 * progress); // smooth bell 0→1→0
      }
    }

    const dt = this.lastStep === 0 ? 0 : Math.max(0, (now - this.lastStep) / 1000);
    this.lastStep = now;
    for (const p of this.particles) {
      stepParticle(p, dt, box, Math.random);
      if (gustEnv > 0) {
        // Near flakes ride the gust harder than far ones (depth parallax).
        p.x += GUST_TIMING.strength * cssH * gustEnv * (0.3 + p.depth) * dt;
      }
    }

    const k = scaledPx(1, cssW);
    const ctx = this.ctx;
    ctx.setTransform(scale, 0, 0, scale, 0, 0); // draw in css px
    if (kind === "rain") {
      ctx.lineCap = "round";
      for (const p of this.particles) {
        const trail = 0.018 * (0.5 + p.depth); // streak points back along the velocity
        ctx.strokeStyle = `rgba(190, 225, 255, ${p.alpha.toFixed(3)})`;
        ctx.lineWidth = Math.max(1, p.size * k);
        ctx.beginPath();
        ctx.moveTo(p.x - p.vx * trail, p.y - p.vy * trail);
        ctx.lineTo(p.x, p.y);
        ctx.stroke();
      }
      this.lightningDraw(cssW, cssH, now, ctx);
    } else {
      const swayMul = 1 + 1.2 * gustEnv; // gusts also whip the sway
      for (const p of this.particles) {
        const x = p.x + Math.sin(p.phase) * p.sway * swayMul * k;
        ctx.globalAlpha = p.alpha;
        ctx.fillStyle = "#ffffff";
        ctx.beginPath();
        ctx.arc(x, p.y, Math.max(0.75, p.size * k), 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalAlpha = 1;
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
  }

  /**
   * Rain's showpiece: a rare strike with a glowing bolt (first beat) and a
   * double-pulse white flash over the whole frame. Called with the css-px
   * transform active.
   */
  private lightningDraw(cssW: number, cssH: number, now: number, ctx: CanvasRenderingContext2D): void {
    if (now >= this.nextStrike) {
      this.strikeAt = now;
      this.bolt = generateBolt(cssW, cssH);
      this.nextStrike =
        now +
        LIGHTNING_TIMING.gapMinMs +
        Math.random() * (LIGHTNING_TIMING.gapMaxMs - LIGHTNING_TIMING.gapMinMs);
    }
    const since = now - this.strikeAt;
    if (since < 0 || since >= LIGHTNING_TIMING.flashMs) return;

    if (this.bolt && since < LIGHTNING_TIMING.boltMs) {
      ctx.lineJoin = "round";
      ctx.lineCap = "round";
      ctx.beginPath();
      ctx.moveTo(this.bolt[0].x, this.bolt[0].y);
      for (let i = 1; i < this.bolt.length; i++) ctx.lineTo(this.bolt[i].x, this.bolt[i].y);
      ctx.strokeStyle = "rgba(214, 232, 255, 0.5)";
      ctx.lineWidth = 6;
      ctx.stroke();
      ctx.strokeStyle = "rgba(255, 255, 255, 0.95)";
      ctx.lineWidth = 2;
      ctx.stroke();
    }

    const flash = lightningAlpha(since);
    if (flash > 0) {
      ctx.globalCompositeOperation = "lighter";
      ctx.fillStyle = `rgba(255, 255, 255, ${flash.toFixed(3)})`;
      ctx.fillRect(0, 0, cssW, cssH);
      ctx.globalCompositeOperation = "source-over";
    }
  }

  private seed(box: Box, stageHeight: number): void {
    this.particles = [];
    const layers: readonly SnowLayer[] = ["far", "mid", "near"];
    for (let i = 0; i < this.params.particleCount; i++) {
      this.particles.push(
        this.effectId === "rain"
          ? createRainParticle(box, stageHeight, Math.random)
          : createSnowParticle(box, stageHeight, layers[i % layers.length], Math.random)
      );
    }
  }

  /** Duotone wash (screen) + scanlines + slow scan sweep, over the real frame. */
  private cyberPass(scale: number, now: number): void {
    const ctx = this.ctx;
    const sw = this.canvas.width;
    const sh = this.canvas.height;

    // Chromatic aberration FIRST (before grade): red channel shifted one way,
    // cyan the other, screen-blended so the fringes glow like a bad RGB cable.
    this.tempA = this.reuseChannelTemp(this.tempA, sw, sh);
    this.tempB = this.reuseChannelTemp(this.tempB, sw, sh);
    if (this.tempA && this.tempB) {
      const dx = Math.max(2, Math.round(2.5 * scale));
      const a = this.tempA;
      a.ctx.setTransform(1, 0, 0, 1, 0, 0);
      a.ctx.globalCompositeOperation = "source-over";
      a.ctx.clearRect(0, 0, sw, sh);
      a.ctx.drawImage(ctx.canvas, 0, 0);
      a.ctx.globalCompositeOperation = "multiply";
      a.ctx.fillStyle = "#ff0000";
      a.ctx.fillRect(0, 0, sw, sh);

      const b = this.tempB;
      b.ctx.setTransform(1, 0, 0, 1, 0, 0);
      b.ctx.globalCompositeOperation = "source-over";
      b.ctx.clearRect(0, 0, sw, sh);
      b.ctx.drawImage(ctx.canvas, 0, 0);
      b.ctx.globalCompositeOperation = "multiply";
      b.ctx.fillStyle = "#00ffff";
      b.ctx.fillRect(0, 0, sw, sh);

      ctx.globalCompositeOperation = "lighter";
      ctx.globalAlpha = 0.5;
      ctx.drawImage(a.canvas, -dx, 0);
      ctx.drawImage(b.canvas, dx, 0);
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = "source-over";
    }

    const key = `${sw}x${sh}`;
    if (this.duotoneKey !== key || !this.duotone) {
      // CSS `linear-gradient(120deg, …)` → direction vector in canvas space.
      const vx = Math.sin((120 * Math.PI) / 180);
      const vy = -Math.cos((120 * Math.PI) / 180);
      const half = (Math.abs(sw * vx) + Math.abs(sh * vy)) / 2;
      const g = ctx.createLinearGradient(
        sw / 2 - vx * half,
        sh / 2 - vy * half,
        sw / 2 + vx * half,
        sh / 2 + vy * half
      );
      g.addColorStop(0, "rgba(255, 0, 153, 0.32)");
      g.addColorStop(0.45, "rgba(255, 0, 153, 0)");
      g.addColorStop(1, "rgba(0, 255, 240, 0.3)");
      this.duotone = g;
      this.duotoneKey = key;
    }
    ctx.globalCompositeOperation = "screen";
    ctx.fillStyle = this.duotone;
    ctx.fillRect(0, 0, sw, sh);

    const period = Math.max(2, Math.round(3 * scale));
    if (!this.scanPattern || this.scanPeriod !== period) {
      const tile = document.createElement("canvas");
      tile.width = 1;
      tile.height = period;
      const tctx = tile.getContext("2d");
      if (tctx) {
        tctx.fillStyle = "rgba(0, 0, 0, 0.28)";
        tctx.fillRect(0, 0, 1, Math.max(1, Math.round(scale)));
        this.scanPattern = ctx.createPattern(tile, "repeat");
        this.scanPeriod = period;
      }
    }
    if (this.scanPattern) {
      ctx.globalCompositeOperation = "source-over";
      ctx.fillStyle = this.scanPattern;
      ctx.fillRect(0, 0, sw, sh);
    }

    const t = (now % 3200) / 3200;
    const bandH = 0.18 * sh;
    const y = (-0.2 + t * 1.3) * sh;
    const sweep = ctx.createLinearGradient(0, y, 0, y + bandH);
    sweep.addColorStop(0, "rgba(125, 211, 252, 0)");
    sweep.addColorStop(0.5, "rgba(125, 211, 252, 0.25)");
    sweep.addColorStop(1, "rgba(125, 211, 252, 0)");
    ctx.globalCompositeOperation = "screen";
    ctx.fillStyle = sweep;
    ctx.fillRect(0, y, sw, bandH);
    ctx.globalCompositeOperation = "source-over";
  }

  /**
   * Natural fog: a faint base haze plus eight large soft mist blobs drifting
   * on slow independent paths, composited over the real frame (source-over,
   * low alpha) — no repeating tiles, no seams when the window moves.
   */
  private fogPass(cssW: number, cssH: number, scale: number, now: number): void {
    if (!this.fogBlobs) {
      this.fogBlobs = Array.from({ length: 8 }, () => ({
        ox: Math.random(),
        oy: Math.random() * 0.8,
        r: 0.35 + Math.random() * 0.3,
        speed: 0.00004 + Math.random() * 0.0001, // rad/ms — full drift cycle in ~minutes
        phase: Math.random() * Math.PI * 2,
        alpha: 0.05 + Math.random() * 0.06,
      }));
    }
    const ctx = this.ctx;
    ctx.setTransform(scale, 0, 0, scale, 0, 0); // draw in css px
    ctx.fillStyle = "rgba(230, 235, 243, 0.05)";
    ctx.fillRect(0, 0, cssW, cssH);
    const maxDim = Math.max(cssW, cssH);
    for (const b of this.fogBlobs) {
      const x = (b.ox + Math.sin(now * b.speed + b.phase) * 0.18) * cssW;
      const y = (b.oy + Math.cos(now * b.speed * 0.7 + b.phase * 1.3) * 0.1) * cssH;
      const radius = b.r * maxDim;
      const g = ctx.createRadialGradient(x, y, 0, x, y, radius);
      g.addColorStop(0, `rgba(238, 242, 248, ${b.alpha.toFixed(3)})`);
      g.addColorStop(1, "rgba(238, 242, 248, 0)");
      ctx.fillStyle = g;
      ctx.fillRect(x - radius, y - radius, radius * 2, radius * 2);
    }

    // Light shafts: soft beams swaying slowly over the mist (screen, so they
    // lift the frame instead of painting on it).
    ctx.globalCompositeOperation = "screen";
    const reach = Math.hypot(cssW, cssH);
    for (let i = 0; i < SHAFT_TUNING.count; i++) {
      const sway = Math.sin((now / SHAFT_TUNING.swayMs) * Math.PI * 2 + i * 2.1) * 0.07;
      const angle = (i - (SHAFT_TUNING.count - 1) / 2) * 0.3 + sway;
      const bw = cssW * SHAFT_TUNING.widthFrac;
      const cx = cssW * (0.2 + (i / Math.max(1, SHAFT_TUNING.count - 1)) * 0.6);
      ctx.save();
      ctx.translate(cx, -reach * 0.1);
      ctx.rotate(angle);
      const beam = ctx.createLinearGradient(-bw / 2, 0, bw / 2, 0);
      beam.addColorStop(0, "rgba(255, 251, 235, 0)");
      beam.addColorStop(0.5, `rgba(255, 251, 235, ${SHAFT_TUNING.alpha})`);
      beam.addColorStop(1, "rgba(255, 251, 235, 0)");
      ctx.fillStyle = beam;
      ctx.fillRect(-bw / 2, 0, bw, reach * 1.2);
      ctx.restore();
    }
    ctx.globalCompositeOperation = "source-over";
    ctx.setTransform(1, 0, 0, 1, 0, 0);
  }

  /**
   * Comic: quantise the graded frame into ~5 css px cells (downscale →
   * nearest-neighbour upscale) and multiply a cached halftone dot grid over
   * it — posterised print blocks with an ink-screen texture.
   */
  private comicPass(scale: number, now: number): void {
    const ctx = this.ctx;
    const sw = this.canvas.width;
    const sh = this.canvas.height;
    const step = Math.max(2, Math.round(5 * scale)); // cell size, device px
    const w2 = Math.max(1, Math.round(sw / step));
    const h2 = Math.max(1, Math.round(sh / step));

    this.ensureScratch(sw, sh);
    const sctx = this.sctx;
    sctx.setTransform(1, 0, 0, 1, 0, 0);
    sctx.filter = "none";
    sctx.clearRect(0, 0, w2, h2);
    sctx.drawImage(ctx.canvas, 0, 0, sw, sh, 0, 0, w2, h2);

    ctx.clearRect(0, 0, sw, sh);
    ctx.imageSmoothingEnabled = false; // hard cells, not a soft downscale
    ctx.drawImage(this.scratch, 0, 0, w2, h2, 0, 0, sw, sh);
    ctx.imageSmoothingEnabled = true;

    const period = Math.max(4, Math.round(4 * scale));
    if (!this.comicPattern || this.comicPeriod !== period) {
      const tile = document.createElement("canvas");
      tile.width = period;
      tile.height = period;
      const tctx = tile.getContext("2d");
      if (tctx) {
        tctx.fillStyle = "rgba(18, 14, 26, 0.5)";
        tctx.beginPath();
        tctx.arc(period * 0.25, period * 0.25, period * 0.2, 0, Math.PI * 2);
        tctx.fill();
        tctx.beginPath();
        tctx.arc(period * 0.75, period * 0.75, period * 0.2, 0, Math.PI * 2);
        tctx.fill();
        this.comicPattern = ctx.createPattern(tile, "repeat");
        this.comicPeriod = period;
      }
    }
    if (this.comicPattern) {
      ctx.globalCompositeOperation = "multiply";
      ctx.globalAlpha = 0.6;
      ctx.fillStyle = this.comicPattern;
      ctx.fillRect(0, 0, sw, sh);
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = "source-over";
    }

    // Manga speed-lines: periodic bursts of radial focus lines, fading in and out.
    if (now >= this.linesEnd && now >= this.linesNext) this.startComicLines(now, sw, sh);
    if (this.lineAngles.length > 0 && now >= this.linesStart && now < this.linesEnd) {
      const progress = (now - this.linesStart) / Math.max(1, this.linesEnd - this.linesStart);
      const fade = Math.sin(Math.PI * progress); // smooth 0 → 1 → 0
      if (fade > 0.02) {
        const R = Math.hypot(sw, sh);
        const r0 = R * 0.25;
        ctx.strokeStyle = `rgba(18, 14, 26, ${(0.45 * fade).toFixed(3)})`;
        ctx.lineWidth = Math.max(1, Math.round(2 * scale));
        ctx.beginPath();
        for (const angle of this.lineAngles) {
          const cos = Math.cos(angle);
          const sin = Math.sin(angle);
          ctx.moveTo(this.lineFocus.x + cos * r0, this.lineFocus.y + sin * r0);
          ctx.lineTo(this.lineFocus.x + cos * R, this.lineFocus.y + sin * R);
        }
        ctx.stroke();
      }
    }
  }

  private startComicLines(now: number, sw: number, sh: number): void {
    const T = COMIC_LINES_TIMING;
    this.lineFocus = {
      x: sw * (0.3 + Math.random() * 0.4),
      y: sh * (0.3 + Math.random() * 0.4),
    };
    this.lineAngles = Array.from({ length: T.count }, (_, i) => {
      const base = (Math.PI * 2 * i) / T.count;
      return base + (Math.random() - 0.5) * ((Math.PI * 2) / T.count) * 0.8;
    });
    this.linesStart = now;
    this.linesEnd = now + T.activeMs;
    this.linesNext =
      this.linesEnd +
      T.everyMinMs +
      Math.random() * (T.everyMaxMs - T.everyMinMs);
  }

  /**
   * Displaced slices torn out of the CURRENT frame, plus mosaic corruption,
   * inverted bands and static rows — the content glitches, not a rectangle
   * floating above it (the cleared band lets the raw camera show through).
   * Bursts follow GLITCH_TIMING: frequent and punchy.
   */
  private glitchPass(scale: number, now: number): void {
    if (now >= this.glitchEnd) {
      if (now >= this.glitchNext) this.startGlitch(now);
      else return; // idle between bursts — the sharp base is already correct
    }
    if (Math.floor(now / 90) % 8 === 5) return; // steps-style flicker beat

    const sw = this.canvas.width;
    const sh = this.canvas.height;
    this.ensureScratch(sw, sh);
    const sctx = this.sctx;
    sctx.setTransform(1, 0, 0, 1, 0, 0);
    sctx.filter = "none";
    sctx.globalCompositeOperation = "source-over";
    sctx.clearRect(0, 0, sw, sh);
    sctx.drawImage(this.canvas, 0, 0); // clean base for every tear below

    const ctx = this.ctx;

    // 1) full-width slices, shifted sideways (tinted or inverted)
    for (const band of this.glitchBands) {
      const y = Math.max(0, Math.round(band.y));
      const h = Math.max(2, Math.min(sh - y, Math.round(band.h)));
      ctx.clearRect(0, y, sw, h);
      ctx.filter = band.invert ? "invert(1)" : band.tint ? "hue-rotate(90deg)" : "none";
      ctx.drawImage(this.scratch, 0, y, sw, h, Math.round(band.dx), y, sw, h);
      ctx.filter = "none";
    }

    // 2) mosaic corruption: chunks of the clean frame torn somewhere else
    for (const b of this.glitchBlocks) {
      const bw = Math.min(sw, Math.max(2, Math.round(b.w)));
      const bh = Math.min(sh, Math.max(2, Math.round(b.h)));
      const sx = Math.max(0, Math.min(sw - bw, Math.round(b.sx)));
      const sy = Math.max(0, Math.min(sh - bh, Math.round(b.sy)));
      ctx.filter = b.invert ? "invert(1)" : "none";
      ctx.drawImage(this.scratch, sx, sy, bw, bh, sx + Math.round(b.dx), sy + Math.round(b.dy), bw, bh);
      ctx.filter = "none";
    }

    // 3) static rows flickering across the frame
    for (let i = 0; i < GLITCH_TIMING.noiseRows; i++) {
      const y = Math.floor(Math.random() * sh);
      const h = Math.max(1, Math.round((1 + Math.random() * 3) * scale));
      ctx.fillStyle = Math.random() < 0.5 ? "rgba(255, 255, 255, 0.35)" : "rgba(10, 8, 16, 0.4)";
      ctx.fillRect(0, y, sw, h);
    }
  }

  private startGlitch(now: number): void {
    const rng = Math.random;
    const schedule = glitchSchedule(now, rng);
    this.glitchEnd = schedule.end;
    this.glitchNext = schedule.next;

    const wMax = this.canvas.width;
    const hMax = this.canvas.height;
    const T = GLITCH_TIMING;

    this.glitchBands = [];
    const bandCount = T.bandsMin + Math.floor(rng() * (T.bandsMax - T.bandsMin + 1));
    for (let i = 0; i < bandCount; i++) {
      const h = 6 + rng() * Math.max(10, hMax * 0.08);
      this.glitchBands.push({
        y: rng() * Math.max(1, hMax - h),
        h,
        dx: (rng() < 0.5 ? -1 : 1) * (4 + rng() * T.shiftMaxPx) * this.scale,
        tint: rng() < T.tintChance,
        invert: rng() < T.invertChance,
      });
    }

    this.glitchBlocks = [];
    const blockCount = T.blocksMin + Math.floor(rng() * (T.blocksMax - T.blocksMin + 1));
    for (let i = 0; i < blockCount; i++) {
      const bw = (16 + rng() * 70) * this.scale;
      const bh = (8 + rng() * 34) * this.scale;
      this.glitchBlocks.push({
        sx: rng() * Math.max(1, wMax - bw),
        sy: rng() * Math.max(1, hMax - bh),
        w: bw,
        h: bh,
        dx: (rng() < 0.5 ? -1 : 1) * (10 + rng() * 50) * this.scale,
        dy: (rng() < 0.5 ? -1 : 1) * (4 + rng() * 16) * this.scale,
        invert: rng() < T.invertChance,
      });
    }
  }

  /* ── New effects (Phase C + D) ─────────────────────────────────────────── */

  /**
   * Shared ASCII renderer: downsample camera → luminance → ramp char → draw.
   * All five ASCII variants use this one pipeline; only the palette and
   * optional overlays differ.
   */
  private asciiPass(variant: AsciiVariant, cssW: number, cssH: number, scale: number, now: number): void {
    const ctx = this.ctx;
    const sw = this.canvas.width;
    const sh = this.canvas.height;
    const palette = asciiPalette(variant);
    const { cellW: cellWCss, cellH: cellHCss } = asciiCellSize(cssW, 80);
    const cellW = Math.max(2, Math.round(cellWCss * scale));
    const cellH = Math.max(2, Math.round(cellHCss * scale));
    const { cols, rows } = asciiGridForStage(sw, sh, cellW, cellH);
    if (cols < 1 || rows < 1) return;

    // Downsample the base frame to a tiny canvas (one pixel per cell).
    const sampleW = cols;
    const sampleH = rows;
    this.ensureScratch(Math.max(sampleW, this.scratch.width), Math.max(sampleH, this.scratch.height));
    const sctx = this.sctx;
    sctx.setTransform(1, 0, 0, 1, 0, 0);
    sctx.filter = "none";
    sctx.clearRect(0, 0, sampleW, sampleH);
    sctx.drawImage(ctx.canvas, 0, 0, sw, sh, 0, 0, sampleW, sampleH);

    // Read pixel data (graceful fallback if getImageData is blocked).
    let data: Uint8ClampedArray;
    try {
      data = sctx.getImageData(0, 0, sampleW, sampleH).data;
    } catch {
      // Tainted canvas or security error — fall back to showing the base frame.
      return;
    }

    // Fill background.
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalCompositeOperation = "source-over";
    ctx.globalAlpha = 1;
    ctx.fillStyle = palette.bg;
    ctx.fillRect(0, 0, sw, sh);

    // Draw characters.
    const fontSize = Math.max(6, Math.round(cellH * 0.85));
    ctx.font = `${fontSize}px "Courier New", monospace`;
    ctx.textBaseline = "top";
    for (let row = 0; row < rows; row++) {
      for (let col = 0; col < cols; col++) {
        const idx = (row * sampleW + col) * 4;
        const r = data[idx];
        const g = data[idx + 1];
        const b = data[idx + 2];
        const rampIdx = asciiRampIndex(r, g, b);
        const ch = ASCII_RAMP[rampIdx];
        if (ch === " ") continue; // skip blank cells for performance

        if (isAccentChar(rampIdx)) {
          ctx.fillStyle = palette.accent;
        } else if (palette.useSourceColor) {
          ctx.fillStyle = `rgb(${r},${g},${b})`;
        } else {
          ctx.fillStyle = palette.fg;
        }
        ctx.fillText(ch, col * cellW, row * cellH);
      }
    }

    // Scan-line overlay (holo variant).
    if (palette.scan) {
      const period = Math.max(2, Math.round(3 * scale));
      ctx.fillStyle = palette.scan;
      for (let y = 0; y < sh; y += period) {
        ctx.fillRect(0, y, sw, Math.max(1, Math.round(scale)));
      }
    }

    // RGB chromatic split overlay for ascii-rgb variant.
    if (variant === "rgb") {
      this.asciiRgbSplit(sw, sh, scale, now);
    }
  }

  /** RGB ASCII variant: three channel-isolated copies at slight offsets. */
  private asciiRgbSplit(sw: number, sh: number, scale: number, now: number): void {
    const ctx = this.ctx;
    const dx = Math.max(2, Math.round(2 * scale));
    this.tempA = this.reuseChannelTemp(this.tempA, sw, sh);
    this.tempB = this.reuseChannelTemp(this.tempB, sw, sh);
    if (!this.tempA || !this.tempB) return;

    const a = this.tempA;
    a.ctx.setTransform(1, 0, 0, 1, 0, 0);
    a.ctx.globalCompositeOperation = "source-over";
    a.ctx.clearRect(0, 0, sw, sh);
    a.ctx.drawImage(ctx.canvas, 0, 0);
    a.ctx.globalCompositeOperation = "multiply";
    a.ctx.fillStyle = "#ff0000";
    a.ctx.fillRect(0, 0, sw, sh);

    const b = this.tempB;
    b.ctx.setTransform(1, 0, 0, 1, 0, 0);
    b.ctx.globalCompositeOperation = "source-over";
    b.ctx.clearRect(0, 0, sw, sh);
    b.ctx.drawImage(ctx.canvas, 0, 0);
    b.ctx.globalCompositeOperation = "multiply";
    b.ctx.fillStyle = "#00ffff";
    b.ctx.fillRect(0, 0, sw, sh);

    ctx.globalCompositeOperation = "lighter";
    ctx.globalAlpha = 0.4;
    ctx.drawImage(a.canvas, -dx, 0);
    ctx.drawImage(b.canvas, dx, 0);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = "source-over";
  }

  /** Thermal: false-colour heat map from luminance (blue → red → white). */
  private thermalPass(scale: number): void {
    const ctx = this.ctx;
    const sw = this.canvas.width;
    const sh = this.canvas.height;
    const sampleW = Math.max(1, sw >> 2);
    const sampleH = Math.max(1, sh >> 2);

    this.ensureScratch(Math.max(sampleW, this.scratch.width), Math.max(sampleH, this.scratch.height));
    const sctx = this.sctx;
    sctx.setTransform(1, 0, 0, 1, 0, 0);
    sctx.clearRect(0, 0, sampleW, sampleH);
    sctx.drawImage(ctx.canvas, 0, 0, sw, sh, 0, 0, sampleW, sampleH);

    let data: Uint8ClampedArray;
    try {
      data = sctx.getImageData(0, 0, sampleW, sampleH).data;
    } catch {
      return;
    }

    // Build a thermal colour lookup (256 entries).
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.imageSmoothingEnabled = true;
    const out = sctx; // reuse scratch for the colourised version
    out.setTransform(1, 0, 0, 1, 0, 0);
    out.globalCompositeOperation = "source-over";
    out.clearRect(0, 0, sampleW, sampleH);

    for (let i = 0; i < data.length; i += 4) {
      const lum = 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2];
      const t = lum / 255;
      // Blue → purple → red → orange → white
      const r = Math.min(255, Math.round(t * 3 * 255));
      const g = Math.max(0, Math.min(255, Math.round((t - 0.33) * 3 * 255)));
      const b = Math.max(0, Math.min(255, Math.round((1 - t * 2) * 255)));
      data[i] = r;
      data[i + 1] = g;
      data[i + 2] = b;
      data[i + 3] = 255;
    }
    out.putImageData(new ImageData(data as unknown as Uint8ClampedArray<ArrayBuffer>, sampleW, sampleH), 0, 0);

    // Upscale back to full size.
    ctx.clearRect(0, 0, sw, sh);
    ctx.drawImage(this.scratch, 0, 0, sampleW, sampleH, 0, 0, sw, sh);
  }

  /** Film: grain noise + vignette + slight desaturation. */
  private filmPass(scale: number, now: number): void {
    const ctx = this.ctx;
    const sw = this.canvas.width;
    const sh = this.canvas.height;

    // Desaturate slightly.
    this.ensureScratch(sw, sh);
    const sctx = this.sctx;
    sctx.setTransform(1, 0, 0, 1, 0, 0);
    sctx.filter = "saturate(0.7) contrast(1.1)";
    sctx.clearRect(0, 0, sw, sh);
    sctx.drawImage(ctx.canvas, 0, 0);
    sctx.filter = "none";
    ctx.clearRect(0, 0, sw, sh);
    ctx.drawImage(this.scratch, 0, 0);

    // Grain: random dots (drawn at low res then upscaled for softness).
    const grainW = Math.max(1, sw >> 1);
    const grainH = Math.max(1, sh >> 1);
    this.ensureScratch(grainW, grainH);
    sctx.setTransform(1, 0, 0, 1, 0, 0);
    sctx.clearRect(0, 0, grainW, grainH);
    const seed = Math.floor(now / 80); // change grain every ~80 ms
    for (let i = 0; i < grainW * grainH * 0.04; i++) {
      const x = ((seed * 31 + i * 17) % grainW);
      const y = ((seed * 37 + i * 23) % grainH);
      const v = ((seed + i * 13) % 255);
      sctx.fillStyle = `rgba(${v},${v},${v},0.25)`;
      sctx.fillRect(x, y, 2, 2);
    }
    ctx.globalCompositeOperation = "overlay";
    ctx.globalAlpha = 0.35;
    ctx.drawImage(this.scratch, 0, 0, grainW, grainH, 0, 0, sw, sh);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = "source-over";

    // Vignette.
    const g = ctx.createRadialGradient(sw / 2, sh / 2, sw * 0.3, sw / 2, sh / 2, sw * 0.75);
    g.addColorStop(0, "rgba(0,0,0,0)");
    g.addColorStop(1, "rgba(0,0,0,0.45)");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, sw, sh);
  }

  /** Heat: wavy horizontal displacement (heat haze distortion). */
  private heatPass(scale: number, now: number): void {
    const ctx = this.ctx;
    const sw = this.canvas.width;
    const sh = this.canvas.height;

    this.ensureScratch(sw, sh);
    const sctx = this.sctx;
    sctx.setTransform(1, 0, 0, 1, 0, 0);
    sctx.globalCompositeOperation = "source-over";
    sctx.clearRect(0, 0, sw, sh);
    sctx.drawImage(ctx.canvas, 0, 0);

    ctx.clearRect(0, 0, sw, sh);
    const strips = 80;
    const stripH = sh / strips;
    const amplitude = 4 * scale;
    const frequency = 0.03;
    const speed = now * 0.003;
    for (let i = 0; i < strips; i++) {
      const y = i * stripH;
      const offset = Math.round(amplitude * Math.sin(y * frequency + speed));
      ctx.drawImage(this.scratch, 0, y, sw, stripH, offset, y, sw, stripH);
    }
  }

  /** Hologram: scanlines + blue tint + slow flicker + subtle chromatic offset. */
  private holoPass(scale: number, now: number): void {
    const ctx = this.ctx;
    const sw = this.canvas.width;
    const sh = this.canvas.height;

    // Blue tint overlay.
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalCompositeOperation = "overlay";
    ctx.fillStyle = "rgba(0, 80, 180, 0.35)";
    ctx.fillRect(0, 0, sw, sh);
    ctx.globalCompositeOperation = "source-over";

    // Scanlines.
    const period = Math.max(2, Math.round(3 * scale));
    ctx.fillStyle = "rgba(0, 0, 0, 0.18)";
    for (let y = 0; y < sh; y += period) {
      ctx.fillRect(0, y, sw, Math.max(1, Math.round(scale)));
    }

    // Slow flicker (brightness wobble).
    const flicker = 0.92 + 0.08 * Math.sin(now * 0.012) * Math.sin(now * 0.007);
    ctx.globalAlpha = 1 - flicker;
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, sw, sh);
    ctx.globalAlpha = 1;

    // Horizontal tear line sweeping down.
    const tearY = ((now * 0.04) % (sh + 40)) - 20;
    ctx.fillStyle = "rgba(0, 180, 255, 0.15)";
    ctx.fillRect(0, tearY, sw, 6 * scale);
  }

  /** Neon: edge-detect + glow. Sobel-like edge detection on a low-res sample. */
  private neonPass(scale: number): void {
    const ctx = this.ctx;
    const sw = this.canvas.width;
    const sh = this.canvas.height;
    const sampleW = Math.max(2, sw >> 2);
    const sampleH = Math.max(2, sh >> 2);

    this.ensureScratch(Math.max(sampleW, this.scratch.width), Math.max(sampleH, this.scratch.height));
    const sctx = this.sctx;
    sctx.setTransform(1, 0, 0, 1, 0, 0);
    sctx.clearRect(0, 0, sampleW, sampleH);
    sctx.drawImage(ctx.canvas, 0, 0, sw, sh, 0, 0, sampleW, sampleH);

    let data: Uint8ClampedArray;
    try {
      data = sctx.getImageData(0, 0, sampleW, sampleH).data;
    } catch {
      return;
    }

    // Build luminance map.
    const lum = new Float32Array(sampleW * sampleH);
    for (let i = 0; i < lum.length; i++) {
      const j = i * 4;
      lum[i] = 0.2126 * data[j] + 0.7152 * data[j + 1] + 0.0722 * data[j + 2];
    }

    // Sobel edge detection.
    const edges = new Float32Array(sampleW * sampleH);
    for (let y = 1; y < sampleH - 1; y++) {
      for (let x = 1; x < sampleW - 1; x++) {
        const i = y * sampleW + x;
        const gx =
          -lum[i - sampleW - 1] - 2 * lum[i - 1] - lum[i + sampleW - 1] +
          lum[i - sampleW + 1] + 2 * lum[i + 1] + lum[i + sampleW + 1];
        const gy =
          -lum[i - sampleW - 1] - 2 * lum[i - sampleW] - lum[i - sampleW + 1] +
          lum[i + sampleW - 1] + 2 * lum[i + sampleW] + lum[i + sampleW + 1];
        edges[i] = Math.min(255, Math.sqrt(gx * gx + gy * gy));
      }
    }

    // Draw edges as neon glow on black.
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalCompositeOperation = "source-over";
    ctx.fillStyle = "#000000";
    ctx.fillRect(0, 0, sw, sh);

    const pixelW = sw / sampleW;
    const pixelH = sh / sampleH;
    ctx.fillStyle = "#00e5ff";
    for (let y = 0; y < sampleH; y++) {
      for (let x = 0; x < sampleW; x++) {
        const e = edges[y * sampleW + x];
        if (e > 40) {
          const alpha = Math.min(1, e / 120);
          ctx.globalAlpha = alpha * 0.8;
          ctx.fillRect(x * pixelW, y * pixelH, pixelW + 1, pixelH + 1);
        }
      }
    }
    ctx.globalAlpha = 1;

    // Glow: draw a blurred copy on top with lighter.
    this.ensureScratch(sw, sh);
    sctx.setTransform(1, 0, 0, 1, 0, 0);
    sctx.filter = `blur(${(6 * scale).toFixed(1)}px)`;
    sctx.clearRect(0, 0, sw, sh);
    sctx.drawImage(ctx.canvas, 0, 0);
    sctx.filter = "none";
    ctx.globalCompositeOperation = "lighter";
    ctx.globalAlpha = 0.5;
    ctx.drawImage(this.scratch, 0, 0);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = "source-over";
  }

  /** Particles: glowing sparks radiating from the window centre. */
  private burstParticlePass(
    polygon: Point[],
    cssW: number,
    cssH: number,
    scale: number,
    now: number
  ): void {
    const box = boundingBox(polygon);
    if (box.width < 24 || box.height < 24) return;
    if (this.particles.length !== this.params.particleCount) this.seed(box, cssH);
    if (this.particles.length === 0) return;

    const dt = this.lastStep === 0 ? 0 : Math.max(0, (now - this.lastStep) / 1000);
    this.lastStep = now;

    // Reposition: particles drift outward from centre.
    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;
    for (const p of this.particles) {
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      // Respawn near centre when too far.
      if (Math.hypot(p.x - cx, p.y - cy) > Math.max(box.width, box.height) * 0.6) {
        const angle = Math.random() * Math.PI * 2;
        const speed = 40 + Math.random() * 120;
        p.x = cx;
        p.y = cy;
        p.vx = Math.cos(angle) * speed;
        p.vy = Math.sin(angle) * speed;
        p.alpha = 0.5 + Math.random() * 0.5;
      }
    }

    const k = scaledPx(1, cssW);
    const ctx = this.ctx;
    ctx.setTransform(scale, 0, 0, scale, 0, 0);
    for (const p of this.particles) {
      ctx.globalAlpha = p.alpha;
      ctx.fillStyle = "#aaddff";
      ctx.shadowColor = "#66ccff";
      ctx.shadowBlur = 6 * k;
      ctx.beginPath();
      ctx.arc(p.x, p.y, Math.max(1, p.size * k), 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.shadowBlur = 0;
    ctx.globalAlpha = 1;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
  }

  /** Portal: swirl + ring overlay on the camera frame. */
  private portalEffectPass(scale: number, now: number): void {
    const ctx = this.ctx;
    const sw = this.canvas.width;
    const sh = this.canvas.height;

    this.ensureScratch(sw, sh);
    const sctx = this.sctx;
    sctx.setTransform(1, 0, 0, 1, 0, 0);
    sctx.globalCompositeOperation = "source-over";
    sctx.clearRect(0, 0, sw, sh);
    sctx.drawImage(ctx.canvas, 0, 0);

    // Swirl distortion (strip-based).
    ctx.clearRect(0, 0, sw, sh);
    const cx = sw / 2;
    const cy = sh / 2;
    const maxR = Math.hypot(cx, cy);
    const angle = now * 0.0008;
    const strips = 80;
    const stripH = sh / strips;
    for (let i = 0; i < strips; i++) {
      const y = i * stripH;
      const dy = y + stripH / 2 - cy;
      const swirl = angle * 0.12 * Math.max(0, 1 - Math.abs(dy) / maxR);
      const offset = Math.round(swirl * sw * 0.3);
      ctx.drawImage(this.scratch, 0, y, sw, stripH, offset, y, sw, stripH);
    }

    // Glowing ring overlay.
    const ringRadius = Math.min(cx, cy) * 0.6;
    const ringWidth = 8 * scale;
    const gradient = ctx.createRadialGradient(cx, cy, ringRadius - ringWidth, cx, cy, ringRadius + ringWidth);
    gradient.addColorStop(0, "rgba(100, 50, 255, 0)");
    gradient.addColorStop(0.5, `rgba(140, 80, 255, ${0.4 + 0.2 * Math.sin(now * 0.004)})`);
    gradient.addColorStop(1, "rgba(100, 50, 255, 0)");
    ctx.globalCompositeOperation = "lighter";
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, sw, sh);
    ctx.globalCompositeOperation = "source-over";
  }

  /** Soft alpha falloff at the window edge, masked with destination-in. */
  private applyFeather(polygon: Point[], cssW: number, scale: number): void {
    const feather = scaledPx(this.params.edgeFeather, cssW);
    if (feather <= 0) return;
    const inset = insetPolygon(polygon, feather);
    if (inset.length < 4) return;

    const sw = this.canvas.width;
    const sh = this.canvas.height;
    this.ensureScratch(sw, sh);
    const sctx = this.sctx;
    sctx.setTransform(1, 0, 0, 1, 0, 0);
    sctx.globalCompositeOperation = "source-over";
    sctx.clearRect(0, 0, sw, sh);
    sctx.filter = `blur(${(feather * scale).toFixed(1)}px)`;
    sctx.fillStyle = "#ffffff";
    sctx.beginPath();
    sctx.moveTo(inset[0].x * scale, inset[0].y * scale);
    for (let i = 1; i < inset.length; i++) {
      sctx.lineTo(inset[i].x * scale, inset[i].y * scale);
    }
    sctx.closePath();
    sctx.fill();
    sctx.filter = "none";

    const ctx = this.ctx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalCompositeOperation = "destination-in";
    ctx.drawImage(this.scratch, 0, 0);
    ctx.globalCompositeOperation = "source-over";
  }
}

function boundingBox(polygon: Point[]): Box {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of polygon) {
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x);
    maxY = Math.max(maxY, p.y);
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

/** A jagged top-to-bottom bolt in css px — jittered walk across the stage. */
function generateBolt(cssW: number, cssH: number): Point[] {
  const points: Point[] = [];
  const steps = 9;
  let x = cssW * (0.2 + Math.random() * 0.6);
  for (let i = 0; i <= steps; i++) {
    points.push({ x, y: (cssH * i) / steps });
    x += (Math.random() - 0.5) * cssW * 0.14;
    x = Math.max(cssW * 0.05, Math.min(cssW * 0.95, x));
  }
  return points;
}
