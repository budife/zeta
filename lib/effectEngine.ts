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
