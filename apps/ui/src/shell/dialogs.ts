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

export function createDialogs(store: AppStore): Dialogs {
  const pending = new Map<string, (buttonId: string) => void>();
  return {
    confirm(options) {
      const id = crypto.randomUUID();
      return new Promise((resolve) => {
        pending.set(id, resolve);
        store.getState().openModal({ kind: "confirm", id, ...options });
      });
    },
    resolve(id, buttonId) {
      const done = pending.get(id);
      if (!done) return;
      pending.delete(id);
      const modal = store.getState().modal;
      if (modal?.kind === "confirm" && modal.id === id) store.getState().closeModal();
      done(buttonId);
    },
  };
}
