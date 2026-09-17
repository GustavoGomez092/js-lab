import { LANGUAGES, RUNTIMES } from "@jslab/shared";
import { z } from "zod";

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

/**
 * The NDJSON line cap the socket enforces in BOTH directions (`LineBuffer` in `apps/desktop/src/main/cli/ndjson.ts`
 * reads this, rather than repeating the number). A line over this is not deliverable at all: the server throws
 * "Request line too long" and ends the socket, which reaches the user as "The JSLab socket closed before replying".
 */
export const MAX_CLI_LINE_CHARS = 5_000_000;

/**
 * `code`'s bound (spec §16.2's `-`). Deliberately BELOW `MAX_CLI_LINE_CHARS`, because code travels JSON-escaped
 * inside one request line alongside the envelope and every other param, so the line is always longer than the code
 * itself. It is NOT `MAX_TEXT_CHARS` (64 MiB, the in-app buffer bound): a `code` that large passes this schema and
 * is then undeliverable, so `cat big-bundle.js | jslab --run -` fails as a socket error rather than a size message.
 * `args.ts`'s `codeProblem` checks the same constant one layer earlier, so the user gets the size message instead.
 */
export const MAX_CLI_CODE_CHARS = 4_000_000;

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
    code: z.string().max(MAX_CLI_CODE_CHARS).optional(),
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
