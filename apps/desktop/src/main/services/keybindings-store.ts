import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { type KeybindingRule, keybindingsFileSchema } from "@jslab/shared";

/** Reads user keybinding overrides from keybindings.json (spec §4.5, §6.5). The editing UI arrives in M5. */
export class KeybindingsStore {
  private constructor(
    readonly path: string,
    readonly rules: KeybindingRule[],
    readonly invalid: boolean,
  ) {}

  static async open(dataDir: string): Promise<KeybindingsStore> {
    const path = join(dataDir, "keybindings.json");
    let text: string;
    try {
      text = await readFile(path, "utf8");
    } catch {
      return new KeybindingsStore(path, [], false);
    }
    try {
      return new KeybindingsStore(path, keybindingsFileSchema.parse(JSON.parse(text)), false);
    } catch {
      return new KeybindingsStore(path, [], true);
    }
  }
}
