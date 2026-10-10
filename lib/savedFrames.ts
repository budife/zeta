/**
 * Persistent saved-frame store (PART E).
 *
 * When the user double-pinsches with the left hand, the current live frame's
 * four corner coordinates are deep-copied into an immutable snapshot and
 * pushed here. Saved frames never move: they are not fed by the tracker, not
 * smoothed, not updated — frozen exactly as they were at save time.
 *
 * The live frame (StickyFrameTracker + selection machine) and the saved
 * frames are completely separate state. Saving freezes the geometry, not the
 * application: the camera keeps running, MediaPipe keeps detecting, and the
 * user can form a new live frame immediately.
 */

import type { Point } from "./types";

/** One saved frame: stable id + deep-copied corner geometry. */
export type SavedFrame = {
  id: number;
  /** Four corners in video-pixel space, deep-copied at save time. */
  corners: Point[];
};

/**
 * Bounded collection of saved frames. Evicts the oldest when full, so
 * repeated saves never grow without limit (PART H test 16).
 */
export class SavedFrameStore {
  private frames: SavedFrame[] = [];
  private nextId = 1;
  readonly maxFrames: number;

  constructor(maxFrames: number = 8) {
    this.maxFrames = Math.max(1, Math.floor(maxFrames));
  }

  /**
   * Saves a deep copy of `corners`. Returns the saved frame (with its id) or
   * null if the input is not a valid quadrilateral.
   */
  save(corners: readonly Point[]): SavedFrame | null {
    if (corners.length !== 4) return null;
    // Deep copy: the live tracker's corners must never alias saved geometry.
    const copied: Point[] = corners.map((p) => ({ x: p.x, y: p.y }));
    const frame: SavedFrame = { id: this.nextId++, corners: copied };
    this.frames.push(frame);
    if (this.frames.length > this.maxFrames) {
      this.frames.shift(); // evict oldest
    }
    return frame;
  }

  /** All saved frames, oldest first. Read-only — callers must not mutate. */
  getAll(): readonly SavedFrame[] {
    return this.frames;
  }

  /** Corner arrays only (the shape the Snapshot publishes). */
  getCorners(): Point[][] {
    return this.frames.map((f) => f.corners);
  }

  /** Number of saved frames. */
  get count(): number {
    return this.frames.length;
  }

  /** Clears all saved frames (used by reset). */
  clear(): void {
    this.frames = [];
  }
}
