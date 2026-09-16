import { describe, expect, mock, test } from "bun:test";
import { createTab, defaultSettings, type Language, normalizeSession, sessionSchema } from "@jslab/shared";
import { ModelCache } from "../src/editor/models";
import { createTabView, type ViewEditor } from "../src/editor/tab-view";
import { createAppStore } from "../src/state/store";

class FakeModel {
  constructor(
    public value: string,
    public language: Language,
  ) {}
  getValue() {
    return this.value;
  }
  setValue(value: string) {
    this.value = value;
  }
  dispose() {}
}

type FakeViewState = { value: string };

class FakeEditor implements ViewEditor<FakeModel, FakeViewState> {
  model: FakeModel | null = null;
  setModelCalls = 0;
  getModel() {
    return this.model;
  }
  setModel(model: FakeModel | null) {
    this.model = model;
    this.setModelCalls++;
  }
  saveViewState() {
    return this.model ? { value: this.model.getValue() } : null;
  }
  restoreViewState(_viewState: FakeViewState) {}
}

describe("tab view", () => {
  test("switching tabs through the store saves the leaving tab once and never re-enters show (review C1)", async () => {
    const store = createAppStore();
    store.getState().hydrate({
      settings: defaultSettings(),
      session: normalizeSession(
        sessionSchema.parse({
          tabOrder: ["a", "b"],
          activeTabId: "a",
          tabs: { a: createTab({ id: "a" }), b: createTab({ id: "b" }) },
        }),
      ),
      buffers: { a: "const a = 1", b: "const b = 2" },
      safeMode: { active: false, reason: null },
      versions: { app: "0", bun: "1.4.0" },
    });
    const editor = new FakeEditor();
    const persist = mock((_tabId: string, _viewState: FakeViewState | null) => {});
    const view = createTabView({
      store,
      editor,
      models: new ModelCache((_id, language: Language, value: string) => new FakeModel(value, language)),
      persist,
      onShown: () => {},
      timers: { setTimeout: () => 0, clearTimeout: () => {} },
    });
    // The same subscription condition Editor.tsx uses.
    const unsubscribe = store.subscribe((state, previous) => {
      if (
        state.activeTabId !== previous.activeTabId ||
        state.tabs !== previous.tabs ||
        state.buffers !== previous.buffers
      ) {
        view.show(state);
      }
    });
    view.show(store.getState());

    expect(() => store.getState().activateTab("b")).not.toThrow();
    await Promise.resolve();
    expect(persist.mock.calls).toEqual([["a", { value: "const a = 1" }]]);
    expect(store.getState().tabs.a?.viewState).toEqual({ value: "const a = 1" });
    expect([view.activeId, editor.model?.getValue(), editor.setModelCalls]).toEqual(["b", "const b = 2", 2]);
    unsubscribe();
  });

  test("store-driven content goes through applyExternal inside the applyingExternal guard (final review T17)", () => {
    const store = createAppStore();
    store.getState().hydrate({
      settings: defaultSettings(),
      session: normalizeSession(
        sessionSchema.parse({ tabOrder: ["a"], activeTabId: "a", tabs: { a: createTab({ id: "a" }) } }),
      ),
      buffers: { a: "const a = 1" },
      safeMode: { active: false, reason: null },
      versions: { app: "0", bun: "1.4.0" },
    });
    const editor = new FakeEditor();
    const applied: [string, boolean][] = [];
    const view = createTabView({
      store,
      editor,
      models: new ModelCache((_id, language: Language, value: string) => new FakeModel(value, language)),
      persist: () => {},
      onShown: () => {},
      applyExternal: (model, value) => {
        applied.push([value, view.applyingExternal]);
        model.setValue(value);
      },
      timers: { setTimeout: () => 0, clearTimeout: () => {} },
    });
    view.show(store.getState());
    expect(applied).toEqual([]);
    store.getState().editCode("const a = 10", "a");
    view.show(store.getState());
    expect(applied).toEqual([["const a = 10", true]]);
    expect([editor.model?.getValue(), view.applyingExternal]).toEqual(["const a = 10", false]);
  });

  // FB-I2 / T12-m5: typing pushes the model's content into the store, and the store update calls show() again.
  // That show must not read the whole model back to compare, nor save a view state it never uses.
  test("a buffer the content listener just pushed skips the model compare, and an unchanged model skips saveViewState (FB-I2)", () => {
    const store = createAppStore();
    store.getState().hydrate({
      settings: defaultSettings(),
      session: normalizeSession(
        sessionSchema.parse({ tabOrder: ["a"], activeTabId: "a", tabs: { a: createTab({ id: "a" }) } }),
      ),
      buffers: { a: "const a = 1" },
      safeMode: { active: false, reason: null },
      versions: { app: "0", bun: "1.4.0" },
    });
    let reads = 0;
    class CountingModel extends FakeModel {
      override getValue() {
        reads++;
        return this.value;
      }
    }
    let saves = 0;
    class CountingEditor extends FakeEditor {
      override saveViewState() {
        saves++;
        return { value: "view" };
      }
    }
    const editor = new CountingEditor();
    const applied: string[] = [];
    const view = createTabView({
      store,
      editor,
      models: new ModelCache((_id, language: Language, value: string) => new CountingModel(value, language)),
      persist: () => {},
      onShown: () => {},
      applyExternal: (model, value) => {
        applied.push(value);
        model.setValue(value);
      },
      timers: { setTimeout: () => 0, clearTimeout: () => {} },
    });
    view.show(store.getState());
    const model = editor.model as FakeModel;

    // Typing: the model changes, the listener pushes it, and the store update shows the tab again.
    model.value = "const a = 12";
    [reads, saves] = [0, 0];
    view.pushContent("a", model);
    view.show(store.getState());
    expect([store.getState().buffers.a, reads, saves, applied]).toEqual(["const a = 12", 1, 0, []]);

    // A store-driven change is still compared and applied, and afterwards the old pushed string is forgotten.
    store.getState().editCode("const a = 1", "a");
    view.show(store.getState());
    expect([applied, model.value]).toEqual([["const a = 1"], "const a = 1"]);
    model.value = "typed";
    store.getState().editCode("const a = 12", "a");
    view.show(store.getState());
    expect(model.value).toBe("const a = 12");
  });

  function twoTabs(active: "a" | "b" = "a") {
    const store = createAppStore();
    store.getState().hydrate({
      settings: defaultSettings(),
      session: normalizeSession(
        sessionSchema.parse({
          tabOrder: ["a", "b"],
          activeTabId: active,
          tabs: { a: createTab({ id: "a" }), b: createTab({ id: "b" }) },
        }),
      ),
      buffers: { a: "const a = 1", b: "const b = 2" },
      safeMode: { active: false, reason: null },
      versions: { app: "0", bun: "1.4.0" },
    });
    return store;
  }

  function manualTimers() {
    const pending: (() => void)[] = [];
    return {
      timers: { setTimeout: (callback: () => void) => pending.push(callback), clearTimeout: () => {} },
      fire: () => {
        for (const callback of pending.splice(0)) callback();
      },
    };
  }

  test("closing the active tab flushes its view state once on the switch and never after the prune (T12-m1)", async () => {
    const store = twoTabs("a");
    const editor = new FakeEditor();
    const models = new ModelCache((_id, language: Language, value: string) => new FakeModel(value, language));
    const persist = mock((_tabId: string, _viewState: FakeViewState | null) => {});
    const { timers, fire } = manualTimers();
    const view = createTabView({ store, editor, models, persist, onShown: () => {}, timers });
    const unsubscribe = store.subscribe((state, previous) => {
      if (
        state.activeTabId !== previous.activeTabId ||
        state.tabs !== previous.tabs ||
        state.buffers !== previous.buffers
      )
        view.show(state);
      if (state.tabOrder !== previous.tabOrder)
        for (const closed of models.prune(new Set(state.tabOrder))) view.cancel(closed);
    });
    view.show(store.getState());
    view.saveActive();
    store.getState().removeTab("a", "b");
    fire();
    await Promise.resolve();
    expect(persist.mock.calls.map((call) => call[0])).toEqual(["a"]);
    expect(editor.model?.getValue()).toBe("const b = 2");
    unsubscribe();
  });

  test("closing the last tab cancels its pending view-state save (T12-m1)", async () => {
    const store = twoTabs("a");
    store.getState().removeTab("b", "a");
    const editor = new FakeEditor();
    const models = new ModelCache((_id, language: Language, value: string) => new FakeModel(value, language));
    const persist = mock(() => {});
    const { timers, fire } = manualTimers();
    const view = createTabView({ store, editor, models, persist, onShown: () => {}, timers });
    view.show(store.getState());
    view.saveActive();
    store.getState().removeTab("a", null);
    view.show(store.getState());
    for (const closed of models.prune(new Set(store.getState().tabOrder))) view.cancel(closed);
    fire();
    await Promise.resolve();
    expect(persist).not.toHaveBeenCalled();
    expect(editor.model).toBeNull();
  });

  test("a language change attaches the new model before the old one is disposed (T12-m3)", () => {
    const store = twoTabs("a");
    let swappedFromDisposed = false;
    class WatchingEditor extends FakeEditor {
      override setModel(model: FakeModel | null) {
        if ((this.model as (FakeModel & { disposed?: boolean }) | null)?.disposed) swappedFromDisposed = true;
        super.setModel(model);
      }
    }
    class DisposableModel extends FakeModel {
      disposed = false;
      override dispose() {
        this.disposed = true;
      }
    }
    const editor = new WatchingEditor();
    const models = new ModelCache((_id, language: Language, value: string) => new DisposableModel(value, language));
    const view = createTabView({
      store,
      editor,
      models,
      persist: () => {},
      onShown: () => {},
      timers: manualTimers().timers,
    });
    view.show(store.getState());
    const first = editor.model as DisposableModel;
    store.getState().setLanguage("tsx");
    view.show(store.getState());
    expect(swappedFromDisposed).toBe(false);
    expect(first.disposed).toBe(true);
    expect(editor.model).not.toBe(first);
  });

  test("a replaced model is disposed even when showing the new one throws (M-3)", () => {
    const store = twoTabs("a");
    let disposeCalls = 0;
    class DisposableModel extends FakeModel {
      override dispose() {
        disposeCalls++;
      }
    }
    const editor = new FakeEditor();
    const models = new ModelCache((_id, language: Language, value: string) => new DisposableModel(value, language));
    let throwOnShown = false;
    const view = createTabView({
      store,
      editor,
      models,
      persist: () => {},
      onShown: () => {
        if (throwOnShown) throw new Error("boom");
      },
      timers: manualTimers().timers,
    });
    view.show(store.getState());
    const first = editor.model as DisposableModel;
    store.getState().setLanguage("tsx");
    throwOnShown = true;
    expect(() => view.show(store.getState())).toThrow("boom");
    expect(disposeCalls).toBe(1);
    expect(editor.model).not.toBe(first);
  });
});
