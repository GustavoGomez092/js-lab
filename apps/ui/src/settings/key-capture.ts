import {
  chordFromEvent,
  chordToSpec,
  formatChord,
  isValidChord,
  type KeyChord,
  type KeyLike,
  parseChord,
} from "@jslab/shared";

export type CaptureOutcome =
  | { kind: "ignored" }
  | { kind: "cancelled" }
  | { kind: "rejected"; reason: "bareKey" | "reserved" }
  | { kind: "captured"; key: string; label: string };

const FUNCTION_KEY = /^f([1-9]|1[0-2])$/;

/** Escape is the way out of an armed capture field, so it is never bindable from the capture editor. */
const RESERVED_KEYS = new Set(["escape"]);

function hasModifier(chord: KeyChord): boolean {
  return chord.meta || chord.ctrl || chord.alt;
}

/**
 * Whether a chord may be bound from the capture editor.
 *
 * A bare printable key is refused: binding `k` alone would fire a command every time the user typed `k`. Function
 * keys are the exception, because the shipped default keymap already binds `F1` and `F5` bare (spec §6.5). Shift is
 * deliberately not a modifier here -- ⇧K is still typing.
 */
export function isBindable(chord: KeyChord): boolean {
  if (RESERVED_KEYS.has(chord.key)) return false;
  if (FUNCTION_KEY.test(chord.key)) return true;
  return hasModifier(chord);
}

/**
 * The same decision as `captureKey`, reached from a chord spec rather than a key event.
 *
 * The E2E `keybindings.capture` command names a chord as text, so it needs a way in that is not a keyboard event --
 * and it must not be a way *around* the rules. Routing both entry points through here is also what keeps the
 * `reserved` outcome reachable: `captureKey` answers Escape as `cancelled` before it can ever be rejected, so
 * without this path that branch would be unreachable code no test could kill.
 */
export function captureSpec(spec: string): CaptureOutcome {
  if (!isValidChord(spec)) return { kind: "ignored" };
  const chord = parseChord(spec);
  if (RESERVED_KEYS.has(chord.key)) return { kind: "rejected", reason: "reserved" };
  if (!isBindable(chord)) return { kind: "rejected", reason: "bareKey" };
  return { kind: "captured", key: chordToSpec(chord), label: formatChord(chord) };
}

/**
 * One keydown inside an armed capture field.
 *
 * Ordering matters and is the escape hatch: Escape is answered before anything else, and bare Tab is passed through
 * so a keyboard-only user can always leave the field. Nothing here silently swallows a key -- every outcome either
 * captures, cancels, explains, or deliberately lets the browser handle it.
 */
export function captureKey(event: KeyLike): CaptureOutcome {
  const chord = chordFromEvent(event);
  // A lone modifier press, or a key with no mapping, is not an event worth reacting to.
  if (!chord) return { kind: "ignored" };
  if (chord.key === "escape") return { kind: "cancelled" };
  // Keyboard navigation must survive an armed field; ⇧⇥ is still navigation.
  if (chord.key === "tab" && !hasModifier(chord)) return { kind: "ignored" };
  return captureSpec(chordToSpec(chord));
}
