export interface WindowLike {
  on(event: string, handler: (event: unknown) => void): void;
  close(): void;
  activate?(): void;
}

export interface MainWindowController<W extends WindowLike> {
  readonly window: W | null;
  open(): W;
  close(): void;
  isOpen(): boolean;
}

/**
 * The single main window (spec §10.3): closing it keeps the app running, and `reopen` (Dock click) creates it
 * again. The UI then bootstraps from Main, which owns all session state.
 */
export function createMainWindowController<W extends WindowLike>(deps: {
  create(): W;
  onClosed?(): void;
}): MainWindowController<W> {
  let current: W | null = null;
  return {
    get window() {
      return current;
    },
    open() {
      if (current) {
        current.activate?.();
        return current;
      }
      const created = deps.create();
      current = created;
      created.on("close", () => {
        if (current !== created) return;
        current = null;
        deps.onClosed?.();
      });
      return created;
    },
    close() {
      current?.close();
    },
    isOpen() {
      return current !== null;
    },
  };
}
