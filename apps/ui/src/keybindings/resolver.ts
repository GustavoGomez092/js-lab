import { type CommandId, chordFromEvent, chordsEqual, type KeyLike, type ResolvedBinding } from "@jslab/shared";
import type { AppState } from "../state/store";
import { evaluateWhen } from "./when";

export interface UiContext {
  editorFocus: boolean;
  outputFocus: boolean;
  modalOpen: boolean;
  paletteOpen: boolean;
  dialogOpen: boolean;
  textInputFocus: boolean;
}

export function contextFromState(state: AppState, activeElement: Element | null, editorHasFocus: boolean): UiContext {
  const tag = activeElement?.tagName;
  const editable =
    tag === "INPUT" ||
    tag === "TEXTAREA" ||
    tag === "SELECT" ||
    (activeElement as HTMLElement | null)?.isContentEditable === true;
  return {
    editorFocus: editorHasFocus,
    outputFocus: Boolean(activeElement?.closest?.(".output")),
    modalOpen: state.modal !== null,
    paletteOpen: state.modal?.kind === "palette",
    dialogOpen: state.modal?.kind === "confirm" || state.modal?.kind === "rename",
    textInputFocus: editable && !editorHasFocus,
  };
}

/** The single keyboard dispatcher (spec §6.5). */
export class KeybindingResolver {
  #bindings: readonly ResolvedBinding[];

  constructor(bindings: readonly ResolvedBinding[]) {
    this.#bindings = bindings;
  }

  setBindings(bindings: readonly ResolvedBinding[]): void {
    this.#bindings = bindings;
  }

  resolve(event: KeyLike, context: UiContext): CommandId | null {
    const chord = chordFromEvent(event);
    if (!chord) return null;
    const when = { ...context };
    for (let index = this.#bindings.length - 1; index >= 0; index--) {
      const binding = this.#bindings[index];
      if (!binding || !chordsEqual(binding.chord, chord)) continue;
      if (context.modalOpen && !binding.when?.includes("modalOpen")) continue;
      if (context.textInputFocus && !chord.meta && !chord.ctrl) continue;
      if (!evaluateWhen(binding.when, when)) continue;
      return binding.command;
    }
    return null;
  }
}
