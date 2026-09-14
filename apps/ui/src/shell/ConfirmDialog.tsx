import { useEffect, useRef } from "react";
import { useStore } from "zustand";
import type { AppStore } from "../state/store";
import type { Dialogs } from "./dialogs";

export function ConfirmDialog({ store, dialogs }: { store: AppStore; dialogs: Dialogs }) {
  const modal = useStore(store, (s) => s.modal);
  const primary = useRef<HTMLButtonElement>(null);
  const confirm = modal?.kind === "confirm" ? modal : null;

  useEffect(() => {
    if (confirm) primary.current?.focus();
  }, [confirm]);

  if (!confirm) return null;
  const pick = (buttonId: string) => dialogs.resolve(confirm.id, buttonId);
  const fallback = confirm.buttons.find((b) => b.role === "cancel")?.id ?? confirm.buttons[0]?.id ?? "cancel";

  return (
    <div className="dialog-backdrop">
      <div
        className="dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="confirm-title"
        aria-describedby="confirm-message"
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            pick(fallback);
          } else if (event.key === "Enter") {
            const main = confirm.buttons.find((b) => b.role === "primary");
            if (main) {
              event.preventDefault();
              pick(main.id);
            }
          } else if (event.metaKey && event.code === "KeyD" && confirm.buttons.some((b) => b.id === "discard")) {
            event.preventDefault();
            pick("discard");
          }
        }}
      >
        <h2 id="confirm-title">{confirm.title}</h2>
        <p id="confirm-message">{confirm.message}</p>
        <div className="dialog-actions">
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
