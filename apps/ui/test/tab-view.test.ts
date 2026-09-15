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
});
