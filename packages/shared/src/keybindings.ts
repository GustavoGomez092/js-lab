import { z } from "zod";
import { type CommandId, isCommandId } from "./commands";

export interface KeyChord {
  key: string;
  meta: boolean;
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
}

export interface KeyLike {
  code: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}

const MODIFIER_ALIASES: Record<string, "meta" | "ctrl" | "alt" | "shift"> = {
  cmd: "meta",
  meta: "meta",
  ctrl: "ctrl",
  alt: "alt",
  option: "alt",
  shift: "shift",
};

const CODE_TO_KEY: Record<string, string> = {
  Equal: "=",
  Minus: "-",
  Slash: "/",
  Backslash: "\\",
  Comma: ",",
  Period: ".",
  BracketLeft: "[",
  BracketRight: "]",
  Semicolon: ";",
  Quote: "'",
  Backquote: "`",
  Enter: "enter",
  NumpadEnter: "enter",
  Backspace: "backspace",
  Delete: "delete",
  Space: "space",
  Tab: "tab",
  Escape: "escape",
  ArrowUp: "up",
  ArrowDown: "down",
  ArrowLeft: "left",
  ArrowRight: "right",
  Home: "home",
  End: "end",
  PageUp: "pageup",
  PageDown: "pagedown",
};

const NAMED_KEYS = new Set(Object.values(CODE_TO_KEY));

function isKey(key: string): boolean {
  return /^[a-z0-9]$/.test(key) || /^f([1-9]|1[0-2])$/.test(key) || NAMED_KEYS.has(key);
}

/** Parses "cmd+shift+r". The last part is the key; everything before it must be a modifier. */
export function parseChord(spec: string): KeyChord {
  const parts = spec
    .toLowerCase()
    .split("+")
    .map((part) => part.trim());
  const key = parts.pop();
  if (!key) throw new Error(`Invalid keybinding "${spec}"`);
  const chord: KeyChord = { key, meta: false, ctrl: false, alt: false, shift: false };
  for (const part of parts) {
    const modifier = MODIFIER_ALIASES[part];
    if (!modifier) throw new Error(`Unknown modifier "${part}" in keybinding "${spec}"`);
    chord[modifier] = true;
  }
  if (!isKey(key)) throw new Error(`Unknown key "${key}" in keybinding "${spec}"`);
  return chord;
}

export function isValidChord(spec: string): boolean {
  try {
    parseChord(spec);
    return true;
  } catch {
    return false;
  }
}

export function keyForCode(code: string): string | null {
  if (/^Key[A-Z]$/.test(code)) return code.slice(3).toLowerCase();
  if (/^Digit[0-9]$/.test(code)) return code.slice(5);
  if (/^F([1-9]|1[0-2])$/.test(code)) return code.toLowerCase();
  return CODE_TO_KEY[code] ?? null;
}

export function chordFromEvent(event: KeyLike): KeyChord | null {
  const key = keyForCode(event.code);
  if (!key) return null;
  return { key, meta: event.metaKey, ctrl: event.ctrlKey, alt: event.altKey, shift: event.shiftKey };
}

export function chordsEqual(a: KeyChord, b: KeyChord): boolean {
  return a.key === b.key && a.meta === b.meta && a.ctrl === b.ctrl && a.alt === b.alt && a.shift === b.shift;
}

export function chordToSpec(chord: KeyChord): string {
  return [chord.meta && "cmd", chord.ctrl && "ctrl", chord.alt && "alt", chord.shift && "shift", chord.key]
    .filter(Boolean)
    .join("+");
}

const KEY_LABELS: Record<string, string> = {
  enter: "↩",
  backspace: "⌫",
  delete: "⌦",
  space: "Space",
  tab: "⇥",
  escape: "esc",
  up: "↑",
  down: "↓",
  left: "←",
  right: "→",
  home: "Home",
  end: "End",
  pageup: "PgUp",
  pagedown: "PgDn",
};

/** Keycap labels in macOS order: ⌃ ⌥ ⇧ ⌘, then the key. */
export function formatChordParts(chord: KeyChord): string[] {
  const parts: string[] = [];
  if (chord.ctrl) parts.push("⌃");
  if (chord.alt) parts.push("⌥");
  if (chord.shift) parts.push("⇧");
  if (chord.meta) parts.push("⌘");
  parts.push(KEY_LABELS[chord.key] ?? chord.key.toUpperCase());
  return parts;
}

export function formatChord(chord: KeyChord): string {
  return formatChordParts(chord).join("");
}

export interface KeybindingRule {
  key: string;
  /** A command id, or "-<id>" to remove that command's default binding on `key`. */
  command: string;
  when?: string;
}

export const keybindingRuleSchema = z.object({
  key: z.string().min(1).max(64),
  command: z.string().min(1).max(101),
  when: z.string().min(1).max(200).optional(),
});

/** `keybindings.json`: an array of rules. Invalid entries are dropped, and a non-array file means no overrides. */
export const keybindingsFileSchema = z
  .array(z.unknown())
  .catch([])
  .transform((items) =>
    items.flatMap((item): KeybindingRule[] => {
      const parsed = keybindingRuleSchema.safeParse(item);
      if (!parsed.success || !isValidChord(parsed.data.key)) return [];
      const id = parsed.data.command.startsWith("-") ? parsed.data.command.slice(1) : parsed.data.command;
      if (!isCommandId(id)) return [];
      return [parsed.data];
    }),
  );

const editor = "editorFocus";

/** Default keybindings for macOS (spec §6.5), plus the palette extras from the chosen UI direction. */
export const DEFAULT_KEYBINDINGS: readonly KeybindingRule[] = [
  { key: "cmd+o", command: "file.open" },
  { key: "cmd+s", command: "file.save" },
  { key: "cmd+shift+s", command: "file.saveAs" },
  { key: "cmd+t", command: "tab.new" },
  { key: "cmd+w", command: "tab.close" },
  { key: "cmd+shift+t", command: "tab.reopenClosed" },
  { key: "cmd+alt+t", command: "tab.closeOthers" },
  { key: "cmd+alt+right", command: "tab.next" },
  { key: "ctrl+tab", command: "tab.next" },
  { key: "cmd+alt+left", command: "tab.previous" },
  { key: "ctrl+shift+tab", command: "tab.previous" },
  { key: "cmd+1", command: "tab.goto1" },
  { key: "cmd+2", command: "tab.goto2" },
  { key: "cmd+3", command: "tab.goto3" },
  { key: "cmd+4", command: "tab.goto4" },
  { key: "cmd+5", command: "tab.goto5" },
  { key: "cmd+6", command: "tab.goto6" },
  { key: "cmd+7", command: "tab.goto7" },
  { key: "cmd+8", command: "tab.goto8" },
  { key: "cmd+9", command: "tab.goto9" },
  { key: "cmd+,", command: "app.settings" },
  { key: "cmd+r", command: "run.start" },
  { key: "cmd+shift+r", command: "run.stop" },
  { key: "cmd+alt+r", command: "run.kill" },
  { key: "alt+cmd+a", command: "run.toggleAutoRun" },
  { key: "alt+cmd+l", command: "run.toggleAutoLog" },
  { key: "alt+shift+f", command: "format.document" },
  { key: "cmd+k", command: "output.clear" },
  { key: "cmd+i", command: "tools.npmPackages" },
  { key: "cmd+/", command: "edit.toggleLineComment", when: editor },
  { key: "cmd+alt+/", command: "edit.toggleBlockComment", when: editor },
  { key: "cmd+alt+shift+/", command: "edit.toggleMagicComment", when: editor },
  // Spec §6.3: "`F9` toggles the current line, and `Cmd+Shift+F9` clears all." Clear All has no `when`, so it
  // reaches the whole window; the toggle needs the caret, so it is editor-only.
  { key: "f9", command: "edit.toggleLogpoint", when: editor },
  { key: "cmd+shift+f9", command: "edit.clearLogpoints" },
  { key: "ctrl+space", command: "edit.triggerSuggest", when: editor },
  { key: "f1", command: "edit.showHover", when: editor },
  { key: "cmd+f1", command: "edit.showDiagnostic", when: editor },
  { key: "cmd+f", command: "edit.find", when: editor },
  { key: "cmd+alt+f", command: "edit.replace", when: editor },
  { key: "cmd+g", command: "edit.findNext", when: editor },
  { key: "cmd+shift+g", command: "edit.findPrevious", when: editor },
  { key: "ctrl+g", command: "edit.gotoLine", when: editor },
  { key: "ctrl+shift+k", command: "edit.deleteLine", when: editor },
  { key: "cmd+l", command: "edit.selectLine", when: editor },
  { key: "cmd+shift+l", command: "edit.splitSelectionIntoLines", when: editor },
  { key: "cmd+shift+enter", command: "edit.insertLineBefore", when: editor },
  { key: "cmd+enter", command: "edit.insertLineAfter", when: editor },
  { key: "cmd+d", command: "edit.selectNextOccurrence", when: editor },
  { key: "cmd+shift+space", command: "edit.expandSelection", when: editor },
  { key: "cmd+shift+m", command: "edit.selectToBracket", when: editor },
  { key: "cmd+m", command: "edit.gotoBracket", when: editor },
  { key: "cmd+ctrl+up", command: "edit.moveLineUp", when: editor },
  { key: "cmd+ctrl+down", command: "edit.moveLineDown", when: editor },
  { key: "cmd+j", command: "edit.joinLines", when: editor },
  { key: "cmd+shift+d", command: "edit.duplicateLine", when: editor },
  { key: "f5", command: "edit.sortLines", when: editor },
  { key: "cmd+f5", command: "edit.sortLinesCaseInsensitive", when: editor },
  { key: "cmd+shift+f5", command: "edit.reverseLinesCaseInsensitive", when: editor },
  { key: "cmd+backspace", command: "edit.deleteToLineStart", when: editor },
  { key: "ctrl+shift+up", command: "edit.addCursorAbove", when: editor },
  { key: "ctrl+shift+down", command: "edit.addCursorBelow", when: editor },
  { key: "cmd+=", command: "view.zoomIn" },
  { key: "cmd+-", command: "view.zoomOut" },
  { key: "cmd+0", command: "view.zoomReset" },
  { key: "alt+cmd+\\", command: "view.toggleLayout" },
  { key: "alt+cmd+w", command: "view.toggleWebView" },
  { key: "ctrl+cmd+f", command: "view.toggleFullScreen" },
  { key: "cmd+shift+p", command: "view.commandPalette" },
];

export interface ResolvedBinding {
  chord: KeyChord;
  key: string;
  command: CommandId;
  when?: string;
  source: "default" | "user";
}

/** Defaults first, then user rules in file order; a later match wins (Task 13 resolver). */
export function resolveKeybindings(
  defaults: readonly KeybindingRule[],
  overrides: readonly KeybindingRule[],
): ResolvedBinding[] {
  const toBinding = (rule: KeybindingRule, source: ResolvedBinding["source"]): ResolvedBinding | null => {
    if (!isCommandId(rule.command) || !isValidChord(rule.key)) return null;
    const chord = parseChord(rule.key);
    return { chord, key: chordToSpec(chord), command: rule.command, source, ...(rule.when ? { when: rule.when } : {}) };
  };
  let bindings = defaults.flatMap((rule) => toBinding(rule, "default") ?? []);
  for (const rule of overrides) {
    if (rule.command.startsWith("-")) {
      if (!isValidChord(rule.key)) continue;
      const chord = parseChord(rule.key);
      const id = rule.command.slice(1);
      bindings = bindings.filter(
        (binding) =>
          !(
            binding.command === id &&
            chordsEqual(binding.chord, chord) &&
            (rule.when === undefined || binding.when === rule.when)
          ),
      );
      continue;
    }
    const binding = toBinding(rule, "user");
    if (binding) bindings.push(binding);
  }
  return bindings;
}

/** The chord shown in menus and the palette: the last (highest-precedence) binding for the command. */
export function shortcutFor(bindings: readonly ResolvedBinding[], command: string): KeyChord | null {
  for (let index = bindings.length - 1; index >= 0; index--) {
    const binding = bindings[index];
    if (binding?.command === command) return binding.chord;
  }
  return null;
}
