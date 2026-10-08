"use client";

import { useEffect, useMemo, useRef } from "react";
import {
  HoverTracker,
  SUBMENUS,
  hitTestMenu,
  menuLayout,
  type MenuRow,
  type TopLevelItem,
} from "@/lib/menuModel";
import { toStageFraction } from "@/lib/stage";
import type { AppMode, MenuPick, ModeEvent } from "@/lib/modes";
import type { Snapshot } from "@/lib/types";

/**
 * The gesture menu (spec: HUD top-left style panel, pointer + hold-select).
 *
 * Layout AND hit-testing come from `menuLayout()` — stage-fraction boxes in
 * the same space `toStageFraction()` maps the index fingertip into — so the
 * row you see is exactly the row the pointer can hit. Hover/hold runs at
 * frame rate straight against the DOM (subscriptions, never React state);
 * React only re-renders on discrete changes: mode, submenu, active picks.
 *
 * Selection has two doors to the same place: the 400ms dwell (gesture) and
 * native button activation (mouse click / keyboard Enter), so the panel
 * stays usable without a hand.
 */
export type MainMenuProps = {
  subscribe: (listener: (snapshot: Snapshot) => void) => () => void;
  mode: AppMode;
  menuTop: TopLevelItem | null;
  template: string;
  effect: string;
  motion: string;
  onEvent: (event: ModeEvent) => void;
};

/** Which selection highlights each top-level tab. */
const KIND_BY_TOP: Record<TopLevelItem, MenuPick["kind"]> = {
  TEMPLATE: "template",
  EFFECTS: "effect",
  MOTION: "motion",
};

const isMenuMode = (mode: AppMode) => mode === "MENU_OPEN" || mode === "MENU_SELECT";

function boxStyle(box: { x: number; y: number; width: number; height: number }) {
  return {
    position: "absolute" as const,
    left: `${box.x * 100}%`,
    top: `${box.y * 100}%`,
    width: `${box.width * 100}%`,
    height: `${box.height * 100}%`,
  };
}

export function MainMenu({
  subscribe,
  mode,
  menuTop,
  template,
  effect,
  motion,
  onEvent,
}: MainMenuProps) {
  const layout = useMemo(() => menuLayout(mode, menuTop), [mode, menuTop]);
  const selections = { template, effect, motion };

  // Frame-rate machinery lives in refs: the subscription below must always
  // see the latest props without resubscribing on every render.
  const stateRef = useRef({ mode, menuTop, layout, onEvent });
  stateRef.current = { mode, menuTop, layout, onEvent };
  const hoverRef = useRef(new HoverTracker());
  const rowElsRef = useRef(new Map<string, HTMLButtonElement>());
  const prevRef = useRef({ mode, top: menuTop, hoverId: null as string | null });

  const clearHover = (id: string | null) => {
    if (!id) return;
    const el = rowElsRef.current.get(id);
    el?.classList.remove("gesture-menu__row--hover");
    el?.style.removeProperty("--p");
  };

  const selectRow = (row: MenuRow) => {
    const { menuTop: top, onEvent: emit } = stateRef.current;
    if (row.kind === "top") {
      emit({ type: "openSubmenu", top: row.id });
    } else if (top) {
      emit({ type: "itemSelected", item: { kind: KIND_BY_TOP[top], id: row.id } });
    }
  };

  useEffect(() => {
    const off = subscribe((snapshot) => {
      const current = stateRef.current;
      if (!isMenuMode(current.mode)) return;

      // A mode change or a different open submenu swaps the target set —
      // the hold starts over (it must never carry across row sets).
      const prev = prevRef.current;
      if (prev.mode !== current.mode || prev.top !== current.menuTop) {
        hoverRef.current.reset();
        clearHover(prev.hoverId);
        prev.hoverId = null;
        prev.mode = current.mode;
        prev.top = current.menuTop;
      }

      const point = snapshot.pointer
        ? toStageFraction(snapshot.pointer, snapshot.videoWidth, snapshot.videoHeight)
        : null;
      const id = hitTestMenu(current.layout.rows, point);
      const readout = hoverRef.current.update(id, performance.now());

      if (prev.hoverId !== readout.hover) {
        clearHover(prev.hoverId);
        prev.hoverId = readout.hover;
      }
      if (readout.hover) {
        const el = rowElsRef.current.get(readout.hover);
        el?.classList.add("gesture-menu__row--hover");
        el?.style.setProperty("--p", String(readout.progress));
      }
      if (readout.selected) {
        const row = current.layout.rows.find((r) => r.id === readout.selected);
        if (row) selectRow(row);
        // No reset here on purpose: the mode/submenu edge that follows
        // resets the hold, and `done` blocks a re-fire while it lands.
      }
    });
    return () => {
      off();
      hoverRef.current.reset();
      prevRef.current.hoverId = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [subscribe]);

  const title = mode === "MENU_SELECT" && menuTop ? menuTop : "MENU";

  return (
    <div className="gesture-menu" aria-label="Gesture menu">
      <div className="gesture-menu__panel" style={boxStyle(layout.panel)} aria-hidden="true" />
      <div className="gesture-menu__title" style={boxStyle(layout.title)} aria-hidden="true">
        {title}
      </div>
      {layout.rows.map((row) => {
        const active =
          row.kind === "top"
            ? menuTop === row.id
            : menuTop !== null && selections[KIND_BY_TOP[menuTop]] === row.id;
        const label =
          row.kind === "top"
            ? row.id
            : (menuTop ? SUBMENUS[menuTop] : []).find((item) => item.id === row.id)?.label ?? row.id;
        return (
          <button
            key={`${row.kind}-${row.id}`}
            type="button"
            ref={(el) => {
              if (el) rowElsRef.current.set(row.id, el);
              else rowElsRef.current.delete(row.id);
            }}
            className={`gesture-menu__row${active ? " gesture-menu__row--active" : ""}`}
            style={boxStyle(row.box)}
            aria-current={active ? "true" : undefined}
            onClick={() => selectRow(row)}
          >
            <span className="gesture-menu__label">{label}</span>
            {active && (
              <span className="gesture-menu__check" aria-hidden="true">
                ✓
              </span>
            )}
            <span className="gesture-menu__fill" aria-hidden="true" />
          </button>
        );
      })}
    </div>
  );
}
