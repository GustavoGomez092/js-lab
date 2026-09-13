import { join } from "node:path";
import { type DeepPartial, defaultSettings, mergeSettings, type Settings, settingsSchema } from "@jslab/shared";
import { writeFileAtomic } from "../persistence/atomic-write";
import { loadJson, type Recovery } from "../persistence/json-store";

export class SettingsStore {
  #settings: Settings;
  readonly #listeners = new Set<(settings: Settings) => void>();

  private constructor(
    private readonly path: string,
    settings: Settings,
    readonly recovered: Recovery,
  ) {
    this.#settings = settings;
  }

  static async open(dataDir: string): Promise<SettingsStore> {
    const path = join(dataDir, "settings.json");
    const { value, recovered } = await loadJson(path, settingsSchema, defaultSettings);
    const store = new SettingsStore(path, value, recovered);
    // The recovery rewrite must not back up: `path` still holds the corrupt/stale primary at this point, and
    // backing it up would clobber a good `.bak` that recovery just read from (ruling I1).
    if (recovered !== "none") await store.#save({ backup: false });
    return store;
  }

  get current(): Settings {
    return this.#settings;
  }

  async update(patch: DeepPartial<Settings>): Promise<Settings> {
    this.#settings = mergeSettings(this.#settings, patch);
    await this.#save();
    for (const listener of this.#listeners) listener(this.#settings);
    return this.#settings;
  }

  onChange(listener: (settings: Settings) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  #save(options: { backup?: boolean } = {}): Promise<void> {
    return writeFileAtomic(this.path, `${JSON.stringify(this.#settings, null, 2)}\n`, {
      backup: options.backup ?? true,
    });
  }
}
