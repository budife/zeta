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
import { effectParams, scaledPx, type BlurLevel, type EffectParams } from "./effects";

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

type Band = { y: number; h: number; dx: number; tint: boolean };

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

  // Glitch burst timing (device px bands, ms clock).
  private glitchEnd = -Infinity;
  private glitchNext = 0;
  private glitchBands: Band[] = [];

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
    this.lastPolygon = null;
    this.duotone = null;
    this.scanPattern = null;
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
    }
    return w / cssW;
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
    // processes real pixels (the old CSS backdrop-filter could not).
    ctx.filter =
      this.effectId === "cyberpunk" ? "saturate(1.7) contrast(1.25) hue-rotate(-12deg)" : "none";
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
      case "cyberpunk":
        this.cyberPass(scale, now);
        break;
      case "glitch":
        this.glitchPass(now);
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
      const w2 = Math.max(1, sw >> 1);
      const h2 = Math.max(1, sh >> 1);
      this.ensureScratch(w2, h2);
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

    const dt = this.lastStep === 0 ? 0 : Math.max(0, (now - this.lastStep) / 1000);
    this.lastStep = now;
    for (const p of this.particles) stepParticle(p, dt, box, Math.random);

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
    } else {
      for (const p of this.particles) {
        const x = p.x + Math.sin(p.phase) * p.sway * k;
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
   * Displaced slices torn out of the CURRENT frame (bands shift horizontally,
   * a hue-tinted one occasionally, blank beats in between). Clearing the band
   * before redrawing lets the raw camera show through the tear — the content
   * glitches, not a rectangle floating above it.
   */
  private glitchPass(now: number): void {
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
    sctx.drawImage(this.canvas, 0, 0);

    const ctx = this.ctx;
    for (const band of this.glitchBands) {
      const y = Math.max(0, Math.round(band.y));
      const h = Math.max(2, Math.min(sh - y, Math.round(band.h)));
      ctx.clearRect(0, y, sw, h);
      ctx.filter = band.tint ? "hue-rotate(90deg)" : "none";
      ctx.drawImage(this.scratch, 0, y, sw, h, Math.round(band.dx), y, sw, h);
      ctx.filter = "none";
    }
  }

  private startGlitch(now: number): void {
    const hMax = this.canvas.height;
    this.glitchBands = [];
    const count = 2 + Math.floor(Math.random() * 3);
    for (let i = 0; i < count; i++) {
      const h = 6 + Math.random() * Math.max(10, hMax * 0.08);
      this.glitchBands.push({
        y: Math.random() * Math.max(1, hMax - h),
        h,
        dx: (Math.random() < 0.5 ? -1 : 1) * (4 + Math.random() * 14),
        tint: Math.random() < 0.4,
      });
    }
    this.glitchEnd = now + 110 + Math.random() * 170;
    this.glitchNext = this.glitchEnd + 550 + Math.random() * 1400;
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
