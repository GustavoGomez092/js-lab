import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createTab, defaultSession, defaultSettings, mergeSettings } from "@jslab/shared";
import { convertVsCodeTheme, getTheme, listThemes, registerUserThemes, toCssVariables } from "@jslab/themes";
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

describe("first-paint fallback (FB-m8)", () => {
  const css = readFileSync(join(import.meta.dir, "../src/styles.css"), "utf8");

  test("the :root fallback colors in styles.css equal the Graphite theme tokens", () => {
    const root = /:root\s*\{([^}]*)\}/.exec(css)?.[1] ?? "";
    const fallback = Object.fromEntries(
      [...root.matchAll(/(--(?:bg|border|fg|console|syntax)-[A-Za-z]+):\s*([^;]+);/g)].map(([, name, value]) => [
        name,
        value?.trim().toLowerCase(),
      ]),
    );
    const expected = Object.fromEntries(
      Object.entries(toCssVariables(getTheme("graphite").tokens)).map(([name, value]) => [name, value.toLowerCase()]),
    );
    expect(fallback).toEqual(expected);
  });

  test("hovered error rows paint the bg.errorRowHover token, not a color-mix (FB-m7)", () => {
    const rule = /\.entry-level-error:hover\s*\{([^}]*)\}/.exec(css)?.[1] ?? "";
    expect(rule.trim()).toBe("background: var(--bg-errorRowHover);");
  });
});

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

describe("importing a VS Code theme (spec §9.3)", () => {
  // The registry is module-level, so it is cleared between tests rather than left for the next one to trip over.
  afterEach(() => registerUserThemes([]));

  const imported = (name: string) => {
    const result = convertVsCodeTheme({ name, type: "dark", colors: { "editor.background": "#101010" } });
    if (!result.ok) throw new Error(result.error);
    return result.theme;
  };
  const commandsFor = (store: ReturnType<typeof hydrated>, api: ReturnType<typeof createFakeApi>["api"]) =>
    new Map(createThemeCommands(store, api).map((spec) => [spec.id, spec]));

  test("theme.import asks Main to import and never writes the setting itself", async () => {
    const store = hydrated();
    const { api } = createFakeApi();
    await commandsFor(store, api).get("theme.import")?.run();
    expect(api.importTheme).toHaveBeenCalledTimes(1);
    // The fake answers with the cancelled-dialog shape, which must change nothing at all.
    expect(api.updateSettings).not.toHaveBeenCalled();
    expect([store.getState().statusMessage, store.getState().modal]).toEqual([null, null]);
  });

  test("an imported theme is selectable, which the module-level KNOWN set prevented (Task 4 finding)", async () => {
    const store = hydrated();
    const { api } = createFakeApi();
    api.updateSettings.mockImplementation(async (patch: unknown) =>
      mergeSettings(defaultSettings(), patch as Parameters<typeof mergeSettings>[1]),
    );
    // Registered AFTER the module was imported -- exactly the ordering the old snapshot could never see.
    registerUserThemes([imported("Deep Dark")]);
    expect(listThemes().some((theme) => theme.id === "deep-dark")).toBe(true);
    await commandsFor(store, api).get("theme.select")?.run({ themeId: "deep-dark" });
    expect(api.updateSettings).toHaveBeenLastCalledWith({ appearance: { theme: "deep-dark", followSystem: false } });
    expect(store.getState().settings?.appearance.theme).toBe("deep-dark");
  });

  test("a successful import selects the theme and reports it with whatever was lost", async () => {
    const store = hydrated();
    const { api } = createFakeApi();
    api.updateSettings.mockImplementation(async (patch: unknown) =>
      mergeSettings(defaultSettings(), patch as Parameters<typeof mergeSettings>[1]),
    );
    api.importTheme.mockImplementation(async () => ({
      ok: true,
      theme: { id: "deep-dark", name: "Deep Dark", type: "dark" },
      notes: ["Its semantic token colours aren't supported."],
    }));
    await commandsFor(store, api).get("theme.import")?.run();
    expect(api.updateSettings).toHaveBeenLastCalledWith({ appearance: { theme: "deep-dark", followSystem: false } });
    expect(store.getState().statusMessage).toBe("Imported Deep Dark. Its semantic token colours aren't supported.");
  });

  test("a multi-theme .vsix opens the picker instead of importing anything", async () => {
    const store = hydrated();
    const { api } = createFakeApi();
    const choices = [
      { label: "Deep Dark", path: "extension/themes/deep.json" },
      { label: "Pale Light", path: "extension/themes/pale.json" },
    ];
    api.importTheme.mockImplementation(async () => ({ ok: true, token: "t-1", choices }));
    await commandsFor(store, api).get("theme.import")?.run();
    expect(store.getState().modal).toEqual({ kind: "themePick", token: "t-1", choices });
    expect(api.updateSettings).not.toHaveBeenCalled();
  });

  test("a refusal is reported, but a cancelled dialog's empty error says nothing", async () => {
    const store = hydrated();
    const { api } = createFakeApi();
    api.importTheme.mockImplementation(async () => ({ ok: false, error: "That theme file couldn't be read." }));
    await commandsFor(store, api).get("theme.import")?.run();
    expect(store.getState().statusMessage).toBe("That theme file couldn't be read.");

    store.getState().setStatusMessage(null);
    api.importTheme.mockImplementation(async () => ({ ok: false, error: "" }));
    await commandsFor(store, api).get("theme.import")?.run();
    expect(store.getState().statusMessage).toBeNull();
  });

  test("a successful import closes the picker but never some other open dialog", async () => {
    const store = hydrated();
    const { api } = createFakeApi();
    api.updateSettings.mockImplementation(async (patch: unknown) =>
      mergeSettings(defaultSettings(), patch as Parameters<typeof mergeSettings>[1]),
    );
    api.importTheme.mockImplementation(async () => ({
      ok: true,
      theme: { id: "deep-dark", name: "Deep Dark", type: "dark" },
      notes: [],
    }));
    // The palette is usually what runs this command, and closing it stays the palette's own business.
    store.getState().openModal({ kind: "palette", context: "editor" });
    await commandsFor(store, api).get("theme.import")?.run();
    expect(store.getState().modal).toEqual({ kind: "palette", context: "editor" });

    // The picker, though, has just been answered and must go.
    store.getState().openModal({ kind: "themePick", token: "t-1", choices: [] });
    await commandsFor(store, api).get("theme.import")?.run();
    expect(store.getState().modal).toBeNull();
  });

  test("hydrate registers the themes the bootstrap carried, so the first paint offers them", () => {
    const store = createAppStore();
    store.getState().hydrate({
      settings: defaultSettings(),
      session: defaultSession(() => createTab({ id: "t1" })),
      buffers: { t1: "" },
      safeMode: { active: false, reason: null },
      versions: { app: "0", bun: "1.4.0" },
      userThemes: [imported("Deep Dark")],
    });
    expect(listThemes().some((theme) => theme.id === "deep-dark")).toBe(true);
  });
});
