import type { AppStore, ConfirmButton } from "../state/store";

export interface ConfirmOptions {
  title: string;
  message: string;
  buttons: ConfirmButton[];
}

export interface Dialogs {
  /** Shows a confirm modal and resolves with the chosen button id. */
  confirm(options: ConfirmOptions): Promise<string>;
  resolve(id: string, buttonId: string): void;
}

/** The button a dismissed confirm answers with: its cancel button, else its first button. */
export function cancelButtonId(buttons: readonly ConfirmButton[]): string {
  return buttons.find((b) => b.role === "cancel")?.id ?? buttons[0]?.id ?? "cancel";
}

export function createDialogs(store: AppStore): Dialogs {
  const pending = new Map<string, { done: (buttonId: string) => void; cancelId: string }>();

  // Menu commands and Main messages (e.g. file.saveAsConfirm) can open a modal while a confirm is showing. A confirm
  // that is no longer the shown modal, whether replaced or closed by any path, settles as cancelled so nothing waiting
  // on it hangs (fix round 1, I-2).
  store.subscribe((state) => {
    const shownId = state.modal?.kind === "confirm" ? state.modal.id : null;
    for (const [id, entry] of [...pending]) {
      if (id === shownId) continue;
      pending.delete(id);
      entry.done(entry.cancelId);
    }
  });

  return {
    confirm(options) {
      const id = crypto.randomUUID();
      return new Promise((resolve) => {
        pending.set(id, { done: resolve, cancelId: cancelButtonId(options.buttons) });
        store.getState().openModal({ kind: "confirm", id, ...options });
      });
    },
    resolve(id, buttonId) {
      const entry = pending.get(id);
      if (!entry) return;
      // Removed before closing the modal, so the subscription doesn't settle it as cancelled.
      pending.delete(id);
      const modal = store.getState().modal;
      if (modal?.kind === "confirm" && modal.id === id) store.getState().closeModal();
      entry.done(buttonId);
    },
  };
}
