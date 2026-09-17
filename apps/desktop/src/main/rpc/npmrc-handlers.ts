import { emptyParamsSchema, MAX_NPMRC_BYTES, npmrcSaveParamsSchema, type SaveResult } from "@jslab/rpc-schema";
import { DEFAULT_NPMRC } from "@jslab/shared";
import { readBoundedText } from "../fs/bounded-read";
import { type AtomicWriteOptions, writeFileAtomic } from "../persistence/atomic-write";
import { createValidators, type Log } from "./validate";

const NL = String.fromCharCode(10);

export interface NpmrcHandlerDeps {
  path: string;
  write?(path: string, data: string, options: AtomicWriteOptions): Promise<void>;
  /** After a save or reset (the registry may have changed). */
  onSaved(): void;
  log: Log;
}

/** Settings → NPM (spec §11.5): read, save and reset `<packages>/.npmrc`. Content is never logged. */
export function createNpmrcHandlers(deps: NpmrcHandlerDeps) {
  const { parse } = createValidators(deps.log);
  const write = (content: string) => (deps.write ?? writeFileAtomic)(deps.path, content, { mode: 0o600 });
  return {
    requests: {
      "npmrc.get": async (input: unknown): Promise<{ content: string }> => {
        parse(emptyParamsSchema, "npmrc.get", input);
        try {
          // F2: this shipped the whole file over RPC with no cap at all. Only a missing file is the default now:
          // the same rule FR-12 already applied to npm-service's #readNpmrc, so an oversized or unreadable
          // .npmrc surfaces as a failure instead of silently offering the default to be saved over the user's
          // real file.
          return { content: await readBoundedText(deps.path, MAX_NPMRC_BYTES) };
        } catch (error) {
          if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return { content: DEFAULT_NPMRC };
          throw error;
        }
      },
      "npmrc.save": (input: unknown): Promise<SaveResult> => {
        const { content } = parse(npmrcSaveParamsSchema, "npmrc.save", input);
        const text = content === "" || content.endsWith(NL) ? content : `${content}${NL}`;
        return write(text).then(
          () => {
            deps.onSaved();
            return { ok: true as const };
          },
          (error: unknown) => ({ ok: false as const, error: error instanceof Error ? error.message : String(error) }),
        );
      },
      "npmrc.reset": async (input: unknown): Promise<{ content: string }> => {
        parse(emptyParamsSchema, "npmrc.reset", input);
        // F-NPMRC: the same rule `npmrc.get` applies, for the same reason. Writing the default over a file that is
        // present but unreadable -- oversized, a FIFO, permission-denied -- destroys contents that neither the user
        // nor JSLab has ever seen; only a genuinely absent file may be replaced sight unseen. The guard lives here
        // rather than only in Settings because a UI-only guard leaves the path open to every other caller.
        try {
          await readBoundedText(deps.path, MAX_NPMRC_BYTES);
        } catch (error) {
          if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") throw error;
        }
        await write(DEFAULT_NPMRC);
        deps.onSaved();
        return { content: DEFAULT_NPMRC };
      },
    },
    messages: {},
  };
}
