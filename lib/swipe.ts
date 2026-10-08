/**
 * Two-finger swipe detection.
 *
 * The spec's directional gestures: a quick flick of the index+middle ("peace
 * sign") opens the menu (down) or resets (left). Detection is pure geometry
 * over landmarks the pipeline ALREADY produces — no new inference, no AI
 * classifier (spec AP), and no second camera loop: the engine hands this
 * tracker the right hand's pixel landmarks once per tick and consumes the
 * returned event.
 *
 * Three deliberate constraints make ordinary movement safe:
 *
 *   1. PEACE SIGN ONLY — an open palm (the frame's own L shape!) flicked the
 *      same distance fires nothing, so carrying a locked window around can
 *      never be mistaken for a swipe;
 *   2. DOMINANT AXIS — travel must be 1.5× more vertical than horizontal (or
 *      vice versa) or the window restarts instead of guessing a direction;
 *   3. SHORT WINDOW + COOLDOWN — only travel inside `windowMs` counts, so
 *      slow drift can never accumulate into a gesture, and one flick is one
 *      event.
 *
 * DIRECTION IS MIRRORED: the preview applies `MIRROR_PREVIEW` (scaleX(-1)),
 * so raw video pixels moving toward +x appear on screen as moving LEFT. The
 * axis test therefore happens in screen space, reading the same
 * `MIRROR_PREVIEW` constant the renderers use — the mirror is applied exactly
 * once here, just like in the coordinate chain (lib/stage.ts).
 *
 * Handedness (right-hand-only, spec decision) is the CALLER's job: the
 * engine picks the hand by MediaPipe's handedness category and passes it (or
 * null) in. This tracker stays handedness-agnostic and unit-testable.
 */
import { MIRROR_PREVIEW } from "./stage";
import type { Point } from "./types";

export const SWIPE_CONFIG = {
  /**
   * Handedness category the engine must select before swipes are considered.
   * Right-hand-only is a spec decision. If swipes never fire with a given
   * camera, check `window.__handFrameDebug` and flip this: MediaPipe's
   * handedness depends on the raw (unmirrored) camera image.
   */
  hand: "Right",
  /** Minimum travel within `windowMs` for a flick to count (video pixels). */
  minDistancePx: 120,
  /** Only travel inside this window counts (ms) — slow drift never accrues. */
  windowMs: 400,
  /** Travel must dominate its perpendicular axis by this factor. */
  axisRatio: 1.5,
  /** Quiet time after an event before another swipe may fire (ms). */
  cooldownMs: 700,
} as const;

/** Swipe directions, named as the user sees them on the mirrored preview. */
export type SwipeEvent = "swipeDown" | "swipeLeft";

/**
 * Live detector state for the debug overlay — the evidence trail when a
 * webcam gesture "does nothing": is the sign recognized, how far the flick
 * has travelled, is the cooldown still running, what was the last event.
 */
export type SwipeDebug = {
  /** Which hand the engine picked for swipes (-1 when no hand is visible). */
  handIndex: number;
  /** Whether the last evaluated hand held the 2-finger sign. */
  signOk: boolean;
  /** Travel inside the current window (px), before the threshold. */
  travelPx: number;
  /** Samples currently inside the window. */
  samples: number;
  /** Milliseconds of cooldown still running. */
  cooldownLeftMs: number;
  /** The most recent event this tracker fired, if any. */
  lastEvent: SwipeEvent | null;
};

/**
 * Picks the hand swipes (and the menu pointer) are read from.
 *
 * MediaPipe decides handedness ASSUMING a mirrored input, while
 * getUserMedia hands us the raw, unmirrored frame — so on many cameras the
 * labels come back reversed. The pick therefore has two tiers:
 *
 *   1. the hand labeled `wanted` ("Right") wins outright;
 *   2. otherwise the image-LEFT hand: in an unmirrored frontal frame that is
 *      the person's right side — the same convention the mirror preview
 *      shows them.
 *
 * With a single visible hand that hand is chosen either way (one-hand
 * gestures are unambiguous, and the label may simply be the reversed one).
 * Returns -1 when no hand is visible.
 */
export function pickSwipeHand(
  hands: Point[][],
  handedness: { categoryName?: string }[][] | null,
  wanted: string
): number {
  if (hands.length === 0) return -1;
  if (handedness) {
    for (let i = 0; i < hands.length; i++) {
      if (handedness[i]?.[0]?.categoryName === wanted) return i;
    }
  }
  let imageLeft = 0;
  for (let i = 1; i < hands.length; i++) {
    if ((hands[i][0]?.x ?? Infinity) < (hands[imageLeft][0]?.x ?? Infinity)) imageLeft = i;
  }
  return imageLeft;
}

type Sample = { t: number; x: number; y: number };

/**
 * Frame-by-frame swipe state machine. Feed it the (pixel-space) landmarks of
 * the candidate hand each tick — or `null` when that hand is not visible,
 * which restarts the movement window — and it returns an event when a flick
 * completes.
 */
export class SwipeTracker {
  private samples: Sample[] = [];
  private cooldownUntil = 0;
  private signOk = false;
  private lastEvent: SwipeEvent | null = null;

  /** Camera turned off / full reset: forget in-flight movement. */
  reset(): void {
    this.samples = [];
    this.cooldownUntil = 0;
    this.signOk = false;
    this.lastEvent = null;
  }

  /** Debug readout for the overlay — see {@link SwipeDebug}. */
  debugState(nowMs: number, handIndex: number): SwipeDebug {
    let travelPx = 0;
    if (this.samples.length >= 2) {
      const first = this.samples[0];
      const last = this.samples[this.samples.length - 1];
      travelPx = Math.hypot(last.x - first.x, last.y - first.y);
    }
    return {
      handIndex,
      signOk: this.signOk,
      travelPx: Math.round(travelPx),
      samples: this.samples.length,
      cooldownLeftMs: Math.max(0, Math.round(this.cooldownUntil - nowMs)),
      lastEvent: this.lastEvent,
    };
  }

  update(hand: Point[] | null, nowMs: number): SwipeEvent | null {
    if (nowMs < this.cooldownUntil) {
      // Inside the quiet period a flick must not half-accumulate and then
      // complete early; it starts fresh once the cooldown lifts.
      this.samples = [];
      return null;
    }
    const point = this.signPoint(hand);
    this.signOk = point !== null;
    if (!point) {
      this.samples = []; // hand gone, or not making the 2-finger sign
      return null;
    }

    this.samples.push({ t: nowMs, x: point.x, y: point.y });
    while (nowMs - this.samples[0].t > SWIPE_CONFIG.windowMs) this.samples.shift();
    if (this.samples.length < 2) return null;

    const first = this.samples[0];
    const last = this.samples[this.samples.length - 1];
    const dx = last.x - first.x;
    const dy = last.y - first.y;
    if (Math.hypot(dx, dy) < SWIPE_CONFIG.minDistancePx) return null;

    // Axis test in SCREEN space (the preview is mirrored once, see header).
    const sx = MIRROR_PREVIEW ? -dx : dx;
    const sy = dy;

    let event: SwipeEvent | null = null;
    if (Math.abs(sy) > SWIPE_CONFIG.axisRatio * Math.abs(sx) && sy > 0) {
      event = "swipeDown"; // screen-down (+y in video pixels, never mirrored)
    } else if (Math.abs(sx) > SWIPE_CONFIG.axisRatio * Math.abs(sy) && sx < 0) {
      event = "swipeLeft"; // screen-left (raw +x under the mirror)
    }

    if (!event) {
      this.samples = []; // ambiguous diagonal — restart rather than guess
      return null;
    }
    this.cooldownUntil = nowMs + SWIPE_CONFIG.cooldownMs;
    this.samples = [];
    this.lastEvent = event;
    return event;
  }

  /**
   * The tracked point while the hand holds the 2-finger sign — the midpoint
   * of the index and middle tips — or null when it isn't holding it.
   *
   * A finger counts as extended when its tip reaches further from the wrist
   * than its PIP joint; the sign is index+middle out, ring+pinky in. That is
   * what keeps an open-palm frame gesture from ever reading as a swipe.
   */
  private signPoint(hand: Point[] | null): Point | null {
    if (!hand || hand.length < 21) return null;
    const wrist = hand[0];
    const extended = (tip: number, pip: number) =>
      dist(hand[tip], wrist) > dist(hand[pip], wrist);
    if (!extended(8, 6) || !extended(12, 10)) return null; // need index+middle
    if (extended(16, 14) || extended(20, 18)) return null; // ring+pinky must fold
    return { x: (hand[8].x + hand[12].x) / 2, y: (hand[8].y + hand[12].y) / 2 };
  }
}

function dist(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}
