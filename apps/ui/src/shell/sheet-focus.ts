import { type RefObject, useEffect } from "react";
import { getEditorHandle } from "../editor/editor-handle";

const FOCUSABLE_SELECTOR = 'input:not([disabled]), button:not([disabled]), summary, select, [tabindex="0"]';

/**
 * Shared focus behaviour for modal sheets (R25-1: EnvVarsSheet here, the NPM sheet in Task 26).
 * - Records `document.activeElement` when the sheet opens.
 * - On close or unmount, restores that element, or falls back to the editor when it's gone
 *   (the same guard as ConfirmDialog's FB-m2 and RenameDialog's m-1).
 * - Tab / Shift+Tab cycle within `sheet`'s focusable elements, so focus can't reach Monaco behind the scrim
 *   (ConfirmDialog's FB-m2 loop, generalized to an arbitrary sheet).
 * - Never sets initial focus: each sheet keeps its own (New key for env, search for npm).
 */
export function useSheetFocus(open: boolean, sheet: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    if (!open) return;
    const opener = document.activeElement;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Tab") return;
      const root = sheet.current;
      if (!root) return;
      const focusable = [...root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)];
      if (focusable.length === 0) return;
      event.preventDefault();
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
