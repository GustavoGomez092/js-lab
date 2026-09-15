import { useEffect, useRef } from "react";
import { useStore } from "zustand";
import { getEditorHandle } from "../editor/editor-handle";
import type { AppStore } from "../state/store";
import { cancelButtonId, type Dialogs } from "./dialogs";

export function ConfirmDialog({ store, dialogs }: { store: AppStore; dialogs: Dialogs }) {
  const modal = useStore(store, (s) => s.modal);
  const primary = useRef<HTMLButtonElement>(null);
  const actions = useRef<HTMLDivElement>(null);
  const confirm = modal?.kind === "confirm" ? modal : null;

  useEffect(() => {
    if (!confirm) return;
    // FB-m2: whatever had focus when the confirm opened (the editor, a tab, a menu item) gets it back on close, like
    // RenameDialog and the palette, so a Vim user's next keystrokes don't go to <body>.
    const opener = document.activeElement;
    primary.current?.focus();
    // Listens on the document, not the dialog element, so Enter, Escape and ⌘D keep working after a click on the
    // backdrop moves focus off the dialog's buttons (fix round 1, m-5).
    const onKeyDown = (event: KeyboardEvent) => {
      const pick = (buttonId: string) => {
        event.preventDefault();
        dialogs.resolve(confirm.id, buttonId);
      };
      if (event.key === "Tab") {
        // FB-m2: Tab cycles through the dialog's buttons, so focus can't reach Monaco behind the backdrop.
        event.preventDefault();
        const buttons = [...(actions.current?.querySelectorAll("button") ?? [])];
        if (buttons.length === 0) return;
        const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
        const step = event.shiftKey ? -1 : 1;
        const next = index < 0 ? (event.shiftKey ? buttons.length - 1 : 0) : index + step;
        buttons[(next + buttons.length) % buttons.length]?.focus();
      } else if (event.key === "Escape") {
        pick(cancelButtonId(confirm.buttons));
      } else if (event.key === "Enter") {
        const main = confirm.buttons.find((b) => b.role === "primary");
        if (main) pick(main.id);
      } else if (event.metaKey && event.code === "KeyD" && confirm.buttons.some((b) => b.id === "discard")) {
        pick("discard");
      }
    };
    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("keydown", onKeyDown, true);
      if (opener instanceof HTMLElement && opener !== document.body && document.contains(opener)) opener.focus();
      else getEditorHandle()?.focus();
    };
  }, [confirm, dialogs]);

  if (!confirm) return null;
  const pick = (buttonId: string) => dialogs.resolve(confirm.id, buttonId);

  return (
    <div className="dialog-backdrop">
      <div
        className="dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="confirm-title"
        aria-describedby="confirm-message"
      >
        <h2 id="confirm-title">{confirm.title}</h2>
        <p id="confirm-message">{confirm.message}</p>
        <div className="dialog-actions" ref={actions}>
          {confirm.buttons.map((button) => (
            <button
              key={button.id}
              ref={button.role === "primary" ? primary : undefined}
              type="button"
              className={button.role === "primary" ? "primary" : button.role === "danger" ? "danger" : undefined}
              onClick={() => pick(button.id)}
            >
              {button.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
