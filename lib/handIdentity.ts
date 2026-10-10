/**
 * Persistent hand identity for the frame tracker.
 *
 * MediaPipe's detectForVideo() can reorder its output between frames: the
 * hand at index 0 this frame may be at index 1 next frame, and the handedness
 * label can flip when the hand rotates. Feeding that unstable order into
 * detectHandFrame() means the four frame corners get a different array order
 * every time the detector shuffles — which is exactly what makes the tracker's
 * nearest-slot matching swap anchors and flip the quadrilateral.
 *
 * This tracker binds each visible hand to one of two persistent slots ("left"
 * and "right"). Once bound, a slot keeps following the same physical hand
 * across frames: the engine reorders the landmark arrays into slot order
 * before detectHandFrame() runs, so the four corners always come out in the
 * same order (left-thumb, left-index, right-thumb, right-index) and the
 * tracker's matching is stable.
 *
 * Matching strategy:
 *   1. spatial proximity — the hand closest to each slot's last centre wins.
 *      This is the only signal used in the normal case (both hands visible).
 *   2. handedness label — fires ONLY when pass 1 fails to match either slot
 *      (every hand is farther than MAX_MATCH_DIST from every slot). A single
 *      frame's label alone never overrides a spatial match: distance always
 *      dominates because MediaPipe's handedness assumes a mirrored input while
 *      the engine feeds it the raw frame, so labels can come back reversed.
 */

import type { NormalizedLandmark, Point } from "./types";

export type HandSlot = "left" | "right";
export const HAND_SLOTS: readonly HandSlot[] = ["left", "right"];

/**
 * Maximum pixel distance between a slot's last centre and a new hand for the
 * match to be accepted. Beyond this the hand is treated as a different hand
 * (the previous one left and a new one appeared).
 */
const MAX_MATCH_DIST = 400;

type SlotState = {
  /** Whether this slot currently has a hand bound to it. */
  bound: boolean;
  /** Handedness label of the bound hand ("Left" / "Right"), if known. */
  label: string | null;
  /** Pixel-space centre of the bound hand last frame. */
  cx: number;
  cy: number;
};

function handCentre(hand: NormalizedLandmark[]): Point {
  let x = 0;
  let y = 0;
  for (const lm of hand) {
    x += lm.x;
    y += lm.y;
  }
  const n = hand.length || 1;
  return { x: x / n, y: y / n };
}

/**
 * Assigns each detected hand to a persistent "left" / "right" slot and returns
 * the landmark arrays reordered into slot order. Call once per frame with the
 * raw MediaPipe output.
 */
export class HandIdentityTracker {
  private slots: SlotState[] | null = null;

  reset(): void {
    this.slots = null;
  }

  /**
   * Returns `{ ordered, labels, indexMap }`:
   *   - `ordered`   — landmark arrays reordered so index 0 = left slot,
   *                    index 1 = right slot (missing slots are skipped);
   *   - `labels`    — handedness label per ordered entry;
   *   - `indexMap`  — for each entry in `ordered`, the index it had in the
   *                    original `hands` array (so the engine can map swipe /
   *                    pointer indices back to the original order).
   */
  update(
    hands: NormalizedLandmark[][],
    handedness: { categoryName?: string }[][] | null,
    width: number,
    height: number
  ): {
    ordered: NormalizedLandmark[][];
    labels: string[];
    indexMap: number[];
  } {
    if (hands.length === 0) {
      return { ordered: [], labels: [], indexMap: [] };
    }

    let justInitialised = false;

    // First frame with hands: initialise one slot per hand, ordered by
    // SPATIAL position (image-left = slot 0). Using position rather than the
    // input order or the handedness label makes the first frame robust to
    // MediaPipe reordering its output: the leftmost hand is always slot 0.
    // Subsequent frames maintain the binding by distance.
    if (!this.slots) {
      const centres = hands.map((h) => this._centre(h, width, height));
      const indices = centres.map((_, i) => i).sort(
        (a, b) => centres[a].cx - centres[b].cx
      );
      this.slots = indices.map((i) => ({
        bound: true,
        label: handedness?.[i]?.[0]?.categoryName ?? null,
        ...centres[i],
      }));
      justInitialised = true;
    }

    const centres = hands.map((h) => this._centre(h, width, height));
    // Per-frame binding flags: start all-false so the matching passes below
    // rebind every visible hand. `slot.bound` is only updated in the output
    // loop at the end (and marks whether the slot has a hand at all).
    const bound = hands.map(() => false);
    const slotHand: number[] = [-1, -1];

    // On the very first frame the slots were just created in spatial order,
    // so slot s corresponds to the s-th hand in the sorted order. Record the
    // mapping directly and skip the matching passes (which would see every
    // hand as already bound and fall through to pass 3's input-order default).
    if (justInitialised) {
      const indices = centres.map((_, i) => i).sort(
        (a, b) => centres[a].cx - centres[b].cx
      );
      for (let s = 0; s < indices.length && s < 2; s++) {
        slotHand[s] = indices[s];
        bound[indices[s]] = true;
      }
    } else {

    // Pass 1 — spatial proximity (primary signal). Each slot claims the
    // nearest still-unbound hand; once claimed, a hand cannot be stolen by
    // a later slot (the bound[] check runs on every inner iteration, not
    // just once before the loop).
    for (let s = 0; s < 2; s++) {
      let best = -1;
      let bestDist = MAX_MATCH_DIST;
      for (let i = 0; i < hands.length; i++) {
        if (bound[i]) continue;
        const d = Math.hypot(
          centres[i].cx - this.slots[s].cx,
          centres[i].cy - this.slots[s].cy
        );
        if (d < bestDist) {
          bestDist = d;
          best = i;
        }
      }
      if (best >= 0) {
        slotHand[s] = best;
        bound[best] = true;
      }
    }

    // Pass 2 — handedness tiebreaker: ONLY when pass 1 left both slots
    // unassigned (a genuine spatial failure — e.g. every hand is farther than
    // MAX_MATCH_DIST from every slot). If pass 1 already matched a slot by
    // distance, that match stands: distance always dominates, and re-deriving
    // the assignment from labels would silently undo a correct spatial match.
    if (hands.length === 2 && handedness && slotHand[0] < 0 && slotHand[1] < 0) {
      const l0 = handedness[0]?.[0]?.categoryName ?? "";
      const l1 = handedness[1]?.[0]?.categoryName ?? "";
      if (l0 === "Left" && l1 === "Right") {
        slotHand[0] = 0;
        slotHand[1] = 1;
      } else if (l0 === "Right" && l1 === "Left") {
        slotHand[0] = 1;
        slotHand[1] = 0;
      }
    }

    // Pass 3 — any hand that matched no slot fills the remaining empty slot.
    for (let i = 0; i < hands.length; i++) {
      if (!bound[i]) {
        const s = slotHand[0] < 0 ? 0 : slotHand[1] < 0 ? 1 : -1;
        if (s >= 0) {
          slotHand[s] = i;
          bound[i] = true;
        }
      }
    }
    } // end else (!justInitialised)

    // Build the reordered output in slot order (left, then right).
    const ordered: NormalizedLandmark[][] = [];
    const labels: string[] = [];
    const indexMap: number[] = [];
    for (let s = 0; s < 2; s++) {
      const i = slotHand[s];
      if (i < 0) continue;
      ordered.push(hands[i]);
      labels.push(handedness?.[i]?.[0]?.categoryName ?? this.slots[s].label ?? "?");
      indexMap.push(i);
      // Update the slot's last-known centre and label.
      this.slots[s].bound = true;
      this.slots[s].label = handedness?.[i]?.[0]?.categoryName ?? this.slots[s].label;
      this.slots[s].cx = centres[i].cx;
      this.slots[s].cy = centres[i].cy;
    }

    // Slots whose hand disappeared this frame: mark unbound but keep the last
    // centre so a returning hand re-binds to the same slot.
    for (let s = 0; s < 2; s++) {
      if (slotHand[s] < 0) this.slots[s].bound = false;
    }

    return { ordered, labels, indexMap };
  }

  private _centre(hand: NormalizedLandmark[], width: number, height: number): { cx: number; cy: number } {
    const c = handCentre(hand);
    return { cx: c.x * width, cy: c.y * height };
  }
}
