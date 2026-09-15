import type { AppState, AppStore } from "../state/store";
import type { ModelCache, ModelLike } from "./models";
import { createViewStateSaver, type TimerApi } from "./view-state";

/** The slice of a Monaco editor that tab switching needs. `IStandaloneCodeEditor` satisfies it; tests use a fake. */
export interface ViewEditor<M, V> {
  getModel(): M | null;
  setModel(model: M | null): void;
  saveViewState(): V | null;
  restoreViewState(viewState: V): void;
}

export interface TabViewDeps<M extends ModelLike, V> {
  store: AppStore;
  editor: ViewEditor<M, V>;
  models: ModelCache<M>;
  /** Sends a tab's view state to Main (`tab.viewState`). Called synchronously. */
  persist(tabId: string, viewState: V | null): void;
  /** Runs after a different model is shown, or with nulls when no tab is active (content listener, cursor, markers). */
  onShown(tabId: string | null, model: M | null): void;
  /**
   * Replaces a model's content with the store's. Editor.tsx makes it one undoable edit that keeps the cursor and closes
   * the undo group on both sides (M1 T17 fix round, final review T17). Defaults to `model.setValue(value)`.
   */
  applyExternal?(model: M, value: string): void;
  delayMs?: number;
  timers?: TimerApi;
}

export interface TabView<M = ModelLike> {
  show(state: AppState): void;
  readonly activeId: string | null;
  /** True while `show` copies store content into a model, so the content listener can ignore that change. */
  readonly applyingExternal: boolean;
  /** The model's content listener: writes the model's content to the store, unless `show` is applying store content. */
  pushContent(tabId: string, model: M): void;
  saveActive(): void;
  cancel(tabId: string): void;
  flush(): void;
}

/** One model per tab, with per-tab view state (spec §6.1, §10.1). Framework-free, so it is unit-tested. */
export function createTabView<M extends ModelLike, V>(deps: TabViewDeps<M, V>): TabView<M> {
  let activeId: string | null = null;
  let applyingExternal = false;
  let showing = false;
  let rerun = false;
  /** The model content the listener last wrote to the store. Always equal to that model's content while set. */
  let pushed: { model: M; value: string } | null = null;

  const saver = createViewStateSaver(
    (tabId, viewState) => {
      deps.persist(tabId, viewState as V | null);
      // Deferred: zustand notifies subscribers synchronously and the editor's subscription calls show(), so a
      // synchronous store write here re-entered show() in the middle of a tab switch (review C1).
      queueMicrotask(() => deps.store.getState().setViewState(tabId, viewState));
    },
    deps.delayMs,
    deps.timers,
  );

  const render = (state: AppState) => {
    const id = state.activeTabId;
    const tab = id ? state.tabs[id] : undefined;
    if (!id || !tab) {
      activeId = null;
      deps.editor.setModel(null);
      deps.onShown(null, null);
      return;
    }
    if (activeId && activeId !== id) {
      // Switch first, then save the tab being left, so anything the save triggers already sees the new tab.
      const leaving = activeId;
      activeId = id;
      saver.schedule(leaving, deps.editor.saveViewState());
      saver.flush(leaving);
    }
    activeId = id;
    const previousModel = deps.models.get(id);
    // The view state is carried across a language change only (the model is recreated). An unchanged model keeps its
    // own view state, so don't save one on every keystroke (T12-m5, FB-I2).
    const carried =
      previousModel && !deps.models.matches(id, tab.language) && deps.editor.getModel() === previousModel
        ? deps.editor.saveViewState()
        : null;
    const { model, previous } = deps.models.ensure(id, tab.language, state.buffers[id] ?? "");
    if (deps.editor.getModel() !== model) {
      deps.editor.setModel(model);
      const viewState = carried ?? (tab.viewState as V | null);
      if (viewState) deps.editor.restoreViewState(viewState);
      deps.onShown(id, model);
    }
    // T12-m3: the new model is attached (above) before the old one goes away.
    previous?.dispose();
    const code = state.buffers[id] ?? "";
    // FB-I2: the buffer is usually the exact string the content listener just read from this model, so the model
    // already holds it and a full-buffer compare can be skipped.
    const justPushed = pushed !== null && pushed.model === model && pushed.value === code;
    if (!justPushed && model.getValue() !== code) {
      pushed = null;
      applyingExternal = true;
      try {
        (deps.applyExternal ?? ((target: M, value: string) => target.setValue(value)))(model, code);
      } finally {
        applyingExternal = false;
      }
    }
  };

  const show = (state: AppState) => {
    if (showing) {
      rerun = true;
      return;
    }
    showing = true;
    try {
      render(state);
    } finally {
      showing = false;
    }
    if (rerun) {
      rerun = false;
      show(deps.store.getState());
    }
  };

  return {
    show,
    get activeId() {
      return activeId;
    },
    get applyingExternal() {
      return applyingExternal;
    },
    pushContent(tabId, model) {
      if (applyingExternal) return;
      const value = model.getValue();
      pushed = { model, value };
      deps.store.getState().editCode(value, tabId);
    },
    saveActive() {
      if (activeId) saver.schedule(activeId, deps.editor.saveViewState());
    },
    cancel(tabId) {
      saver.cancel(tabId);
    },
    flush() {
      saver.flush();
    },
  };
}
