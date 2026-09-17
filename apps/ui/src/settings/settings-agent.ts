import type { E2EUiMethod } from "@jslab/rpc-schema";
import type { Settings } from "@jslab/shared";
import { typeIntoField } from "../e2e/fields";
import { keyEventInit } from "../e2e/keys";

export interface SettingsSnapshot {
  ready: boolean;
  tab: string;
  query: string;
  fieldCount: number;
  fontOptions: string[];
  settings: Settings | null;
  npmrc: { content: string; dirty: boolean; status: string | null } | null;
  keybindings: { rowCount: number; query: string; status: string | null; capturing: string | null } | null;
}

/** Answers `e2e.*` calls routed with `window: "settings"`. */
export function createSettingsAgent(deps: {
  state(): SettingsSnapshot;
  execute(id: string, args?: unknown): boolean;
  target(): EventTarget;
}) {
  return async (method: E2EUiMethod, params: unknown): Promise<unknown> => {
    switch (method) {
      case "state":
        return deps.state();
      case "command": {
        const { id, args } = params as { id: string; args?: unknown };
        if (!deps.execute(id, args)) throw new Error(`Unknown settings command: ${id}`);
        return { executed: id };
      }
      case "type": {
        const { text, replace } = params as { text: string; replace?: boolean };
        if (!typeIntoField(deps.target(), text, replace === true)) throw new Error("No settings field has focus");
        return { typed: text.length };
      }
      case "key": {
        const init = keyEventInit((params as { key: string }).key);
        const target = deps.target();
        const notPrevented = target.dispatchEvent(new KeyboardEvent("keydown", init));
        target.dispatchEvent(new KeyboardEvent("keyup", init));
        return { defaultPrevented: !notPrevented };
      }
      case "output":
        throw new Error("The Settings window has no output");
    }
  };
}
