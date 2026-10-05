/**
 * Selection state machine for the hand-made window.
 *
 * The window used to be "active or not" with a plain valid/invalid hysteresis,
 * and its four corners were blanked the instant a single frame failed to yield
 * four corners. That made the media blink: `frameActivity` stayed active for a
 * few invalid frames while `windowCorners` emptied immediately.
 *
 * This machine separates the two concerns:
 *
 *   SEARCHING → CANDIDATE → LOCKED → RELEASING → SEARCHING
 *
 * - SEARCHING: no usable window. Media hidden.
 * - CANDIDATE: a valid quad was just seen; counting up before showing media.
 * - LOCKED:    the window is live. Temporary detection dropouts (a hand missed
 *              for a frame or two) are tolerated: the phase — and therefore the
 *              last smoothed corners — is held until `releaseFrames` frames
 *              have failed in a row. The window still follows the hands in
 *              realtime while locked; "locked" means the *gesture* is
 *              considered valid, not that the coordinates are frozen.
 * - RELEASING: a short tail after losing the gesture, so the media fades out
 *              instead of snapping off, then back to SEARCHING.
 *
 * Pure and stateless on its own — the caller threads `state` through frames.
 */

export type SelectionPhase = "searching" | "candidate" | "locked" | "releasing";

export type SelectionState = {
  phase: SelectionPhase;
  /** Consecutive valid frames (used for the CANDIDATE → LOCKED count-up). */
  validStreak: number;
  /** Consecutive frames that produced no valid quad (invalid or no corners). */
  invalidStreak: number;
  /** Consecutive frames with no corners at all (hand detection dropout). */
  dropoutStreak: number;
  /** Frames remaining in the RELEASING tail before returning to SEARCHING. */
  releaseCountdown: number;
};

export const SELECTION_CONFIG = {
  /** Valid frames required to go CANDIDATE → LOCKED. */
  candidateFrames: 2,
  /** Consecutive failed frames required to leave LOCKED for RELEASING. */
  releaseFrames: 4,
  /** Frames the RELEASING tail lasts before dropping back to SEARCHING. */
  releaseTail: 2,
} as const;

export const INITIAL_SELECTION: SelectionState = {
  phase: "searching",
  validStreak: 0,
  invalidStreak: 0,
  dropoutStreak: 0,
  releaseCountdown: 0,
};

export type SelectionInput = {
  /** `isValidQuad()` result for the corners detected this frame. */
  valid: boolean;
  /** Whether this frame produced four corners at all. */
  hasCorners: boolean;
};

/** Media is shown in LOCKED and throughout the RELEASING tail. */
export function selectionIsActive(phase: SelectionPhase): boolean {
  return phase === "locked" || phase === "releasing";
}

export type SelectionAdvance = {
  state: SelectionState;
  /** The media went from hidden to visible on this frame. */
  activated: boolean;
  /** The media went from visible to hidden on this frame. */
  deactivated: boolean;
};

/**
 * Advances the selection machine by one frame.
 *
 * A valid frame increments the valid streak; an invalid frame – or a frame
 * with no corners at all – increments the invalid streak. While LOCKED the
 * handler keeps the last corners outside this function, so a short dropout
 * changes nothing visible.
 */
export function advanceSelection(
  state: SelectionState,
  input: SelectionInput
): SelectionAdvance {
  const wasActive = selectionIsActive(state.phase);
  let next: SelectionState;

  switch (state.phase) {
    case "searching": {
      next =
        input.valid && input.hasCorners
          ? {
              ...state,
              phase: "candidate",
              validStreak: 1,
              invalidStreak: 0,
              dropoutStreak: 0,
            }
          : { ...INITIAL_SELECTION };
      break;
    }

    case "candidate": {
      if (input.valid && input.hasCorners) {
        const validStreak = state.validStreak + 1;
        next =
          validStreak >= SELECTION_CONFIG.candidateFrames
            ? {
                ...state,
                phase: "locked",
                validStreak,
                invalidStreak: 0,
                dropoutStreak: 0,
              }
            : { ...state, validStreak, invalidStreak: 0, dropoutStreak: 0 };
      } else {
        // One bad frame before locking is enough to start over.
        next = { ...INITIAL_SELECTION };
      }
      break;
    }

    case "locked": {
      if (input.valid && input.hasCorners) {
        next = {
          ...state,
          validStreak: state.validStreak + 1,
          invalidStreak: 0,
          dropoutStreak: 0,
        };
      } else {
        const dropoutStreak = input.hasCorners ? 0 : state.dropoutStreak + 1;
        const invalidStreak = state.invalidStreak + 1;
        next =
          invalidStreak >= SELECTION_CONFIG.releaseFrames
            ? {
                ...state,
                phase: "releasing",
                validStreak: 0,
                invalidStreak,
                dropoutStreak,
                releaseCountdown: SELECTION_CONFIG.releaseTail,
              }
            : { ...state, invalidStreak, dropoutStreak };
      }
      break;
    }

    case "releasing": {
      if (input.valid && input.hasCorners) {
        // The gesture came back inside the tail — re-capture without a full
        // SEARCHING → CANDIDATE round trip.
        next = {
          ...state,
          phase: "locked",
          validStreak: 1,
          invalidStreak: 0,
          dropoutStreak: 0,
          releaseCountdown: 0,
        };
      } else if (state.releaseCountdown <= 1) {
        next = { ...INITIAL_SELECTION };
      } else {
        next = { ...state, releaseCountdown: state.releaseCountdown - 1 };
      }
      break;
    }
  }

  const nowActive = selectionIsActive(next.phase);
  return {
    state: next,
    activated: !wasActive && nowActive,
    deactivated: wasActive && !nowActive,
  };
}