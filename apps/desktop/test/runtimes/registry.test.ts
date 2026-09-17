import { describe, expect, mock, test } from "bun:test";
import type { RuntimeAdapter } from "../../src/main/runtimes/adapter";
import { createRuntimeRegistry } from "../../src/main/runtimes/registry";

/** A minimal `RuntimeAdapter`-shaped fake, distinguishable by its `id` (only `.get()`'s selection matters here). */
function fakeAdapter(id: RuntimeAdapter["id"]): RuntimeAdapter {
  return {
    id,
    prepare: async () => {},
    start: async () => {
      throw new Error("not called by this test");
    },
    invalidate: () => {},
    dispose: async () => {},
  };
}

describe("createRuntimeRegistry", () => {
  test("resolves a registered runtime to its own adapter, and an undefined runtime to bun -- silently", () => {
    const log = mock(() => {});
    const bun = fakeAdapter("bun");
    const registry = createRuntimeRegistry({ bun }, log);
    expect(registry.get("bun")).toBe(bun);
    expect(registry.get(undefined)).toBe(bun); // R-M4-T1-OPTIONAL-1: unresolved always means Bun
    expect(log).not.toHaveBeenCalled();
  });

  test("falls back to bun for a runtime with no adapter of its own", () => {
    const bun = fakeAdapter("bun");
    const registry = createRuntimeRegistry({ bun });
    expect(registry.get("browser")).toBe(bun);
    expect(registry.get("browser-node")).toBe(bun);
  });

  test("logs when an explicitly requested non-bun runtime has no adapter (M4 T9 fix round 1)", () => {
    const log = mock(() => {});
    const bun = fakeAdapter("bun");
    const registry = createRuntimeRegistry({ bun }, log);
    expect(registry.get("browser")).toBe(bun);
    expect(log).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith(expect.any(String), { requestedRuntime: "browser" });

    expect(registry.get("browser-node")).toBe(bun);
    expect(log).toHaveBeenCalledTimes(2);
    expect(log).toHaveBeenLastCalledWith(expect.any(String), { requestedRuntime: "browser-node" });
  });

  test("never logs for a registered runtime, or for an unresolved (undefined) one", () => {
    const log = mock(() => {});
    const bun = fakeAdapter("bun");
    const browser = fakeAdapter("browser");
    const registry = createRuntimeRegistry({ bun, browser }, log);
    expect(registry.get("browser")).toBe(browser);
    expect(registry.get("bun")).toBe(bun);
    expect(registry.get(undefined)).toBe(bun);
    expect(log).not.toHaveBeenCalled();
  });

  /**
   * Final review, finding D. `RunCoordinator.disposeTab` had no runtime to route by and used
   * `get(undefined)`, which always resolves to Bun -- so closing a browser tab called `BunAdapter.dispose` and
   * never `WebAdapter.dispose`. `all()` is what lets a whole-tab teardown reach every adapter that might hold
   * something for that tab.
   */
  test("all() lists every distinct registered adapter", () => {
    const bun = fakeAdapter("bun");
    const browser = fakeAdapter("browser");
    const browserNode = fakeAdapter("browser-node");
    const registry = createRuntimeRegistry({ bun, browser, "browser-node": browserNode });

    expect(registry.all()).toHaveLength(3);
    expect(new Set(registry.all())).toEqual(new Set([bun, browser, browserNode]));
  });

  test("all() de-duplicates one adapter registered under several runtimes", () => {
    const bun = fakeAdapter("bun");
    const registry = createRuntimeRegistry({ bun, browser: bun });

    // Told once, not once per runtime id it answers to.
    expect(registry.all()).toEqual([bun]);
  });

  test("all() lists just bun when nothing else is registered", () => {
    const bun = fakeAdapter("bun");
    expect(createRuntimeRegistry({ bun }).all()).toEqual([bun]);
  });

  test("works with no log function passed at all (log is optional)", () => {
    const bun = fakeAdapter("bun");
    const registry = createRuntimeRegistry({ bun });
    expect(() => registry.get("browser")).not.toThrow();
  });
});
