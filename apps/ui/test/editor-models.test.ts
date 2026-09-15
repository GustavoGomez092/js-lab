import { describe, expect, mock, test } from "bun:test";
import type { Language } from "@jslab/shared";
import { ModelCache } from "../src/editor/models";
import { createViewStateSaver } from "../src/editor/view-state";
import type { TimerApi } from "../src/state/auto-run";

class FakeModel {
  disposed = false;
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
  dispose() {
    this.disposed = true;
  }
}

function manualTimers() {
  let next = 1;
  const pending = new Map<number, () => void>();
  const timers: TimerApi = {
    setTimeout: (callback) => {
      const id = next++;
      pending.set(id, callback);
      return id;
    },
    clearTimeout: (id) => {
      pending.delete(id as number);
    },
  };
  return {
    timers,
    pending,
    fire: () => {
      for (const [id, callback] of [...pending]) {
        pending.delete(id);
        callback();
      }
    },
  };
}

describe("ModelCache", () => {
  test("creates one model per tab and recreates it on a language change without losing edits", () => {
    const create = mock((_tabId: string, language: Language, value: string) => new FakeModel(value, language));
    const cache = new ModelCache(create);
    const first = cache.ensure("t1", "typescript", "a");
    expect(first.recreated).toBe(false);
    expect(cache.ensure("t1", "typescript", "ignored").model).toBe(first.model);
    first.model.setValue("edited");
    const tsx = cache.ensure("t1", "tsx", "stale");
    expect(tsx.recreated).toBe(true);
    expect([tsx.model.value, tsx.model.language, tsx.previous, first.model.disposed]).toEqual([
      "edited",
      "tsx",
      first.model,
      false,
    ]);
    expect(create).toHaveBeenCalledTimes(2);
  });

  test("prune disposes models of closed tabs; disposeAll clears the rest", () => {
    const cache = new ModelCache((_id, language: Language, value: string) => new FakeModel(value, language));
    const a = cache.ensure("a", "javascript", "").model;
    const b = cache.ensure("b", "javascript", "").model;
    expect(cache.prune(new Set(["b"]))).toEqual(["a"]);
    expect([a.disposed, b.disposed, cache.get("a")]).toEqual([true, false, undefined]);
    cache.disposeAll();
    expect(b.disposed).toBe(true);
  });
});

describe("createViewStateSaver", () => {
  test("debounces per tab and saves only the latest state", () => {
    const save = mock((_tabId: string, _state: unknown) => {});
    const clock = manualTimers();
    const saver = createViewStateSaver(save, 500, clock.timers);
    saver.schedule("a", { v: 1 });
    saver.schedule("a", { v: 2 });
    saver.schedule("b", { v: 9 });
    expect(clock.pending.size).toBe(2);
    clock.fire();
    expect(save.mock.calls).toEqual([
      ["a", { v: 2 }],
      ["b", { v: 9 }],
    ]);
  });

  test("flush saves immediately; cancel drops a pending save", () => {
    const save = mock((_tabId: string, _state: unknown) => {});
    const clock = manualTimers();
    const saver = createViewStateSaver(save, 500, clock.timers);
    saver.schedule("a", { v: 1 });
    saver.schedule("b", { v: 2 });
    saver.flush("a");
    saver.cancel("b");
    clock.fire();
    saver.flush();
    expect(save.mock.calls).toEqual([["a", { v: 1 }]]);
  });
});
