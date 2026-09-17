import { LANGUAGES, RUNTIMES } from "@jslab/shared";
import { z } from "zod";
import { MAX_TEXT_CHARS } from "./ui-rpc";

/** Spec §16.2 takes `ts|js|tsx|jsx`; the wire and `TabState.language` take the full names. The CLI translates. */
export const CLI_LANG_ALIASES = {
  ts: "typescript",
  js: "javascript",
  tsx: "tsx",
  jsx: "jsx",
} as const satisfies Record<string, (typeof LANGUAGES)[number]>;

/** One `jslab` invocation opens at most this many files, and each path is bounded like every other path on the wire. */
export const MAX_CLI_FILES = 50;
export const MAX_CLI_PATH_CHARS = 4096;
/** `--title`'s bound. The CLI (`args.ts`'s `titleProblem`) checks the same constant so an over-long title is a usage
 * error (exit 2) rather than sailing past `parseArgs` and being rejected here as a server error (exit 1). */
export const MAX_CLI_TITLE_CHARS = 200;

const absolute = z.string().min(1).max(MAX_CLI_PATH_CHARS).startsWith("/", "must be an absolute path");

/**
 * `open`'s params (spec §16.3). The socket is 0600 under the user's own app data, so this validates shape and
 * bounds rather than trust: a malformed request must become one error reply, never a Main-side throw.
 *
 * `runtime` accepts all three runtimes on purpose (§16.2 `--runtime bun|browser|browser-node`); every one of them
 * is in `AVAILABLE_RUNTIMES` since M4 Task 9, so none of them is narrowed here.
 */
export const cliOpenParamsSchema = z
  .object({
    files: z.array(absolute).max(MAX_CLI_FILES).optional(),
    code: z.string().max(MAX_TEXT_CHARS).optional(),
    run: z.boolean().optional(),
    runtime: z.enum(RUNTIMES).optional(),
    lang: z.enum(LANGUAGES).optional(),
    cwd: absolute.optional(),
    title: z.string().min(1).max(MAX_CLI_TITLE_CHARS).optional(),
  })
  .refine((params) => (params.files?.length ?? 0) > 0 || params.code !== undefined, {
    message: "open needs at least one file, or code from stdin",
  });

export type CliOpenParams = z.infer<typeof cliOpenParamsSchema>;

/** Spec §16.3's success reply, minus the `id`/`ok` envelope `handleLine` adds. */
export interface CliOpenResult {
  tabIds: string[];
}
