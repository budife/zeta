/**
 * Application mode machine — the frame is gated by mode, not by geometry.
 *
 * Before this machine existed, any two-hand L immediately produced a window:
 * the camera coming on was the only "mode" there was. The spec (AK / TEST 1)
 * requires frame search to stay DISABLED until the user has picked a menu
 * item, and requires each gesture family to belong to exactly one mode
 * family (AC) — so the gate is a state machine, not more gesture math.
 *
 * The chain:
 *
 *   IDLE → MENU_OPEN → MENU_SELECT → FRAME_SEARCH → FRAME_LOCKED → RESETTING → IDLE
 *
 * with two loops:
 *
 *   FRAME_LOCKED → (openMenu)  → MENU_OPEN   — the menu may open over a live
 *                                               frame (TEST 11: geometry is
 *                                               preserved, no fresh L needed);
 *   FRAME_LOCKED → (released)  → FRAME_SEARCH — sustained hand loss hands the
 *                                               user back to frame search.
 *
 * Pure and stateless: the caller threads the mode through, and `advanceMode`
 * is a total function — an event that is not legal in the current mode is a
 * no-op rather than a throw, because every caller (swipe detector, menu UI,
 * selection machine) only knows about its own slice of the graph.
 *
 * This file has no imports: it is the one piece of the pipeline that runs
 * before any coordinate, landmark, or pixel exists.
 */

/** Every mode the application can be in. */
export type AppMode =
  | "IDLE"
  | "MENU_OPEN"
  | "MENU_SELECT"
  | "FRAME_SEARCH"
  | "FRAME_LOCKED"
  | "RESETTING";

/** Camera on, no menu, no frame. Frame formation is disabled here. */
export const INITIAL_MODE: AppMode = "IDLE";

/**
 * Events that can move the machine. Named after what happened in the UI,
 * not after the mode being entered, so callers never need to know the graph.
 */
export type ModeEvent =
  /** Two-finger swipe down (IDLE / FRAME_SEARCH / FRAME_LOCKED). */
  | { type: "openMenu" }
  /** Pointer picked TEMPLATE / EFFECTS / MOTION. */
  | { type: "openSubmenu" }
  /** Pointer finished hold-selecting an item — frame search becomes enabled. */
  | { type: "itemSelected" }
  /** The selection machine locked a window. */
  | { type: "frameLocked" }
  /** The selection machine released the window (sustained hand loss). */
  | { type: "frameReleased" }
  /** Two-finger swipe left (FRAME_LOCKED): begin clearing everything. */
  | { type: "reset" }
  /** The reset finished clearing; settle back to IDLE. */
  | { type: "resetDone" };

/**
 * Legal transitions. Anything not listed is a no-op: e.g. `frameLocked` in
 * IDLE cannot happen because the engine never advances the selection machine
 * outside FRAME_SEARCH/FRAME_LOCKED in the first place — this table is the
 * second line of defence, and the test that pins the graph.
 */
const TRANSITIONS: Record<AppMode, Partial<Record<ModeEvent["type"], AppMode>>> = {
  IDLE: {
    openMenu: "MENU_OPEN",
  },
  MENU_OPEN: {
    openSubmenu: "MENU_SELECT",
  },
  MENU_SELECT: {
    openSubmenu: "MENU_SELECT", // switching TEMPLATE ↔ EFFECTS ↔ MOTION
    itemSelected: "FRAME_SEARCH",
  },
  FRAME_SEARCH: {
    openMenu: "MENU_OPEN", // change the selection without locking first
    frameLocked: "FRAME_LOCKED",
  },
  FRAME_LOCKED: {
    openMenu: "MENU_OPEN",
    frameReleased: "FRAME_SEARCH",
    reset: "RESETTING",
  },
  RESETTING: {
    resetDone: "IDLE",
  },
};

/** Advances the mode machine; illegal events leave the mode unchanged. */
export function advanceMode(mode: AppMode, event: ModeEvent): AppMode {
  return TRANSITIONS[mode][event.type] ?? mode;
}

/**
 * The gesture families. Each one is watched by exactly one detector and is
 * only allowed in the modes where its meaning is unambiguous (spec AC):
 *
 *   handFrame   FRAME_SEARCH (acquire) / FRAME_LOCKED (track)
 *   pointer     MENU_OPEN / MENU_SELECT — the menu's index fingertip
 *   pinch       FRAME_LOCKED — double-pinch cycles the effect
 *   swipeDown   IDLE / FRAME_SEARCH / FRAME_LOCKED — open the menu
 *   swipeLeft   FRAME_LOCKED — reset everything
 */
export type Gesture = "handFrame" | "pointer" | "pinch" | "swipeDown" | "swipeLeft";

const ALLOWED_GESTURES: Record<AppMode, readonly Gesture[]> = {
  IDLE: ["swipeDown"],
  MENU_OPEN: ["pointer"],
  MENU_SELECT: ["pointer"],
  FRAME_SEARCH: ["handFrame", "swipeDown"],
  FRAME_LOCKED: ["handFrame", "pinch", "swipeDown", "swipeLeft"],
  RESETTING: [],
};

/** Whether a gesture family is live in the given mode. */
export function gestureAllowed(mode: AppMode, gesture: Gesture): boolean {
  return ALLOWED_GESTURES[mode].includes(gesture);
}

/**
 * Whether frame formation (the two-hand L → window path) runs in this mode.
 * The engine gates BOTH the tracker feed and the selection machine on this,
 * so a perfect L in IDLE produces nothing and an open menu can neither
 * fabricate nor destroy a window.
 */
export function handFrameAllowed(mode: AppMode): boolean {
  return gestureAllowed(mode, "handFrame");
}
