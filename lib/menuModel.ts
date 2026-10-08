/**
 * Menu model: what the HUD lists, and how a hovering fingertip turns into a
 * selection.
 *
 * The menu itself is rendered by React (components/MainMenu.tsx), but the
 * two rules the spec cares about live HERE so they are unit-testable:
 *
 *   - hovering an item highlights it immediately (TEST 4);
 *   - holding the pointer on it for `holdMs` selects it (TEST 5), and any
 *     movement off the item — including onto a different one — restarts the
 *     hold from zero. Time never carries across items.
 *
 * The tracker is layout-agnostic: the renderer hit-tests the pointer against
 * the rendered boxes (stage coordinates via the single coordinate chain) and
 * passes the hovered item's id in. Nothing here knows about pixels, DOM, or
 * the camera.
 */

export const MENU_CONFIG = {
  /**
   * Pointer must stay on an item this long before it is selected (ms).
   * The spec's agreed starting point — tune here, everything follows.
   */
  holdMs: 400,
} as const;

/** The three top-level entries the main menu shows (spec structure). */
export const TOP_LEVEL_ITEMS = ["TEMPLATE", "EFFECTS", "MOTION"] as const;

export type TopLevelItem = (typeof TOP_LEVEL_ITEMS)[number];

/** What the renderer should show this frame. */
export type HoverReadout = {
  /** Item currently under the pointer, or null when off-menu. */
  hover: string | null;
  /** 0..1 completion of the hold on `hover` — drive the ring/fill UI from it. */
  progress: number;
  /** Set on the single frame the hold completes; consume it once. */
  selected: string | null;
};

/**
 * Stateful hover/hold machine. Pure with respect to time: `nowMs` is an
 * argument, never `Date.now()`, so behaviour is deterministic under test.
 */
export class HoverTracker {
  private hoveredId: string | null = null;
  private since = 0;
  private done = false;

  reset(): void {
    this.hoveredId = null;
    this.since = 0;
    this.done = false;
  }

  update(itemId: string | null, nowMs: number): HoverReadout {
    // A different target (including "off the menu") is a fresh hold — the
    // previous item's elapsed time is never credited to the new one.
    if (itemId !== this.hoveredId) {
      this.hoveredId = itemId;
      this.since = nowMs;
      this.done = false;
      return { hover: itemId, progress: 0, selected: null };
    }
    if (!itemId) return { hover: null, progress: 0, selected: null };
    // Already fired for this continuous hover; it fires again only after the
    // pointer leaves and comes back.
    if (this.done) return { hover: itemId, progress: 1, selected: null };

    const progress = Math.min(1, (nowMs - this.since) / MENU_CONFIG.holdMs);
    if (progress >= 1) {
      this.done = true;
      return { hover: itemId, progress: 1, selected: itemId };
    }
    return { hover: itemId, progress, selected: null };
  }
}
