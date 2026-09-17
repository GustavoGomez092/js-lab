import { describe, expect, test } from "bun:test";
import { captureKey, captureSpec, isBindable } from "../src/settings/key-capture";

const key = (code: string, mods: Partial<Record<"metaKey" | "ctrlKey" | "altKey" | "shiftKey", boolean>> = {}) => ({
  code,
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  ...mods,
});

describe("captureKey", () => {
  test("captures a modifier chord and reports its spec and keycap", () => {
    expect(captureKey(key("KeyR", { metaKey: true, shiftKey: true }))).toEqual({
      kind: "captured",
      key: "cmd+shift+r",
      label: "⇧⌘R",
    });
    expect(captureKey(key("Digit1", { ctrlKey: true, altKey: true }))).toEqual({
      kind: "captured",
      key: "ctrl+alt+1",
      label: "⌃⌥1",
    });
  });

  // Each modifier alone must be enough. Without these, dropping `ctrl` or `alt` from the "has a modifier" test
  // still passes every chord above, because each of those carries two modifiers.
  test("any one of ⌘, ⌃ or ⌥ is enough on its own", () => {
    expect(captureKey(key("KeyR", { metaKey: true }))).toEqual({ kind: "captured", key: "cmd+r", label: "⌘R" });
    expect(captureKey(key("KeyR", { ctrlKey: true }))).toEqual({ kind: "captured", key: "ctrl+r", label: "⌃R" });
    expect(captureKey(key("KeyR", { altKey: true }))).toEqual({ kind: "captured", key: "alt+r", label: "⌥R" });
  });

  // The escape hatch: a field that swallows every keystroke must always be leaveable.
  test("Escape cancels and is never captured, with or without modifiers", () => {
    expect(captureKey(key("Escape"))).toEqual({ kind: "cancelled" });
    expect(captureKey(key("Escape", { metaKey: true }))).toEqual({ kind: "cancelled" });
    expect(captureKey(key("Escape", { shiftKey: true, altKey: true }))).toEqual({ kind: "cancelled" });
  });

  test("bare Tab is ignored so keyboard navigation still works, but a Tab chord is bindable", () => {
    expect(captureKey(key("Tab"))).toEqual({ kind: "ignored" });
    expect(captureKey(key("Tab", { shiftKey: true }))).toEqual({ kind: "ignored" });
    expect(captureKey(key("Tab", { ctrlKey: true }))).toEqual({ kind: "captured", key: "ctrl+tab", label: "⌃⇥" });
    expect(captureKey(key("Tab", { metaKey: true }))).toEqual({ kind: "captured", key: "cmd+tab", label: "⌘⇥" });
  });

  test("a lone modifier press is ignored rather than captured", () => {
    for (const code of ["MetaLeft", "ShiftRight", "ControlLeft", "AltLeft"]) {
      expect(captureKey(key(code, { metaKey: true }))).toEqual({ kind: "ignored" });
    }
  });

  test("a bare printable key is refused with a reason, never silently swallowed", () => {
    expect(captureKey(key("KeyK"))).toEqual({ kind: "rejected", reason: "bareKey" });
    expect(captureKey(key("Digit4"))).toEqual({ kind: "rejected", reason: "bareKey" });
    expect(captureKey(key("Space"))).toEqual({ kind: "rejected", reason: "bareKey" });
    expect(captureKey(key("Enter"))).toEqual({ kind: "rejected", reason: "bareKey" });
    // Shift alone doesn't make a printable key safe: ⇧K is still typing.
    expect(captureKey(key("KeyK", { shiftKey: true }))).toEqual({ kind: "rejected", reason: "bareKey" });
  });

  test("function keys are bindable bare, because the default keymap already binds F1 and F5", () => {
    expect(captureKey(key("F9"))).toEqual({ kind: "captured", key: "f9", label: "F9" });
    expect(captureKey(key("F5"))).toEqual({ kind: "captured", key: "f5", label: "F5" });
    expect(captureKey(key("F1"))).toEqual({ kind: "captured", key: "f1", label: "F1" });
    expect(captureKey(key("F12"))).toEqual({ kind: "captured", key: "f12", label: "F12" });
    expect(captureKey(key("F5", { metaKey: true }))).toEqual({ kind: "captured", key: "cmd+f5", label: "⌘F5" });
  });

  test("an unknown key produces nothing at all", () => {
    expect(captureKey(key("Fn"))).toEqual({ kind: "ignored" });
    // F13 is past the range the chord grammar knows, so it maps to no key rather than to a bindable function key.
    expect(captureKey(key("F13"))).toEqual({ kind: "ignored" });
  });
});

describe("captureSpec", () => {
  // The E2E `keybindings.capture` command names a chord as text. It must reach the SAME verdicts a keystroke
  // does -- a scenario is not allowed to bind something the capture field would refuse.
  test("reaches the same verdict as a keystroke, from a chord spec", () => {
    expect(captureSpec("cmd+shift+r")).toEqual({ kind: "captured", key: "cmd+shift+r", label: "⇧⌘R" });
    expect(captureSpec("f9")).toEqual({ kind: "captured", key: "f9", label: "F9" });
    expect(captureSpec("k")).toEqual({ kind: "rejected", reason: "bareKey" });
    expect(captureSpec("shift+k")).toEqual({ kind: "rejected", reason: "bareKey" });
  });

  // This is the branch `captureKey` can never reach: it answers Escape as `cancelled` first. Without a spec-shaped
  // entry point, `reason: "reserved"` would be unreachable code that no test could kill.
  test("refuses a reserved key by name, which the keystroke path answers as a cancel instead", () => {
    expect(captureSpec("escape")).toEqual({ kind: "rejected", reason: "reserved" });
    expect(captureSpec("cmd+escape")).toEqual({ kind: "rejected", reason: "reserved" });
  });

  test("normalises modifier order rather than echoing the spec it was given", () => {
    expect(captureSpec("shift+cmd+r")).toEqual({ kind: "captured", key: "cmd+shift+r", label: "⇧⌘R" });
    expect(captureSpec("CMD+R")).toEqual({ kind: "captured", key: "cmd+r", label: "⌘R" });
  });

  test("a spec that is not a chord at all is ignored, not thrown", () => {
    expect(captureSpec("")).toEqual({ kind: "ignored" });
    expect(captureSpec("cmd+nope")).toEqual({ kind: "ignored" });
    expect(captureSpec("hyper+r")).toEqual({ kind: "ignored" });
  });
});

describe("isBindable", () => {
  test("agrees with captureKey about what may be bound", () => {
    expect(isBindable({ key: "r", meta: true, ctrl: false, alt: false, shift: false })).toBe(true);
    expect(isBindable({ key: "r", ctrl: true, meta: false, alt: false, shift: false })).toBe(true);
    expect(isBindable({ key: "r", alt: true, meta: false, ctrl: false, shift: false })).toBe(true);
    expect(isBindable({ key: "f9", meta: false, ctrl: false, alt: false, shift: false })).toBe(true);
    expect(isBindable({ key: "k", meta: false, ctrl: false, alt: false, shift: false })).toBe(false);
    // Shift is not a modifier for this purpose: ⇧K is typing, not a shortcut.
    expect(isBindable({ key: "k", shift: true, meta: false, ctrl: false, alt: false })).toBe(false);
    expect(isBindable({ key: "escape", meta: false, ctrl: false, alt: false, shift: false })).toBe(false);
    expect(isBindable({ key: "escape", meta: true, ctrl: false, alt: false, shift: false })).toBe(false);
  });
});
