import { describe, expect, test } from "bun:test";
import { isCommandId } from "../src/commands";
import {
  chordFromEvent,
  chordToSpec,
  DEFAULT_KEYBINDINGS,
  formatChord,
  formatChordParts,
  keybindingsFileSchema,
  parseChord,
  resolveKeybindings,
  shortcutFor,
} from "../src/keybindings";

const event = (
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

describe("chords", () => {
  test("parse modifiers, aliases and named keys", () => {
    expect(parseChord("Cmd+Shift+Enter")).toEqual({ key: "enter", meta: true, ctrl: false, alt: false, shift: true });
    expect(parseChord("option+meta+/")).toEqual({ key: "/", meta: true, ctrl: false, alt: true, shift: false });
    expect(parseChord("f9")).toEqual({ key: "f9", meta: false, ctrl: false, alt: false, shift: false });
    expect(() => parseChord("cmd+")).toThrow();
    expect(() => parseChord("hyper+r")).toThrow(/Unknown modifier/);
    expect(() => parseChord("cmd+r+t")).toThrow(/Unknown modifier/);
    expect(() => parseChord("cmd+pause")).toThrow(/Unknown key/);
  });

  test("events map by code and bare modifier presses are ignored", () => {
    expect(chordFromEvent(event("KeyR", { metaKey: true, shiftKey: true }))).toEqual(parseChord("cmd+shift+r"));
    expect(chordFromEvent(event("Digit3", { metaKey: true }))).toEqual(parseChord("cmd+3"));
    expect(chordFromEvent(event("ArrowRight", { metaKey: true, altKey: true }))).toEqual(parseChord("cmd+alt+right"));
    expect(chordFromEvent(event("MetaLeft", { metaKey: true }))).toBeNull();
  });

  test("format in macOS modifier order", () => {
    const chord = parseChord("cmd+alt+shift+ctrl+f");
    expect(formatChord(chord)).toBe("⌃⌥⇧⌘F");
    expect(formatChordParts(parseChord("alt+cmd+a"))).toEqual(["⌥", "⌘", "A"]);
    expect(formatChordParts(parseChord("cmd+backspace"))).toEqual(["⌘", "⌫"]);
    expect(chordToSpec(chord)).toBe("cmd+ctrl+alt+shift+f");
  });
});

describe("keybindings", () => {
  test("every default parses, targets a known command and is unique within its context", () => {
    const seen = new Set<string>();
    for (const rule of DEFAULT_KEYBINDINGS) {
      expect(isCommandId(rule.command)).toBe(true);
      const id = `${chordToSpec(parseChord(rule.key))}|${rule.when ?? ""}`;
      expect(seen.has(id)).toBe(false);
      seen.add(id);
    }
    expect(DEFAULT_KEYBINDINGS.filter((rule) => rule.command.startsWith("tab.goto"))).toHaveLength(9);
  });

  test("keybindings.json entries are validated and invalid ones dropped", () => {
    expect(
      keybindingsFileSchema.parse([
        { key: "cmd+shift+enter", command: "run.start", when: "editorFocus" },
        { key: "cmd+k", command: "-output.clear" },
        { key: "cmd+??", command: "run.start" },
        { key: "cmd+q", command: "not.a.command" },
        "garbage",
      ]),
    ).toEqual([
      { key: "cmd+shift+enter", command: "run.start", when: "editorFocus" },
      { key: "cmd+k", command: "-output.clear" },
    ]);
    expect(keybindingsFileSchema.parse({ not: "an array" })).toEqual([]);
  });

  test("overrides add user bindings and remove defaults by command and key", () => {
    const bindings = resolveKeybindings(DEFAULT_KEYBINDINGS, [
      { key: "cmd+k", command: "-output.clear" },
      { key: "cmd+shift+k", command: "output.clear" },
      { key: "cmd+shift+enter", command: "run.start", when: "editorFocus" },
    ]);
    expect(bindings.some((b) => b.command === "output.clear" && b.key === "cmd+k")).toBe(false);
    expect(shortcutFor(bindings, "output.clear")).toEqual(parseChord("cmd+shift+k"));
    expect(shortcutFor(bindings, "run.start")).toEqual(parseChord("cmd+shift+enter"));
    expect(bindings.at(-1)).toMatchObject({ command: "run.start", source: "user" });
    expect(shortcutFor(bindings, "tab.rename")).toBeNull();
  });
});
