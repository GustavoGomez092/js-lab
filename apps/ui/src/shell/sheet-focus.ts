import { type RefObject, useEffect } from "react";
import { getEditorHandle } from "../editor/editor-handle";

const FOCUSABLE_SELECTOR = 'input:not([disabled]), button:not([disabled]), summary, select, [tabindex="0"]';

/** A candidate is skipped when it's hidden, unless it's `position: fixed` (fix round 1, N-3): a fixed element
 * naturally has `offsetParent === null` in a real browser even while visible, so it must not be filtered out
 * by that check alone. */
function isVisible(element: HTMLElement): boolean {
  if (element.hidden || element.getAttribute("aria-hidden") === "true") return false;
  if (element.style.position === "fixed") return true;
  return element.offsetParent !== null;
}

/**
 * Shared focus behaviour for modal sheets (R25-1: EnvVarsSheet here, the NPM sheet in Task 26).
 * - Records `document.activeElement` when the sheet opens.
 * - On close or unmount, restores that element, or falls back to the editor when it's gone
 *   (the same guard as ConfirmDialog's FB-m2 and RenameDialog's m-1).
 * - Tab / Shift+Tab cycle within `sheet`'s visible focusable elements, so focus can't reach Monaco behind the
 *   scrim (ConfirmDialog's FB-m2 loop, generalized to an arbitrary sheet). Tab is always prevented while open,
 *   even with zero focusable candidates, so focus can never leave the sheet (fix round 1, N-3).
 * - Never sets initial focus: each sheet keeps its own (New key for env, search for npm).
 */
export function useSheetFocus(open: boolean, sheet: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    if (!open) return;
    const opener = document.activeElement;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Tab") return;
      event.preventDefault();
      const root = sheet.current;
      if (!root) return;
      const focusable = [...root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)].filter(isVisible);
      if (focusable.length === 0) return;
      const index = focusable.indexOf(document.activeElement as HTMLElement);
      const step = event.shiftKey ? -1 : 1;
      const next = index < 0 ? (event.shiftKey ? focusable.length - 1 : 0) : index + step;
      focusable[(next + focusable.length) % focusable.length]?.focus();
    };
    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("keydown", onKeyDown, true);
      if (opener instanceof HTMLElement && opener !== document.body && document.contains(opener)) opener.focus();
      else getEditorHandle()?.focus();
    };
  }, [open, sheet]);
}
