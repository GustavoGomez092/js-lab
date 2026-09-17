import { emptyParamsSchema, npmrcSaveParamsSchema, type SaveResult } from "@jslab/rpc-schema";
import { DEFAULT_NPMRC } from "@jslab/shared";
import { MAX_NPMRC_BYTES, readBoundedText } from "../files/bounded-read";
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
      "npmrc.get": (input: unknown): Promise<{ content: string }> => {
        parse(emptyParamsSchema, "npmrc.get", input);
        // `npmrc.save` refuses content over MAX_NPMRC_CHARS, so that character limit -- converted to bytes -- is
        // the largest `.npmrc` JSLab can have written. Anything bigger is refused before it is allocated.
        return readBoundedText(deps.path, MAX_NPMRC_BYTES).then(
          (content) => ({ content }),
          () => ({ content: DEFAULT_NPMRC }),
        );
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
      "npmrc.reset": (input: unknown): Promise<{ content: string }> => {
        parse(emptyParamsSchema, "npmrc.reset", input);
        return write(DEFAULT_NPMRC).then(() => {
          deps.onSaved();
          return { content: DEFAULT_NPMRC };
        });
      },
    },
    messages: {},
  };
}
