import { describe, expect, test } from "bun:test";
import { DEFAULT_KEYBINDINGS, resolveKeybindings } from "@jslab/shared";
import { KeybindingResolver, type UiContext } from "../src/keybindings/resolver";
import { evaluateWhen } from "../src/keybindings/when";

const base: UiContext = {
  editorFocus: false,
  outputFocus: false,
  modalOpen: false,
  paletteOpen: false,
  dialogOpen: false,
  textInputFocus: false,
};

const key = (
  code: string,
  mods: Partial<{ metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean }> = {},
) => ({
  code,
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  ...mods,
});

describe("when expressions", () => {
  test("support identifiers, negation, && and ||, and reject anything else", () => {
    const ctx = { editorFocus: true, outputFocus: false };
    expect(evaluateWhen(undefined, ctx)).toBe(true);
    expect(evaluateWhen("editorFocus", ctx)).toBe(true);
    expect(evaluateWhen("!editorFocus", ctx)).toBe(false);
    expect(evaluateWhen("editorFocus && !outputFocus", ctx)).toBe(true);
    expect(evaluateWhen("outputFocus || editorFocus", ctx)).toBe(true);
    expect(evaluateWhen("unknownKey", ctx)).toBe(false);
    expect(evaluateWhen("editorFocus == true", ctx)).toBe(false);
  });
});

describe("KeybindingResolver", () => {
  test("user overrides win, and when-clauses select editor-only bindings", () => {
    const resolver = new KeybindingResolver(
      resolveKeybindings(DEFAULT_KEYBINDINGS, [{ key: "cmd+r", command: "format.document", when: "editorFocus" }]),
    );
    expect(resolver.resolve(key("KeyR", { metaKey: true }), base)).toBe("run.start");
    expect(resolver.resolve(key("KeyR", { metaKey: true }), { ...base, editorFocus: true })).toBe("format.document");
    expect(resolver.resolve(key("Slash", { metaKey: true }), base)).toBeNull();
    expect(resolver.resolve(key("Slash", { metaKey: true }), { ...base, editorFocus: true })).toBe(
      "edit.toggleLineComment",
    );
    expect(resolver.resolve(key("Digit9", { metaKey: true }), base)).toBe("tab.goto9");
  });

  test("modals block global bindings; text inputs only allow ⌘ or ⌃ chords", () => {
    const resolver = new KeybindingResolver(
      resolveKeybindings(DEFAULT_KEYBINDINGS, [{ key: "alt+shift+x", command: "run.start" }]),
    );
    expect(
      resolver.resolve(key("KeyR", { metaKey: true }), { ...base, modalOpen: true, paletteOpen: true }),
    ).toBeNull();
    expect(resolver.resolve(key("KeyR", { metaKey: true }), { ...base, textInputFocus: true })).toBe("run.start");
    expect(
      resolver.resolve(key("KeyX", { altKey: true, shiftKey: true }), { ...base, textInputFocus: true }),
    ).toBeNull();
    expect(resolver.resolve(key("KeyX", { altKey: true, shiftKey: true }), base)).toBe("run.start");
    expect(resolver.resolve(key("ShiftLeft", { shiftKey: true }), base)).toBeNull();
  });

  // Carried item T5-m3: pins the as-built resolveKeybindings order semantics — in one overrides list, a
  // removal ("-id") that comes after a user add for the same key also removes that just-added user binding.
  test("a removal after a user add for the same key removes that user binding too (T5-m3)", () => {
    const resolved = resolveKeybindings(DEFAULT_KEYBINDINGS, [
      { key: "cmd+k", command: "tab.new" },
      { key: "cmd+k", command: "-tab.new" },
    ]);
    const resolver = new KeybindingResolver(resolved);
    // The default cmd+k -> output.clear binding is untouched; the user's add-then-remove leaves no trace.
    expect(resolver.resolve(key("KeyK", { metaKey: true }), base)).toBe("output.clear");
    expect(resolved.filter((binding) => binding.command === "tab.new" && binding.key === "cmd+k")).toEqual([]);
  });
});
