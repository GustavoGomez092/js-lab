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
import { type AtomicWriteOptions, writeFileAtomic } from "../persistence/atomic-write";
import {
  createDebouncedWriter,
  type DebouncedWriter,
  loadJson,
  type PrimaryFile,
  type Recovery,
} from "../persistence/json-store";

async function storedVersion(path: string): Promise<number | null> {
  try {
    const raw = JSON.parse(await readFile(path, "utf8")) as { version?: unknown };
    return typeof raw.version === "number" ? raw.version : 1;
  } catch {
    return null;
  }
}

export type SettingsWrite = (path: string, data: string, options: AtomicWriteOptions) => Promise<void>;

export interface SettingsStoreOptions {
  /** The atomic file write (injectable for tests). */
  write?: SettingsWrite;
}

export class SettingsStore {
  #settings: Settings;
  readonly #listeners = new Set<(settings: Settings) => void>();
  // FA-I1: every update and reset goes through one writer, so writes run one at a time in the order they were made
  // and an older snapshot can never rename over a newer one. `flush()` lets quit wait for the last write.
  readonly #writer: DebouncedWriter;

  private constructor(
    private readonly path: string,
    settings: Settings,
    readonly recovered: Recovery,
    /**
     * The version stored in a settings.json written by a newer JSLab, or null. While set, changes stay in memory and
     * the file is never written, so an older build never downgrades a newer file (final review I4).
     */
    readonly newerVersion: number | null,
    private readonly write: SettingsWrite,
    /** FA-m4: what was wrong with settings.json at load, and the corrupt copy saved this launch. */
    readonly primary: PrimaryFile = "ok",
    readonly corruptCopy: string | null = null,
  ) {
    this.#settings = settings;
    // A zero delay: a write starts on the next flush, which update/reset call at once. Failures reject that flush.
    this.#writer = createDebouncedWriter(
      (data) => this.write(this.path, data, { backup: true }),
      0,
      () => {},
    );
  }

  static async open(dataDir: string, options: SettingsStoreOptions = {}): Promise<SettingsStore> {
    const path = join(dataDir, "settings.json");
    const { value, recovered, primary, corruptCopy } = await loadJson(path, settingsParser, defaultSettings);
    // The version of the file that was actually loaded: the primary, or the backup after a recovery.
    const version =
      recovered === "backup"
        ? await storedVersion(`${path}.bak`)
        : recovered === "none"
          ? await storedVersion(path)
          : null;
    const newerVersion = version !== null && version > SETTINGS_VERSION ? version : null;
    const store = new SettingsStore(
      path,
      value,
      recovered,
      newerVersion,
      options.write ?? writeFileAtomic,
      primary,
      corruptCopy,
    );
    if (newerVersion !== null) return store;
    // Rewrite after recovery, and after migrating an older file so it isn't migrated again on every launch.
    // Recovery rewrites skip the backup, so the good .bak survives (M1 T12 ruling); a migration of a valid file keeps it.
    // These run before the store is shared, so nothing can overlap them.
    if (recovered !== "none") await store.write(path, store.#snapshot(), { backup: false });
    else if (version !== null && version < SETTINGS_VERSION)
      await store.write(path, store.#snapshot(), { backup: true });
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

  /** Waits for every queued settings write to land (before-quit, spec §10.3). */
  flush(): Promise<void> {
    return this.#writer.flush();
  }

  onChange(listener: (settings: Settings) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  #notify(): void {
    for (const listener of this.#listeners) listener(this.#settings);
  }

  #snapshot(): string {
    return `${JSON.stringify(this.#settings, null, 2)}\n`;
  }

  /** Queues the current snapshot behind any in-flight write and waits for it; rejects when that write fails. */
  #save(): Promise<void> {
    if (this.newerVersion !== null) return Promise.resolve();
    this.#writer.schedule(this.#snapshot());
    return this.#writer.flush();
  }
}
