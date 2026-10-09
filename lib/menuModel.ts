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
 * `menuLayout()`'s boxes (stage coordinates via the single coordinate chain)
 * and passes the hovered item's id in. The SAME boxes drive both the CSS
 * placement and the hit-test, so what you see is exactly what you can point
 * at. Nothing here knows about pixels of the camera, the DOM, or MediaPipe.
 */

import type { AppMode, MenuPick } from "./modes";

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

/** One selectable menu line: a stable id (selections, asset paths) + a label. */
export type MenuItemDef = { id: string; label: string };

const characters: MenuItemDef[] = Array.from({ length: 10 }, (_, i) => {
  const n = String(i + 1).padStart(2, "0");
  return { id: `character-${n}`, label: `Character ${n}` };
});

/** TEMPLATE: bundled assets + overlay templates + upload row. */
export const TEMPLATE_ITEMS: MenuItemDef[] = [
  { id: "template", label: "Template" },
  ...characters,
  { id: "face-wireframe", label: "Face Wireframe" },
  { id: "cyber-mask", label: "Cyber Mask" },
  { id: "skeleton-overlay", label: "Skeleton Overlay" },
  { id: "sci-fi-hud", label: "Sci-Fi HUD" },
  { id: "upload", label: "Upload Media" },
];

/** EFFECTS: all 19 canvas effects. No "none" row — leaving the effect
 *  category (by picking a template/motion) is what turns it off. */
export const EFFECT_ITEMS: MenuItemDef[] = [
  { id: "blur", label: "Blur" },
  { id: "rain", label: "Rain" },
  { id: "snow", label: "Snow" },
  { id: "fog", label: "Fog" },
  { id: "cyberpunk", label: "Cyberpunk" },
  { id: "glitch", label: "Glitch" },
  { id: "comic", label: "Comic" },
  { id: "ascii-live", label: "Live ASCII" },
  { id: "ascii-matrix", label: "Matrix Human" },
  { id: "ascii-rgb", label: "RGB ASCII Glitch" },
  { id: "ascii-trail", label: "ASCII Motion Trail" },
  { id: "ascii-holo", label: "Holographic ASCII" },
  { id: "thermal", label: "Thermal" },
  { id: "film", label: "Film Grain" },
  { id: "heat", label: "Heat Haze" },
  { id: "holo", label: "Hologram" },
  { id: "neon", label: "Neon Glow" },
  { id: "particles", label: "Particles" },
  { id: "portal", label: "Portal" },
];

/** MOTION: 5 CSS motions + 5 canvas MotionEngine motions. No "none" row. */
export const MOTION_ITEMS: MenuItemDef[] = [
  { id: "shake", label: "Shake" },
  { id: "float", label: "Float" },
  { id: "zoom", label: "Zoom" },
  { id: "pulse", label: "Pulse" },
  { id: "parallax", label: "Parallax" },
  { id: "reality-zoom", label: "Reality Zoom" },
  { id: "echo", label: "Time Echo" },
  { id: "freeze", label: "Time Freeze" },
  { id: "shutter", label: "Slow Shutter" },
  { id: "portal", label: "Portal Motion" },
];

/** Submenu body per top-level entry. */
export const SUBMENUS: Record<TopLevelItem, MenuItemDef[]> = {
  TEMPLATE: TEMPLATE_ITEMS,
  EFFECTS: EFFECT_ITEMS,
  MOTION: MOTION_ITEMS,
};

/**
 * The EMPTY content state (spec §22): contentMode null = "nothing is
 * showing". This is what a fresh engine and any reset (gesture or
 * camera-off) leave behind — until the user completes a menu pick, the
 * window (when it can form) reveals the raw camera only. The three values
 * here are the nullable defaults every non-active category falls back to
 * inside `selectionPatch`.
 */
export const EMPTY_SELECTION = { template: null, effect: null, motion: null } as const;

// ---------------------------------------------------------------------------
// Layout — stage FRACTIONS (0..1), the same space the mirrored pointer maps
// to through toStageFraction(). One function feeds both the renderer's CSS
// and the hit-test, so they cannot drift.
// ---------------------------------------------------------------------------

/** An axis-aligned box in stage fractions (0..1 of the stage). */
export type MenuBox = { x: number; y: number; width: number; height: number };

export type MenuRow = {
  id: string;
  /** `top` = the three tabs; `sub` = the open submenu's items. */
  kind: "top" | "sub";
  box: MenuBox;
};

export type MenuLayout = {
  /** Panel backdrop behind title + rows. */
  panel: MenuBox;
  /** Decorative heading (not interactive). */
  title: MenuBox;
  /** Interactive rows, top to bottom — the hit-test targets. */
  rows: MenuRow[];
};

/**
 * Geometry constants, tuned to keep the longest list (TEMPLATE: 3 tabs +
 * 16 items = 19 rows) inside a 16:9 stage with margin to spare.
 */
const L = {
  right: 0.035, // panel's distance from the stage's right edge
  top: 0.035,
  width: 0.17,
  pad: 0.008, // inner padding of the panel (stage fraction)
  titleH: 0.032,
  rowH: 0.036,
  gap: 0.003, // between rows
  bodyGap: 0.012, // extra break between the tabs and the submenu body
} as const;

/**
 * The menu's boxes for this mode. In MENU_OPEN only the three top tabs are
 * interactive; MENU_SELECT adds the open submenu's body below them. `top`
 * falls back to the first entry so MENU_SELECT always has a body.
 */
export function menuLayout(mode: AppMode, top: TopLevelItem | null): MenuLayout {
  const activeTop: TopLevelItem = top ?? TOP_LEVEL_ITEMS[0];
  const x = 1 - L.right - L.width;
  const rowsX = x + L.pad;
  const rowsW = L.width - 2 * L.pad;
  const titleY = L.top + L.pad;
  const rowsStart = titleY + L.titleH + L.gap;

  const rows: MenuRow[] = TOP_LEVEL_ITEMS.map((id, i) => ({
    id,
    kind: "top" as const,
    box: { x: rowsX, y: rowsStart + i * (L.rowH + L.gap), width: rowsW, height: L.rowH },
  }));

  let lastBottom = rows[rows.length - 1].box.y + L.rowH;
  if (mode === "MENU_SELECT") {
    const bodyStart = lastBottom + L.gap + L.bodyGap;
    for (const [j, item] of SUBMENUS[activeTop].entries()) {
      rows.push({
        id: item.id,
        kind: "sub" as const,
        box: { x: rowsX, y: bodyStart + j * (L.rowH + L.gap), width: rowsW, height: L.rowH },
      });
    }
    lastBottom = rows[rows.length - 1].box.y + L.rowH;
  }

  return {
    panel: { x, y: L.top, width: L.width, height: lastBottom + L.pad - L.top },
    title: { x: rowsX, y: titleY, width: rowsW, height: L.titleH },
    rows,
  };
}

/**
 * The three categories are mutually exclusive (user rule: template, effect
 * and motion never run together — picking one is THE content mode). A pick
 * in one category sets `contentMode` to it and its value, and pushes the
 * other two back to null (nothing showing). One function, so the engine's
 * menu path and its double-pinch path can't disagree about what "one at a
 * time" means.
 */
export function selectionPatch(kind: MenuPick["kind"], id: string): {
  contentMode: MenuPick["kind"];
  template: string | null;
  effect: string | null;
  motion: string | null;
} {
  return {
    contentMode: kind,
    template: kind === "template" ? id : null,
    effect: kind === "effect" ? id : null,
    motion: kind === "motion" ? id : null,
  };
}

/** Which selection category a top-level entry owns. */
const CATEGORY_BY_TOP: Record<TopLevelItem, MenuPick["kind"]> = {
  TEMPLATE: "template",
  EFFECTS: "effect",
  MOTION: "motion",
};

/**
 * Whether a menu row may show the "this is selected" check.
 *
 * The rule is category-first: a row is live only when its CATEGORY is the
 * active `contentMode`, and then only when its value is the active value.
 * That yields exactly one live row per menu: the tab of the live category
 * (when its submenu is closed), or the picked item inside it (when it is
 * open). With `contentMode === null` (fresh state, or after a reset) no row
 * is live at all — there is no content to highlight.
 */
export function isLiveRow(
  kind: "top" | "sub",
  id: string,
  openTop: TopLevelItem | null,
  contentMode: MenuPick["kind"] | null,
  selection: { template: string | null; effect: string | null; motion: string | null }
): boolean {
  if (!contentMode) return false;
  if (kind === "top") return CATEGORY_BY_TOP[id as TopLevelItem] === contentMode;
  if (!openTop) return false;
  const category = CATEGORY_BY_TOP[openTop];
  if (contentMode !== category) return false;
  return selection[category] === id;
}

/**
 * Which row the pointer is over, in stage fractions. Null for no pointer or
 * off-menu (including the gaps between rows — those belong to nobody).
 */
export function hitTestMenu(rows: MenuRow[], point: { x: number; y: number } | null): string | null {
  if (!point) return null;
  for (const row of rows) {
    const b = row.box;
    if (point.x >= b.x && point.x <= b.x + b.width && point.y >= b.y && point.y <= b.y + b.height) {
      return row.id;
    }
  }
  return null;
}

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
