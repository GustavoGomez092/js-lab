import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  type DeepPartial,
  defaultSettings,
  mergeSettings,
  SETTINGS_VERSION,
  type Settings,
  settingsParser,
} from "@jslab/shared";
import { writeFileAtomic } from "../persistence/atomic-write";
import { loadJson, type Recovery } from "../persistence/json-store";

async function storedVersion(path: string): Promise<number | null> {
  try {
    const raw = JSON.parse(await readFile(path, "utf8")) as { version?: unknown };
    return typeof raw.version === "number" ? raw.version : 1;
  } catch {
    return null;
  }
}

export class SettingsStore {
  #settings: Settings;
  readonly #listeners = new Set<(settings: Settings) => void>();

  private constructor(
    private readonly path: string,
    settings: Settings,
    readonly recovered: Recovery,
    /**
     * The version stored in a settings.json written by a newer JSLab, or null. While set, changes stay in memory and
     * the file is never written, so an older build never downgrades a newer file (final review I4).
     */
    readonly newerVersion: number | null,
  ) {
    this.#settings = settings;
  }

  static async open(dataDir: string): Promise<SettingsStore> {
    const path = join(dataDir, "settings.json");
    const { value, recovered } = await loadJson(path, settingsParser, defaultSettings);
    // The version of the file that was actually loaded: the primary, or the backup after a recovery.
    const version =
      recovered === "backup"
        ? await storedVersion(`${path}.bak`)
        : recovered === "none"
          ? await storedVersion(path)
          : null;
    const newerVersion = version !== null && version > SETTINGS_VERSION ? version : null;
    const store = new SettingsStore(path, value, recovered, newerVersion);
    if (newerVersion !== null) return store;
    // Rewrite after recovery, and after migrating an older file so it isn't migrated again on every launch.
    // Recovery rewrites skip the backup, so the good .bak survives (M1 T12 ruling); a migration of a valid file keeps it.
    if (recovered !== "none") await store.#save(false);
    else if (version !== null && version < SETTINGS_VERSION) await store.#save(true);
    return store;
  }

  get current(): Settings {
    return this.#settings;
  }

  async update(patch: DeepPartial<Settings>): Promise<Settings> {
    this.#settings = mergeSettings(this.#settings, patch);
    await this.#save();
    this.#notify();
    return this.#settings;
  }

  /** Settings → Advanced → Reset All Settings… (spec §8). */
  async reset(): Promise<Settings> {
    this.#settings = defaultSettings();
    await this.#save();
    this.#notify();
    return this.#settings;
  }

  onChange(listener: (settings: Settings) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  #notify(): void {
    for (const listener of this.#listeners) listener(this.#settings);
  }

  #save(backup = true): Promise<void> {
    if (this.newerVersion !== null) return Promise.resolve();
    return writeFileAtomic(this.path, `${JSON.stringify(this.#settings, null, 2)}\n`, { backup });
  }
}
