import { join } from "node:path";
import { type KeybindingRule, keybindingsFileSchema } from "@jslab/shared";
import { readBoundedText } from "../fs/bounded-read";
import { writeFileAtomic } from "../persistence/atomic-write";

/**
 * keybindings.json's byte cap. `keybindingRuleSchema` bounds every rule (key 64, command 101, when 200 chars) but
 * not how many rules a file may hold, so this is a policy bound rather than a derived one: 4 MB is on the order of
 * ten thousand rules, far past any hand-written file, and every command a rule can name must already exist.
 *
 * The refusal is visible rather than silent: an over-cap -- or non-regular -- file sets `invalid`, the same flag
 * unparseable JSON already sets, instead of quietly reporting "no overrides" as a missing file does.
 */
export const MAX_KEYBINDINGS_BYTES = 4 * 1024 * 1024;

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
      text = await readBoundedText(path, MAX_KEYBINDINGS_BYTES);
    } catch (error) {
      // Only a genuinely missing file means "no overrides". A file that is present but unreadable -- a FIFO or a
      // directory at the path (ENOTREGULAR), one past MAX_KEYBINDINGS_BYTES (EFBIG), or EACCES/EIO -- is reported
      // as `invalid`, the same flag unparseable JSON sets, so the user is told their keybindings were not applied
      // instead of silently losing every override. The path is in JSLab's own user-writable data dir, so "JSLab's
      // own file" says nothing about what is actually at it now.
      if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return new KeybindingsStore(path, [], false);
      return new KeybindingsStore(path, [], true);
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
