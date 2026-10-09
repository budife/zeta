/**
 * MotionEngine — canvas-rendered motions that need frame history or pixel
 * manipulation (echo, freeze, shutter, portal, reality-zoom).
 *
 * The five CSS-only motions (shake, float, zoom, pulse, parallax) stay in
 * MediaLayer's motion wrapper. This engine handles the five that require
 * sampling the camera into a canvas and compositing previous frames.
 *
 * Lifecycle: one instance per motion id, created by MediaLayer when
 * contentMode==="motion" and the id is in CANVAS_MOTIONS, disposed on
 * change. Called from the snapshot subscription like EffectEngine.
 *
 * Pipeline (per frame):
 *   camera <video> ──drawImage (cover+mirror)──► sourceCanvas
 *     ──per-motion composite (echo blend / freeze hold / shutter trail /
 *       portal swirl / reality-zoom perspective)──► <canvas>
 *
 * Pure helpers (history buffer math, composite alpha) are tested by the
 * logic harness; DOM-touching methods live on the class.
 */

import type { Point } from "./types";
import { cameraCoverTransform } from "./stage";
import type { BlurLevel } from "./effects";

/* ── Motion ids handled by this engine ──────────────────────────────────── */

export type CanvasMotionId =
  | "reality-zoom"
  | "echo"
  | "freeze"
  | "shutter"
  | "portal";

const CANVAS_MOTIONS = new Set<string>([
  "reality-zoom",
  "echo",
  "freeze",
  "shutter",
  "portal",
]);

/** True if the motion id needs the canvas MotionEngine (not CSS). */
export function isCanvasMotion(id: string | null): boolean {
  return id !== null && CANVAS_MOTIONS.has(id);
}

/* ── Frame-history buffer ───────────────────────────────────────────────── */

/**
 * A ring buffer of recent frame snapshots (canvas references or pixel data).
 * Used by echo (ghosted previous frames) and shutter (long-exposure trail).
 * Pure: no DOM — the caller owns the actual canvas/image objects.
 */
export class FrameHistory<T> {
  private readonly buf: (T | undefined)[];
  private head = 0;
  readonly capacity: number;

  constructor(capacity: number) {
    this.capacity = Math.max(1, Math.floor(capacity));
    this.buf = new Array<T | undefined>(this.capacity);
  }

  push(frame: T): void {
    this.buf[this.head] = frame;
    this.head = (this.head + 1) % this.capacity;
  }

  /** Get the frame `n` steps back (0 = most recent). Null if not yet filled. */
  back(n: number): T | null {
    if (n < 0 || n >= this.capacity) return null;
    const idx = (this.head - 1 - n + this.capacity * 2) % this.capacity;
    return this.buf[idx] ?? null;
  }

  /** Number of frames currently stored. */
  get size(): number {
    let count = 0;
    for (const v of this.buf) if (v !== undefined) count++;
    return count;
  }

  clear(): void {
    this.buf.fill(undefined);
    this.head = 0;
  }
}

/**
 * Echo composite alpha: ghost frames fade with distance. Frame 0 (current)
 * is full opacity; frame k is `baseAlpha * decay^k`.
 */
export function echoAlpha(baseAlpha: number, decay: number, k: number): number {
  if (k <= 0) return baseAlpha;
  const a = baseAlpha * Math.pow(decay, k);
  return a < 0.01 ? 0 : a;
}

/**
 * Shutter blend weight for the accumulated trail. Older frames contribute
 * less; `shutterMs` controls how long the trail persists (longer = more
 * ghosting). Returns 0 for the newest frame (age 0 — full weight on the
 * source, no ghosting of the current frame).
 */
export function shutterWeight(ageMs: number, shutterMs: number): number {
  if (shutterMs <= 0 || ageMs <= 0) return 0;
  const t = Math.max(0, Math.min(1, ageMs / shutterMs));
  return Math.pow(1 - t, 1.5); // ease-out falloff
}

/* ── Motion-specific tuning ─────────────────────────────────────────────── */

export const MOTION_TUNING = {
  /** Echo: how many ghost copies to draw. */
  echoCopies: 4,
  /** Echo: base opacity of the first ghost. */
  echoBaseAlpha: 0.35,
  /** Echo: decay per copy (0..1). */
  echoDecay: 0.55,
  /** Shutter: trail persistence in ms. */
  shutterMs: 350,
  /** Freeze: how long the freeze lasts before auto-resuming (ms); 0 = until gesture. */
  freezeDurationMs: 3000,
  /** Reality zoom: zoom cycle period (ms). */
  realityZoomPeriodMs: 4000,
  /** Portal: swirl rotation speed (rad/s). */
  portalSpeed: 0.8,
  /** Portal: max swirl distortion in normalised radius (0..1). */
  portalStrength: 0.15,
} as const;

/* ── Engine (DOM canvas) ────────────────────────────────────────────────── */

export type MotionFrame = {
  video: HTMLVideoElement;
  width: number;
  height: number;
  videoWidth: number;
  videoHeight: number;
  now: number;
};

export const motionStats = {
  motion: "",
  fps: 0,
  lastMs: 0,
};

/**
 * Renders one canvas motion over the live camera inside the hand window.
 * One engine per motion id; created/disposed by MediaLayer.
 */
export class MotionEngine {
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly scratch: HTMLCanvasElement;
  private readonly sctx: CanvasRenderingContext2D;
  private readonly motionId: string;

  // Frame history for echo / shutter.
  private history: FrameHistory<HTMLCanvasElement>;
  private lastDraw = 0;
  private lastStep = 0;

  // Freeze state.
  private freezeFrame: HTMLCanvasElement | null = null;
  private freezeStart = -Infinity;

  // Reality zoom phase.
  private zoomPhase = 0;

  // Portal swirl offscreen.
  private portalCanvas: HTMLCanvasElement | null = null;

  private scale = 1;

  constructor(canvas: HTMLCanvasElement, motionId: string) {
    const ctx = canvas.getContext("2d");
    const scratch = document.createElement("canvas");
    const sctx = scratch.getContext("2d");
    if (!ctx || !sctx) {
      throw new Error("[MotionEngine] canvas 2d context unavailable");
    }
    this.canvas = canvas;
    this.ctx = ctx;
    this.scratch = scratch;
    this.sctx = sctx;
    this.motionId = motionId;

    const capacity =
      motionId === "echo" ? MOTION_TUNING.echoCopies + 1 :
      motionId === "shutter" ? 12 : 1;
    this.history = new FrameHistory<HTMLCanvasElement>(capacity);
  }

  render(frame: MotionFrame): void {
    const { video, width, height, videoWidth, videoHeight, now } = frame;
    if (!(width > 0) || !(height > 0) || !(videoWidth > 0) || !(videoHeight > 0)) {
      this.clear();
      return;
    }

    const dt = this.lastStep === 0 ? 0 : Math.max(0, (now - this.lastStep) / 1000);
    this.lastStep = now;

    const scale = this.fit(width, height);
    const t0 = performance.now();

    switch (this.motionId) {
      case "echo":
        this.echoPass(video, videoWidth, videoHeight, width, height, scale, now, dt);
        break;
      case "freeze":
        this.freezePass(video, videoWidth, videoHeight, width, height, scale, now);
        break;
      case "shutter":
        this.shutterPass(video, videoWidth, videoHeight, width, height, scale, now, dt);
        break;
      case "portal":
        this.portalPass(video, videoWidth, videoHeight, width, height, scale, now, dt);
        break;
      case "reality-zoom":
        this.realityZoomPass(video, videoWidth, videoHeight, width, height, scale, now, dt);
        break;
    }

    const gap = now - this.lastDraw;
    this.lastDraw = now;
    motionStats.motion = this.motionId;
    motionStats.lastMs = Math.round((performance.now() - t0) * 10) / 10;
    if (gap > 0 && gap < 1000) {
      motionStats.fps = Math.round(motionStats.fps + (1000 / gap - motionStats.fps) * 0.2);
    }
  }

  clear(): void {
    const ctx = this.ctx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
  }

  dispose(): void {
    this.history.clear();
    this.freezeFrame = null;
    this.portalCanvas = null;
    this.canvas.width = 0;
    this.canvas.height = 0;
    motionStats.motion = "";
    motionStats.fps = 0;
    motionStats.lastMs = 0;
  }

  /* ── passes ───────────────────────────────────────────────────────────── */

  private fit(cssW: number, cssH: number): number {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    let scale = dpr;
    if (cssW * scale > 1600) scale = 1600 / cssW;
    const w = Math.max(1, Math.round(cssW * scale));
    const h = Math.max(1, Math.round(cssH * scale));
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
    this.scale = w / cssW;
    return this.scale;
  }

  /** Draw the camera base (cover + mirror) into the given context. */
  private drawBase(
    video: HTMLVideoElement,
    vw: number,
    vh: number,
    cssW: number,
    cssH: number,
    scale: number,
    ctx: CanvasRenderingContext2D
  ): void {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalCompositeOperation = "source-over";
    ctx.globalAlpha = 1;
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    const m = cameraCoverTransform(cssW, cssH, vw, vh);
    ctx.setTransform(m.a * scale, m.b * scale, m.c * scale, m.d * scale, m.e * scale, m.f * scale);
    ctx.drawImage(video, 0, 0, vw, vh);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
  }

  /** Snapshot the current canvas into a reusable offscreen for history. */
  private snapshotToHistory(cssW: number, cssH: number): void {
    const w = Math.max(1, this.canvas.width);
    const h = Math.max(1, this.canvas.height);
    let snap = this.history.back(0);
    if (!snap) {
      snap = document.createElement("canvas");
    }
    if (snap.width !== w || snap.height !== h) {
      snap.width = w;
      snap.height = h;
    }
    const sctx = snap.getContext("2d");
    if (!sctx) return;
    sctx.setTransform(1, 0, 0, 1, 0, 0);
    sctx.clearRect(0, 0, w, h);
    sctx.drawImage(this.canvas, 0, 0);
    this.history.push(snap);
  }

  /** Echo: current frame + ghosted copies from history, each at reduced alpha. */
  private echoPass(
    video: HTMLVideoElement,
    vw: number,
    vh: number,
    cssW: number,
    cssH: number,
    scale: number,
    now: number,
    dt: number
  ): void {
    const ctx = this.ctx;
    this.drawBase(video, vw, vh, cssW, cssH, scale, ctx);

    // Draw ghost copies behind the current frame (painter's order: oldest first).
    for (let k = MOTION_TUNING.echoCopies; k >= 1; k--) {
      const ghost = this.history.back(k);
      if (!ghost) continue;
      const alpha = echoAlpha(MOTION_TUNING.echoBaseAlpha, MOTION_TUNING.echoDecay, k);
      if (alpha <= 0) continue;
      ctx.globalAlpha = alpha;
      ctx.drawImage(ghost, 0, 0);
    }
    ctx.globalAlpha = 1;

    // Snapshot the current frame into history for the next render.
    this.snapshotToHistory(cssW, cssH);
  }

  /** Freeze: hold the frame captured at freeze start; resume after duration. */
  private freezePass(
    video: HTMLVideoElement,
    vw: number,
    vh: number,
    cssW: number,
    cssH: number,
    scale: number,
    now: number
  ): void {
    const ctx = this.ctx;

    // Auto-resume after freezeDurationMs (unless 0 = permanent hold).
    if (
      this.freezeFrame &&
      MOTION_TUNING.freezeDurationMs > 0 &&
      now - this.freezeStart >= MOTION_TUNING.freezeDurationMs
    ) {
      this.freezeFrame = null;
    }

    if (this.freezeFrame) {
      // Draw the held frame, not the live camera.
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.globalCompositeOperation = "source-over";
      ctx.globalAlpha = 1;
      ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
      ctx.drawImage(this.freezeFrame, 0, 0);
    } else {
      // Capture a new freeze frame and draw live for this pass.
      this.drawBase(video, vw, vh, cssW, cssH, scale, ctx);
      const w = this.canvas.width;
      const h = this.canvas.height;
      let snap = document.createElement("canvas");
      snap.width = w;
      snap.height = h;
      const sctx = snap.getContext("2d");
      if (sctx) {
        sctx.drawImage(this.canvas, 0, 0);
        this.freezeFrame = snap;
        this.freezeStart = now;
      }
    }
  }

  /** Shutter: long-exposure trail — accumulate recent frames with decaying alpha. */
  private shutterPass(
    video: HTMLVideoElement,
    vw: number,
    vh: number,
    cssW: number,
    cssH: number,
    scale: number,
    now: number,
    dt: number
  ): void {
    const ctx = this.ctx;

    // Draw oldest → newest with decaying alpha for the trail effect.
    const count = this.history.size;
    for (let k = count - 1; k >= 1; k--) {
      const ghost = this.history.back(k);
      if (!ghost) continue;
      const ageMs = (now - this.lastDraw); // approximate age
      const weight = shutterWeight(k * ageMs, MOTION_TUNING.shutterMs);
      if (weight <= 0.01) continue;
      ctx.globalAlpha = weight;
      ctx.drawImage(ghost, 0, 0);
    }
    ctx.globalAlpha = 1;

    // Draw the live frame on top.
    this.drawBase(video, vw, vh, cssW, cssH, scale, ctx);

    // Snapshot for next frame's trail.
    this.snapshotToHistory(cssW, cssH);
  }

  /** Portal: swirl distortion of the live frame around the centre. */
  private portalPass(
    video: HTMLVideoElement,
    vw: number,
    vh: number,
    cssW: number,
    cssH: number,
    scale: number,
    now: number,
    dt: number
  ): void {
    const ctx = this.ctx;

    // Draw base into scratch for distortion source.
    const sw = this.canvas.width;
    const sh = this.canvas.height;
    const scratch = this.scratch;
    if (scratch.width !== sw || scratch.height !== sh) {
      scratch.width = sw;
      scratch.height = sh;
    }
    const sctx = this.sctx;
    sctx.setTransform(1, 0, 0, 1, 0, 0);
    sctx.globalCompositeOperation = "source-over";
    sctx.globalAlpha = 1;
    sctx.clearRect(0, 0, sw, sh);
    const m = cameraCoverTransform(cssW, cssH, vw, vh);
    sctx.setTransform(m.a * scale, m.b * scale, m.c * scale, m.d * scale, m.e * scale, m.f * scale);
    sctx.drawImage(video, 0, 0, vw, vh);
    sctx.setTransform(1, 0, 0, 1, 0, 0);

    // Swirl: draw columns of the source, offset by a radial displacement.
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, sw, sh);
    const cx = sw / 2;
    const cy = sh / 2;
    const maxR = Math.hypot(cx, cy);
    const angle = now * MOTION_TUNING.portalSpeed * 0.001;
    const strength = MOTION_TUNING.portalStrength;

    // Use strip-based distortion (rows) for a smooth swirl.
    const strips = 60;
    const stripH = sh / strips;
    for (let i = 0; i < strips; i++) {
      const y = i * stripH;
      const dy = y + stripH / 2 - cy;
      const swirl = angle * strength * Math.max(0, 1 - Math.abs(dy) / maxR);
      const offset = Math.round(swirl * sw * 0.3);
      ctx.drawImage(scratch, 0, y, sw, stripH, offset, y, sw, stripH);
    }
  }

  /** Reality zoom: continuous slow zoom-in / zoom-out cycle on the camera. */
  private realityZoomPass(
    video: HTMLVideoElement,
    vw: number,
    vh: number,
    cssW: number,
    cssH: number,
    scale: number,
    now: number,
    dt: number
  ): void {
    const ctx = this.ctx;

    // Advance the zoom phase.
    this.zoomPhase += (dt * 1000) / MOTION_TUNING.realityZoomPeriodMs;
    const t = (this.zoomPhase % 1);
    // Smooth sine zoom: 1.0 → 1.25 → 1.0.
    const zoom = 1 + 0.125 * (1 - Math.cos(t * Math.PI * 2));

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalCompositeOperation = "source-over";
    ctx.globalAlpha = 1;
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);

    const m = cameraCoverTransform(cssW, cssH, vw, vh);
    // Compose zoom into the matrix: scale about centre.
    const cx = cssW / 2;
    const cy = cssH / 2;
    const z = zoom;
    // new = translate(cx,cy) * scale(z) * translate(-cx,-cy) * cover
    const za = z, zd = z;
    const ze = cx - z * cx;
    const zf = cy - z * cy;
    const a = za * m.a + 0 * m.c;
    const b = za * m.b + 0 * m.d;
    const c = 0 * m.a + zd * m.c;
    const d = 0 * m.b + zd * m.d;
    const e = ze + za * m.e + 0 * m.f;
    const f = zf + 0 * m.e + zd * m.f;

    ctx.setTransform(a * scale, b * scale, c * scale, d * scale, e * scale, f * scale);
    ctx.drawImage(video, 0, 0, vw, vh);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
  }
}
