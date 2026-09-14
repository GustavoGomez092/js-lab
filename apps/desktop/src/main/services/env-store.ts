import { chmod, readFile, rename, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { type EnvVars, envFileSchema, envVarsSchema } from "@jslab/shared";
import { type AtomicWriteOptions, writeFileAtomic } from "../persistence/atomic-write";

export const ENV_FILE_MODE = 0o600;
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
      text = await readFile(path, "utf8");
    } catch {
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
