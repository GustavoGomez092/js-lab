import { chmod, rename, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import {
  type EnvVars,
  envFileSchema,
  envVarsSchema,
  MAX_ENV_KEY_CHARS,
  MAX_ENV_VALUE_CHARS,
  MAX_ENV_VARS,
} from "@jslab/shared";
import { readBoundedText } from "../fs/bounded-read";
import { type AtomicWriteOptions, writeFileAtomic } from "../persistence/atomic-write";

export const ENV_FILE_MODE = 0o600;

/**
 * env.json's byte cap, derived from the schema JSLab itself enforces on save rather than guessed at: at most
 * `MAX_ENV_VARS` entries, each a key of at most `MAX_ENV_KEY_CHARS` and a value of at most `MAX_ENV_VALUE_CHARS`.
 * The factor of 6 is the worst case for a single source character inside a JSON string -- a `\uXXXX` escape -- and
 * the slack covers the punctuation, indentation and `version` field around the variables themselves.
 *
 * Deliberately generous: a real env.json is a few hundred bytes, but refusing one JSLab would happily have written
 * is a bug, whereas the cap only has to stop an unbounded allocation on Main's loop.
 */
export const MAX_ENV_BYTES = 6 * MAX_ENV_VARS * (MAX_ENV_KEY_CHARS + MAX_ENV_VALUE_CHARS) + 64 * 1024;
export type EnvWrite = (path: string, data: string, options: AtomicWriteOptions) => Promise<void>;

/** `env.json` (spec §4.5, §12.1): variables shared by every tab, mode 0600, written without a backup. */
export class EnvStore {
  #variables: EnvVars;
  readonly #listeners = new Set<(variables: EnvVars) => void>();

  private constructor(
    private readonly path: string,
    variables: EnvVars,
    readonly recovered: "none" | "defaults",
    private readonly write: EnvWrite,
  ) {
    this.#variables = variables;
  }

  static async open(path: string, options: { write?: EnvWrite; now?: () => number } = {}): Promise<EnvStore> {
    const write = options.write ?? writeFileAtomic;
    let text: string | null;
    try {
      text = await readBoundedText(path, MAX_ENV_BYTES);
    } catch (error) {
      // FR-2: only a missing file means "no environment yet". Any other read failure (EACCES, EIO, EBUSY, and now
      // ENOTREGULAR for a FIFO/directory or EFBIG for an over-cap file) must fail the caller instead of silently
      // returning an empty store, since the next save() would then overwrite the user's real env.json with {}.
      // env.json sits in JSLab's own user-writable data dir, so being the file JSLab wrote is no guarantee it is
      // still a regular file by the time it is read; the reader refuses one rather than blocking Main on it.
      if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") throw error;
      text = null;
    }
    if (text === null) return new EnvStore(path, {}, "none", write);
    const parsed = (() => {
      try {
        return envFileSchema.safeParse(JSON.parse(text));
      } catch {
        return null;
      }
    })();
    if (!parsed?.success) {
      const copy = join(dirname(path), `${basename(path, ".json")}.corrupt-${(options.now ?? Date.now)()}.json`);
      await rename(path, copy);
      await chmod(copy, ENV_FILE_MODE);
      return new EnvStore(path, {}, "defaults", write);
    }
    if (((await stat(path)).mode & 0o777) !== ENV_FILE_MODE) await chmod(path, ENV_FILE_MODE);
    return new EnvStore(path, parsed.data.variables, "none", write);
  }

  get variables(): EnvVars {
    return this.#variables;
  }

  /** Values of four or more characters, masked in logs and the debug report (spec §18). */
  secrets(): string[] {
    return Object.values(this.#variables).filter((value) => value.length >= 4);
  }

  async save(variables: EnvVars): Promise<EnvVars> {
    const valid = envVarsSchema.parse(variables);
    await this.write(this.path, `${JSON.stringify({ version: 1, variables: valid }, null, 2)}\n`, {
      mode: ENV_FILE_MODE,
    });
    this.#variables = valid;
    for (const listener of this.#listeners) listener(valid);
    return valid;
  }

  onChange(listener: (variables: EnvVars) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }
}
