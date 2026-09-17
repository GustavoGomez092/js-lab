import { rename } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { MAX_SNIPPETS_FILE_BYTES } from "@jslab/rpc-schema";
import {
  MAX_SNIPPETS,
  parseSnippetsFile,
  SNIPPETS_FORMAT,
  SNIPPETS_VERSION,
  type Snippet,
  snippetSchema,
  snippetsFileContent,
} from "@jslab/shared";
import { readBoundedText } from "../files/bounded-read";
import { type AtomicWriteOptions, writeFileAtomic } from "../persistence/atomic-write";
import type { Recovery } from "../persistence/json-store";

export type SnippetWrite = (path: string, data: string, options: AtomicWriteOptions) => Promise<void>;

/** The snippets of a readable library, or null when the text is absent, not JSON, or not a `jslab-snippets` file. */
function parseLibrary(text: string): Snippet[] | null {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return null;
  }
  const parsed = parseSnippetsFile(json);
  return parsed.ok ? parsed.snippets : null;
}

/** As above, for a file that is allowed to be missing or unreadable -- the `.bak`, never the primary. */
async function tryRead(path: string): Promise<Snippet[] | null> {
  try {
    return parseLibrary(await readBoundedText(path, MAX_SNIPPETS_FILE_BYTES));
  } catch {
    return null;
  }
}

/**
 * `snippets.json` (spec §4.5, §13.4): the snippet library, written atomically with a `.bak`. Shaped after `EnvStore`,
 * including its FR-2 rule -- only a missing file means "nothing saved yet"; any other read failure must reach the
 * caller, or the next save would overwrite the user's real library with an empty one.
 */
export class SnippetStore {
  #snippets: Snippet[];

  private constructor(
    readonly path: string,
    snippets: Snippet[],
    /**
     * Widened from EnvStore's `"none" | "defaults"` to `json-store`'s `Recovery`, because unlike env.json this file
     * is written *with* a backup: a store that keeps a `.bak` it never reads would, on the second save after a
     * corruption, copy the empty library over the one good copy of the user's snippets that was left.
     */
    readonly recovered: Recovery,
    private readonly write: SnippetWrite,
  ) {
    this.#snippets = snippets;
  }

  static async open(path: string, options: { write?: SnippetWrite; now?: () => number } = {}): Promise<SnippetStore> {
    const write = options.write ?? writeFileAtomic;
    let text: string | null;
    try {
      // The same cap `snippets.importDialog` applies to a file the user picks (spec §13.4), now applied to the
      // library JSLab loads at launch as well: one file format, one limit, enforced before the allocation rather
      // than after it. Over the cap or not a regular file, it reaches the non-ENOENT branch and fails the caller.
      text = await readBoundedText(path, MAX_SNIPPETS_FILE_BYTES);
    } catch (error) {
      // FR-2: only a missing file means "no library yet". Any other read failure (EACCES, EIO, EISDIR, ...) must
      // fail the caller instead of silently returning an empty store, since the next save() would then overwrite
      // the user's real snippets.json with an empty library.
      if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") throw error;
      text = null;
    }
    const snippets = text === null ? null : parseLibrary(text);
    if (snippets !== null) return new SnippetStore(path, snippets, "none", write);
    if (text !== null) {
      // Spec §20's idiom, as EnvStore and loadJson both use it: never delete what could not be understood. Moving
      // it aside (rather than copying) also keeps the next save's `backup: true` from replacing a good .bak with it.
      const copy = join(dirname(path), `${basename(path, ".json")}.corrupt-${(options.now ?? Date.now)()}.json`);
      await rename(path, copy);
    }
    const backup = await tryRead(`${path}.bak`);
    if (backup !== null) return new SnippetStore(path, backup, "backup", write);
    return new SnippetStore(path, [], text === null ? "none" : "defaults", write);
  }

  get snippets(): Snippet[] {
    return this.#snippets;
  }

  /** Validates every record before any byte is written, so a bad save can never truncate the library. */
  async save(snippets: Snippet[]): Promise<Snippet[]> {
    if (snippets.length > MAX_SNIPPETS) throw new Error(`At most ${MAX_SNIPPETS} snippets`);
    const valid = snippets.map((snippet) => snippetSchema.parse(snippet));
    // `open` is the authority on what a library is: anything written here must read back, or the next launch would
    // move the user's whole library aside as corrupt. Only the whole-file check sees duplicate names and ids.
    const readable = parseSnippetsFile({ format: SNIPPETS_FORMAT, version: SNIPPETS_VERSION, snippets: valid });
    if (!readable.ok) throw new Error(`Refusing to write a library JSLab could not read back: ${readable.detail}`);
    await this.write(this.path, snippetsFileContent(valid), { backup: true });
    this.#snippets = valid;
    return valid;
  }
}
