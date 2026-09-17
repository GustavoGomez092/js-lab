import { join } from "node:path";
import { type KeybindingRule, keybindingsFileSchema } from "@jslab/shared";
import { readBoundedText } from "../fs/bounded-read";

/**
 * keybindings.json's byte cap. `keybindingRuleSchema` bounds every rule (key 64, command 101, when 200 chars) but
 * not how many rules a file may hold, so this is a policy bound rather than a derived one: 4 MB is on the order of
 * ten thousand rules, far past any hand-written file, and every command a rule can name must already exist.
 *
 * The refusal is visible rather than silent: an over-cap -- or non-regular -- file sets `invalid`, the same flag
 * unparseable JSON already sets, instead of quietly reporting "no overrides" as a missing file does.
 */
export const MAX_KEYBINDINGS_BYTES = 4 * 1024 * 1024;

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
}
