import { describe, expect, test } from "bun:test";
import { createTab, defaultSession, defaultSettings, mergeSettings } from "@jslab/shared";
import { getTheme } from "@jslab/themes";
import { createAppStore } from "../src/state/store";
import { applyThemeVariables, startThemeSync } from "../src/themes/apply";
import { createThemeCommands } from "../src/themes/theme-commands";
import { createFakeApi } from "./fake-api";

function hydrated() {
  const store = createAppStore();
  store.getState().hydrate({
    settings: defaultSettings(),
    session: defaultSession(() => createTab({ id: "t1" })),
    buffers: { t1: "" },
    safeMode: { active: false, reason: null },
    versions: { app: "0", bun: "1.4.0" },
  });
  return store;
}

/** `spyOn` doesn't intercept happy-dom's `CSSStyleDeclaration.setProperty`; wrap it manually instead. */
function countSetProperty(root: HTMLElement) {
  const counter = { calls: 0 };
  const original = root.style.setProperty.bind(root.style);
  root.style.setProperty = (...args: Parameters<typeof original>) => {
    counter.calls++;
    return original(...args);
  };
  return counter;
}

function fakeMedia(matches: boolean) {
  const listeners = new Set<() => void>();
  return {
    media: {
      matches,
      addEventListener: (_: "change", listener: () => void) => listeners.add(listener),
      removeEventListener: (_: "change", listener: () => void) => listeners.delete(listener),
    },
    change(next: boolean) {
      this.media.matches = next;
      for (const listener of listeners) listener();
    },
  };
}

describe("theme application", () => {
  test("writes every token as a CSS variable with color-scheme and data-theme", () => {
    const root = document.createElement("div");
    applyThemeVariables(getTheme("github-light"), root);
    expect(root.style.getPropertyValue("--bg-canvas")).toBe(getTheme("github-light").tokens["bg.canvas"]);
    expect(root.style.getPropertyValue("--fg-muted")).toBe(getTheme("github-light").tokens["fg.muted"]);
    expect(root.style.colorScheme).toBe("light");
    expect(root.dataset.theme).toBe("github-light");
  });

  test("sync applies on start, on appearance changes and on system changes only while following the system", () => {
    const store = hydrated();
    const root = document.createElement("div");
    const system = fakeMedia(true);
    const stop = startThemeSync(store, { root, media: system.media });
    expect([store.getState().themeId, root.dataset.theme]).toEqual(["graphite", "graphite"]);
    store.getState().updateSettings(mergeSettings(defaultSettings(), { appearance: { theme: "nord" } }));
    expect(store.getState().themeId).toBe("nord");
    system.change(false);
    expect(store.getState().themeId).toBe("nord");
    store
      .getState()
      .updateSettings(
        mergeSettings(defaultSettings(), { appearance: { followSystem: true, lightTheme: "solarized-light" } }),
      );
    expect(store.getState().themeId).toBe("solarized-light");
    system.change(true);
    expect([store.getState().themeId, root.style.colorScheme]).toEqual(["graphite", "dark"]);
    stop();
    system.change(false);
    expect(store.getState().themeId).toBe("graphite");
  });

  test("only reapplies theme variables when a theme-related appearance field changes (review I-1)", () => {
    const store = hydrated();
    const root = document.createElement("div");
    const stop = startThemeSync(store, { root, media: null });
    const counter = countSetProperty(root);
    // A fresh settings object (new appearance identity) whose theme-related fields are unchanged must not reapply.
    store.getState().updateSettings(mergeSettings(defaultSettings(), { run: { autoRun: true } }));
    expect(counter.calls).toBe(0);
    // Changing a theme-related field must still reapply.
    store.getState().updateSettings(mergeSettings(defaultSettings(), { appearance: { theme: "nord" } }));
    expect(counter.calls).toBeGreaterThan(0);
    stop();
  });

  test("theme commands persist the choice through Main", async () => {
    const store = hydrated();
    const { api } = createFakeApi();
    api.updateSettings.mockImplementation(async (patch: unknown) =>
      mergeSettings(defaultSettings(), patch as Parameters<typeof mergeSettings>[1]),
    );
    const commands = new Map(createThemeCommands(store, api).map((spec) => [spec.id, spec]));
    await commands.get("theme.select")?.run({ themeId: "dracula" });
    expect(api.updateSettings).toHaveBeenLastCalledWith({ appearance: { theme: "dracula", followSystem: false } });
    expect(store.getState().settings?.appearance.theme).toBe("dracula");
    await commands.get("theme.select")?.run({ themeId: "not-a-theme" });
    expect(api.updateSettings).toHaveBeenCalledTimes(1);
    await commands.get("theme.toggleFollowSystem")?.run();
    expect(api.updateSettings).toHaveBeenLastCalledWith({ appearance: { followSystem: true } });
    // The mock echoes the patch onto defaults, so the store now has followSystem: true.
    expect(commands.get("theme.toggleFollowSystem")?.description?.()).toBe("currently on");
  });
});
