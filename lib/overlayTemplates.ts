/**
 * Overlay templates — canvas overlays drawn on top of the live camera using
 * face/pose landmarks. Four variants: face wireframe, cyber mask, skeleton
 * overlay, sci-fi HUD.
 *
 * These render when `contentMode === "template"` and the template id is one
 * of the overlay ids (face-wireframe, cyber-mask, skeleton-overlay,
 * sci-fi-hud). The camera stays visible underneath; the overlay draws
 * landmark-connected lines and decorative elements.
 *
 * Pure helpers (connection lists, point mapping) are tested by the logic
 * harness; DOM-touching methods live on the class.
 */

import type { NormalizedLandmark, Point } from "./types";

/* ── Overlay template ids ───────────────────────────────────────────────── */

export type OverlayTemplateId =
  | "face-wireframe"
  | "cyber-mask"
  | "skeleton-overlay"
  | "sci-fi-hud";

const OVERLAY_IDS = new Set<string>([
  "face-wireframe",
  "cyber-mask",
  "skeleton-overlay",
  "sci-fi-hud",
]);

/** True if the template id is a canvas overlay template. */
export function isOverlayTemplate(id: string | null): boolean {
  return id !== null && OVERLAY_IDS.has(id);
}

/* ── Face mesh connections (MediaPipe FaceMesh topology, simplified) ────── */

/**
 * Face landmark indices for the key wireframe edges. A reduced subset of
 * MediaPipe's 468-point mesh — enough to read as a wireframe without drawing
 * thousands of lines.
 */
export const FACE_WIRE_EDGES: ReadonlyArray<readonly [number, number]> = [
  // Jaw outline
  [10, 338], [338, 297], [297, 332], [332, 284], [284, 251], [251, 389],
  [389, 356], [356, 454], [454, 323], [323, 361], [361, 288], [288, 397],
  [397, 365], [365, 379], [379, 378], [378, 400], [400, 377], [377, 152],
  [152, 148], [148, 176], [176, 149], [149, 150], [150, 136], [136, 172],
  [172, 58], [58, 132], [132, 93], [93, 234], [234, 127], [127, 162],
  [162, 21], [21, 54], [54, 103], [103, 67], [67, 109], [109, 10],
  // Left eye
  [33, 7], [7, 163], [163, 144], [144, 145], [145, 153], [153, 154],
  [154, 155], [155, 133], [33, 246], [246, 161], [161, 160], [160, 159],
  // Right eye
  [263, 249], [249, 390], [390, 373], [373, 374], [374, 380], [380, 381],
  [381, 382], [382, 362], [263, 466], [466, 388], [388, 387], [387, 386],
  // Lips outer
  [61, 146], [146, 91], [91, 181], [181, 84], [84, 17], [17, 314],
  [314, 405], [405, 321], [321, 375], [375, 291], [291, 409], [409, 61],
  // Nose bridge
  [168, 6], [6, 197], [197, 195], [195, 5], [5, 4],
];

/**
 * Face landmark indices for the cyber-mask polygon (filled overlay).
 * A hexagonal mask covering the eyes and nose bridge.
 */
export const CYBER_MASK_INDICES: ReadonlyArray<number> = [
  33, 133, 362, 263, 168, 6, 197, 195,
];

/* ── Pose skeleton connections (MediaPipe Pose topology, simplified) ────── */

/**
 * Pose landmark indices for the skeleton edges. A reduced subset of
 * MediaPipe's 33-point pose topology.
 */
export const POSE_SKELETON_EDGES: ReadonlyArray<readonly [number, number]> = [
  // Torso
  [11, 12], // shoulders
  [11, 23], [12, 24], // shoulder → hip
  [23, 24], // hips
  // Left arm
  [11, 13], [13, 15], // shoulder → elbow → wrist
  // Right arm
  [12, 14], [14, 16],
  // Left leg
  [23, 25], [25, 27], [27, 31], // hip → knee → ankle → foot
  // Right leg
  [24, 26], [26, 28], [28, 32],
  // Head
  [0, 11], [0, 12], // nose → shoulders
];

/* ── Coordinate mapping ─────────────────────────────────────────────────── */

/**
 * Maps normalized landmarks (0..1) to canvas pixel coordinates.
 * The caller supplies the canvas size; mirroring is NOT applied here (the
 * engine's camera draw already mirrors the base frame, so overlay coordinates
 * must be flipped to match). Use `mirrorX` to flip.
 */
export function landmarksToPixels(
  landmarks: NormalizedLandmark[],
  width: number,
  height: number,
  mirrorX: boolean = true
): Point[] {
  return landmarks.map((lm) => ({
    x: (mirrorX ? 1 - lm.x : lm.x) * width,
    y: lm.y * height,
  }));
}

/* ── Styling per overlay variant ────────────────────────────────────────── */

export type OverlayStyle = {
  /** Primary line colour. */
  line: string;
  /** Secondary / accent colour (HUD elements, mask fill). */
  accent: string;
  /** Line width in css px at reference width 1280. */
  lineWidth: number;
  /** Whether to fill the cyber-mask polygon. */
  fillMask: boolean;
  /** Whether to draw decorative HUD elements (corners, brackets). */
  hud: boolean;
};

const STYLES: Record<OverlayTemplateId, OverlayStyle> = {
  "face-wireframe": { line: "#00e5ff", accent: "#00e5ff", lineWidth: 1, fillMask: false, hud: false },
  "cyber-mask": { line: "#ff00aa", accent: "rgba(255, 0, 170, 0.25)", lineWidth: 1.5, fillMask: true, hud: false },
  "skeleton-overlay": { line: "#00ff88", accent: "#00ff88", lineWidth: 2, fillMask: false, hud: false },
  "sci-fi-hud": { line: "#00ccff", accent: "#00ccff", lineWidth: 1, fillMask: false, hud: true },
};

/** Style for an overlay template id. */
export function overlayStyle(id: OverlayTemplateId): OverlayStyle {
  return STYLES[id] ?? STYLES["face-wireframe"];
}

/* ── Renderer (DOM canvas) ──────────────────────────────────────────────── */

export type OverlayFrame = {
  faceLandmarks: NormalizedLandmark[];
  poseLandmarks: NormalizedLandmark[];
  width: number;
  height: number;
  now: number;
};

/**
 * Draws one overlay template on a canvas above the live camera.
 * One instance per overlay id; created/disposed by MediaLayer.
 */
export class OverlayRenderer {
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly templateId: OverlayTemplateId;
  private readonly style: OverlayStyle;

  constructor(canvas: HTMLCanvasElement, templateId: OverlayTemplateId) {
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("[OverlayRenderer] canvas 2d context unavailable");
    this.canvas = canvas;
    this.ctx = ctx;
    this.templateId = templateId;
    this.style = overlayStyle(templateId);
  }

  render(frame: OverlayFrame): void {
    const { faceLandmarks, poseLandmarks, width, height, now } = frame;
    if (!(width > 0) || !(height > 0)) {
      this.clear();
      return;
    }

    // Match canvas backing store to CSS size (dpr ≤ 2).
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.round(width * dpr);
    const h = Math.round(height * dpr);
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }

    const ctx = this.ctx;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);

    const facePx = landmarksToPixels(faceLandmarks, width, height);
    const posePx = landmarksToPixels(poseLandmarks, width, height);

    switch (this.templateId) {
      case "face-wireframe":
        this.drawFaceWireframe(facePx, width, height);
        break;
      case "cyber-mask":
        this.drawCyberMask(facePx, width, height, now);
        break;
      case "skeleton-overlay":
        this.drawSkeleton(posePx, width, height);
        break;
      case "sci-fi-hud":
        this.drawSciFiHud(facePx, posePx, width, height, now);
        break;
    }
  }

  clear(): void {
    const ctx = this.ctx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
  }

  dispose(): void {
    this.canvas.width = 0;
    this.canvas.height = 0;
  }

  /* ── per-template draws ───────────────────────────────────────────────── */

  private drawFaceWireframe(face: Point[], w: number, h: number): void {
    if (face.length < 100) return; // need enough landmarks for the mesh
    const ctx = this.ctx;
    ctx.strokeStyle = this.style.line;
    ctx.lineWidth = this.style.lineWidth;
    ctx.globalAlpha = 0.7;
    ctx.beginPath();
    for (const [a, b] of FACE_WIRE_EDGES) {
      if (a >= face.length || b >= face.length) continue;
      ctx.moveTo(face[a].x, face[a].y);
      ctx.lineTo(face[b].x, face[b].y);
    }
    ctx.stroke();
    ctx.globalAlpha = 1;
  }

  private drawCyberMask(face: Point[], w: number, h: number, now: number): void {
    if (face.length < 100) return;
    const ctx = this.ctx;

    // Fill the mask polygon.
    if (this.style.fillMask && CYBER_MASK_INDICES.length >= 3) {
      ctx.fillStyle = this.style.accent;
      ctx.beginPath();
      const first = face[CYBER_MASK_INDICES[0]];
      ctx.moveTo(first.x, first.y);
      for (let i = 1; i < CYBER_MASK_INDICES.length; i++) {
        const p = face[CYBER_MASK_INDICES[i]];
        ctx.lineTo(p.x, p.y);
      }
      ctx.closePath();
      ctx.fill();
    }

    // Wireframe lines.
    ctx.strokeStyle = this.style.line;
    ctx.lineWidth = this.style.lineWidth;
    ctx.globalAlpha = 0.8;
    ctx.beginPath();
    for (const [a, b] of FACE_WIRE_EDGES) {
      if (a >= face.length || b >= face.length) continue;
      ctx.moveTo(face[a].x, face[a].y);
      ctx.lineTo(face[b].x, face[b].y);
    }
    ctx.stroke();

    // Pulsing scan line across the mask.
    const scanY = ((now * 0.05) % (h + 40)) - 20;
    ctx.strokeStyle = "rgba(255, 0, 170, 0.5)";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(0, scanY);
    ctx.lineTo(w, scanY);
    ctx.stroke();
    ctx.globalAlpha = 1;
  }

  private drawSkeleton(pose: Point[], w: number, h: number): void {
    if (pose.length < 25) return; // need enough landmarks for the skeleton
    const ctx = this.ctx;
    ctx.strokeStyle = this.style.line;
    ctx.lineWidth = this.style.lineWidth;
    ctx.lineCap = "round";
    ctx.beginPath();
    for (const [a, b] of POSE_SKELETON_EDGES) {
      if (a >= pose.length || b >= pose.length) continue;
      ctx.moveTo(pose[a].x, pose[a].y);
      ctx.lineTo(pose[b].x, pose[b].y);
    }
    ctx.stroke();

    // Joint dots.
    ctx.fillStyle = this.style.line;
    for (let i = 0; i < Math.min(pose.length, 33); i++) {
      ctx.beginPath();
      ctx.arc(pose[i].x, pose[i].y, 3, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  private drawSciFiHud(face: Point[], pose: Point[], w: number, h: number, now: number): void {
    const ctx = this.ctx;
    ctx.strokeStyle = this.style.line;
    ctx.fillStyle = this.style.accent;
    ctx.lineWidth = this.style.lineWidth;

    // Corner brackets.
    const m = 20;
    const bl = 30;
    ctx.globalAlpha = 0.6;
    // Top-left
    ctx.beginPath();
    ctx.moveTo(m, m + bl); ctx.lineTo(m, m); ctx.lineTo(m + bl, m);
    ctx.stroke();
    // Top-right
    ctx.beginPath();
    ctx.moveTo(w - m - bl, m); ctx.lineTo(w - m, m); ctx.lineTo(w - m, m + bl);
    ctx.stroke();
    // Bottom-left
    ctx.beginPath();
    ctx.moveTo(m, h - m - bl); ctx.lineTo(m, h - m); ctx.lineTo(m + bl, h - m);
    ctx.stroke();
    // Bottom-right
    ctx.beginPath();
    ctx.moveTo(w - m - bl, h - m); ctx.lineTo(w - m, h - m); ctx.lineTo(w - m, h - m - bl);
    ctx.stroke();

    // Face tracking box (if face detected).
    if (face.length >= 100) {
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const p of face) {
        minX = Math.min(minX, p.x); minY = Math.min(minY, p.y);
        maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y);
      }
      const pad = 10;
      ctx.strokeStyle = "rgba(0, 204, 255, 0.5)";
      ctx.strokeRect(minX - pad, minY - pad, maxX - minX + pad * 2, maxY - minY + pad * 2);

      // Label.
      ctx.font = "10px monospace";
      ctx.fillStyle = "rgba(0, 204, 255, 0.7)";
      ctx.fillText("FACE LOCK", minX - pad, minY - pad - 4);
    }

    // Pose tracking cross (if pose detected).
    if (pose.length >= 25) {
      const nose = pose[0];
      const r = 15 + 3 * Math.sin(now * 0.005);
      ctx.strokeStyle = "rgba(0, 204, 255, 0.4)";
      ctx.beginPath();
      ctx.moveTo(nose.x - r, nose.y); ctx.lineTo(nose.x + r, nose.y);
      ctx.moveTo(nose.x, nose.y - r); ctx.lineTo(nose.x, nose.y + r);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(nose.x, nose.y, r, 0, Math.PI * 2);
      ctx.stroke();
    }

    // Sweeping horizontal line.
    const sweepY = ((now * 0.03) % (h + 60)) - 30;
    ctx.strokeStyle = "rgba(0, 204, 255, 0.15)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, sweepY);
    ctx.lineTo(w, sweepY);
    ctx.stroke();

    ctx.globalAlpha = 1;
  }
}
