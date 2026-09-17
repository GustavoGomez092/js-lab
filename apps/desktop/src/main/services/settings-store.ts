import { join } from "node:path";
import {
  type DeepPartial,
  defaultSettings,
  mergeSettings,
  SETTINGS_VERSION,
  type Settings,
  settingsParser,
} from "@jslab/shared";
import { readBoundedText } from "../fs/bounded-read";
import { type AtomicWriteOptions, writeFileAtomic } from "../persistence/atomic-write";
import {
  createDebouncedWriter,
  type DebouncedWriter,
  loadJson,
  type PrimaryFile,
  type Recovery,
} from "../persistence/json-store";
import { strings } from "../strings";

/**
 * settings.json's byte cap. Every field `settingsSchema` defines is a bounded scalar -- strings at 200 chars,
 * numbers with an explicit min and max, a fixed set of sections -- so a settings.json JSLab itself wrote is a few
 * KB. 1 MB is three orders of magnitude of headroom, and it is what stops a settings.json swapped for a multi-GB
 * file from being allocated whole on Main's loop before anything has a chance to validate it.
 *
 * An over-cap file is treated exactly as unparseable JSON already is: fall back to settings.json.bak, then to
 * defaults. That is a real consequence, which is why the cap is set far above any file this app would produce.
 */
export const MAX_SETTINGS_BYTES = 1024 * 1024;

async function storedVersion(path: string): Promise<number | null> {
  try {
    const raw = JSON.parse(await readBoundedText(path, MAX_SETTINGS_BYTES)) as { version?: unknown };
    return typeof raw.version === "number" ? raw.version : 1;
  } catch {
    return null;
  }
}

export type SettingsWrite = (path: string, data: string, options: AtomicWriteOptions) => Promise<void>;

/** RR1-m2: a settings write that takes longer than this fails and lets later writes proceed. */
export const SETTINGS_WRITE_TIMEOUT_MS = 10_000;

export interface SettingsStoreOptions {
  /** The atomic file write (injectable for tests). */
  write?: SettingsWrite;
  writeTimeoutMs?: number;
  /** Called with each failed or timed-out write (RR1-m2). */
  onWriteError?(error: unknown): void;
}

export class SettingsStore {
  #settings: Settings;
  readonly #listeners = new Set<(settings: Settings) => void>();
  // FA-I1: every update and reset goes through one writer, so writes run one at a time in the order they were made
  // and an older snapshot can never rename over a newer one. `flush()` lets quit wait for the last write.
  readonly #writer: DebouncedWriter;
  #generation = 0;

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
    private readonly writeTimeoutMs: number = SETTINGS_WRITE_TIMEOUT_MS,
    private readonly onWriteError: (error: unknown) => void = (error) =>
      console.error(`[jslab] ${strings.log.settingsWriteFailed}`, error),
  ) {
    this.#settings = settings;
    // A zero delay: a write starts on the next flush, which update/reset call at once. Failures reject that flush.
    this.#writer = createDebouncedWriter(
      (data) => this.#timedWrite(data),
      0,
      () => {},
    );
  }

  static async open(dataDir: string, options: SettingsStoreOptions = {}): Promise<SettingsStore> {
    const path = join(dataDir, "settings.json");
    const { value, recovered, primary, corruptCopy } = await loadJson(
      path,
      settingsParser,
      defaultSettings,
      MAX_SETTINGS_BYTES,
    );
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
      options.writeTimeoutMs ?? SETTINGS_WRITE_TIMEOUT_MS,
      options.onWriteError,
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

  /**
   * One queued write, bounded by writeTimeoutMs (RR1-m2). Each write takes a new generation; a write that finishes after
   * a newer one started is not committed.
   */
  #timedWrite(data: string): Promise<void> {
    const generation = ++this.#generation;
    const write = this.write(this.path, data, { backup: true, shouldCommit: () => generation === this.#generation });
    write.catch(() => {});
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(strings.log.settingsWriteTimedOut(this.writeTimeoutMs))),
        this.writeTimeoutMs,
      );
    });
    return Promise.race([write, timeout])
      .finally(() => clearTimeout(timer))
      .catch((error: unknown) => {
        this.onWriteError(error);
        throw error;
      });
  }

  /** Queues the current snapshot behind any in-flight write and waits for it; rejects when that write fails. */
  #save(): Promise<void> {
    if (this.newerVersion !== null) return Promise.resolve();
    this.#writer.schedule(this.#snapshot());
    return this.#writer.flush();
  }
}
