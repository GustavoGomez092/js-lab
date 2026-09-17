import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { type KeybindingRule, keybindingsFileSchema } from "@jslab/shared";
import { writeFileAtomic } from "../persistence/atomic-write";

/**
 * User keybinding overrides in keybindings.json (spec §4.5, §6.5): read at startup and written by
 * Settings → Keybindings. `onChange` is what lets a save reach the running app -- the native menu's shortcut text
 * and the main window's dispatcher and keycaps -- without a relaunch (Finding K1).
 */
export class KeybindingsStore {
  #rules: KeybindingRule[];
  readonly #listeners = new Set<(rules: readonly KeybindingRule[]) => void>();

  private constructor(
    readonly path: string,
    rules: KeybindingRule[],
    readonly invalid: boolean,
  ) {
    this.#rules = rules;
  }

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

  get rules(): readonly KeybindingRule[] {
    return this.#rules;
  }

  /**
   * Replaces the whole override set. The incoming rules go through `keybindingsFileSchema` -- the same validator
   * the read path uses -- so the file can never end up holding a rule a later launch would silently drop.
   * The in-memory set and the listeners are updated only after the write succeeds: a failed save must not move the
   * running app off what the file actually holds.
   */
  async save(rules: readonly KeybindingRule[]): Promise<void> {
    const valid = keybindingsFileSchema.parse(rules);
    await writeFileAtomic(this.path, `${JSON.stringify(valid, null, 2)}\n`, { backup: true });
    this.#rules = valid;
    for (const listener of [...this.#listeners]) listener(valid);
  }

  onChange(listener: (rules: readonly KeybindingRule[]) => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }
}
