import {
  CLI_LANG_ALIASES,
  MAX_CLI_CODE_CHARS,
  MAX_CLI_FILES,
  MAX_CLI_PATH_CHARS,
  MAX_CLI_TITLE_CHARS,
} from "@jslab/rpc-schema";
import { type Language, RUNTIMES, type Runtime } from "@jslab/shared";

export interface CliOptions {
  /** As typed: `main.ts` makes these absolute before sending (spec §16.3). */
  files: string[];
  stdin: boolean;
  run: boolean;
  runtime?: Runtime;
  lang?: Language;
  cwd?: string;
  title?: string;
}

export type CliParse =
  | { kind: "open"; options: CliOptions }
  | { kind: "help" }
  | { kind: "version" }
  | { kind: "error"; message: string };

/** Spec §16.2, verbatim. */
export const USAGE = `jslab [file ...]                 Open files in new tabs
jslab -                          Read code from stdin into a new tab
jslab --run [file|-]             Open and run immediately
      --runtime bun|browser|browser-node
      --lang ts|js|tsx|jsx       (default: from extension, else settings)
      --cwd <dir>                Set the tab's working directory (default for \`-\`: current dir)
      --title <title>
jslab --version | --help`;

const VALUE_FLAGS = ["--runtime", "--lang", "--cwd", "--title"] as const;
type ValueFlag = (typeof VALUE_FLAGS)[number];

const isValueFlag = (name: string): name is ValueFlag => (VALUE_FLAGS as readonly string[]).includes(name);
/** The vocabulary is `@jslab/shared`'s, not a copy of it: `open`'s schema validates against the same list. */
const isRuntime = (value: string): value is Runtime => (RUNTIMES as readonly string[]).includes(value);
/** §16.2's short spellings come from the wire contract (Task 1), so there is one mapping, not two. */
const LANG_ALIASES: Record<string, Language> = CLI_LANG_ALIASES;

const error = (message: string): CliParse => ({ kind: "error", message });

/**
 * `cliOpenParamsSchema` bounds every path at `MAX_CLI_PATH_CHARS`, but it sees the path `main.ts` resolved, by which
 * point the reply is a socket error rather than a usage message. Checking the typed form here is the same bound, one
 * layer earlier: resolving against the cwd only ever lengthens a relative path.
 */
function pathProblem(value: string): string | undefined {
  return value.length > MAX_CLI_PATH_CHARS ? `A path is longer than ${MAX_CLI_PATH_CHARS} characters` : undefined;
}

/**
 * Same job as `pathProblem`, for `--title`: `cliOpenParamsSchema` bounds it at `MAX_CLI_TITLE_CHARS` too (one
 * constant, imported rather than re-inlined), but by the time it sees the value the reply is a socket error rather
 * than a usage message. An empty title is already caught earlier, by the generic "needs a value" check every value
 * flag gets, which is this parser's answer to the schema's `.min(1)`.
 */
function titleProblem(value: string): string | undefined {
  return value.length > MAX_CLI_TITLE_CHARS ? `A title is longer than ${MAX_CLI_TITLE_CHARS} characters` : undefined;
}

/**
 * Same job again, for the one input that never came from argv: the script piped into `jslab -`. `main.ts` calls this
 * on what `readStdin` returned, before anything connects. Without it an over-long script is schema-legal but larger
 * than one NDJSON line, so the server ends the socket and the user is told "The JSLab socket closed before replying"
 * — the transport blamed for a size problem. `cliOpenParamsSchema` bounds `code` against this same constant.
 */
export function codeProblem(value: string): string | undefined {
  return value.length > MAX_CLI_CODE_CHARS
    ? `The piped script is longer than ${MAX_CLI_CODE_CHARS} characters`
    : undefined;
}

/**
 * Spec §16.2's grammar. argv is user input from a shell, so every branch that cannot be turned into a request ends in
 * `{ kind: "error" }`: `main.ts` (Task 6) prints the message and exits 2 rather than sending something the app has to
 * reject. Values are validated against the shared vocabularies — the wire schema stays the authority on the resolved
 * request, and this never becomes a second, looser copy of it.
 */
export function parseArgs(argv: string[]): CliParse {
  // --help and --version win wherever they appear, so `jslab --run --help` explains rather than runs.
  if (argv.some((arg) => arg === "--help" || arg === "-h")) return { kind: "help" };
  if (argv.some((arg) => arg === "--version" || arg === "-v")) return { kind: "version" };

  const options: CliOptions = { files: [], stdin: false, run: false };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === undefined) continue;
    if (arg === "-") {
      // Naming stdin twice is not an error: it is read once either way.
      options.stdin = true;
      continue;
    }
    if (arg === "--run") {
      options.run = true;
      continue;
    }

    if (!arg.startsWith("-")) {
      // `resolve(cwd, "")` is the cwd — a valid absolute path — so an empty argument would pass the wire schema and
      // ask Main to open a directory. It can only be caught here.
      if (arg === "") return error("A file path can't be empty");
      const problem = pathProblem(arg);
      if (problem !== undefined) return error(problem);
      options.files.push(arg);
      continue;
    }

    const equals = arg.indexOf("=");
    const name = equals === -1 ? arg : arg.slice(0, equals);
    const inline = equals === -1 ? undefined : arg.slice(equals + 1);
    // Every other dash-led argument is a flag, including short ones: treating `-x` as a file name would send the app
    // a request to open a file called "-x" instead of telling the user the option does not exist.
    if (!isValueFlag(name)) return error(`Unknown option ${name}\n${USAGE}`);

    // A separate value that starts with a dash is the next flag or the stdin marker, never this flag's value. An
    // inline `--flag=value` is unambiguous, so that spelling still accepts one.
    const next = argv[index + 1];
    const value = inline ?? (next !== undefined && next !== "" && !next.startsWith("-") ? next : undefined);
    if (value === undefined || value === "") return error(`${name} needs a value`);
    if (inline === undefined) index += 1;

    if (name === "--runtime") {
      // Spec §16.2's own order. The test "the rejection messages list exactly the shared vocabularies" fails if this
      // list and `RUNTIMES` ever drift apart.
      if (!isRuntime(value)) return error(`--runtime takes bun, browser or browser-node, not ${value}`);
      options.runtime = value;
    } else if (name === "--lang") {
      const mapped = LANG_ALIASES[value];
      if (mapped === undefined) return error(`--lang takes ts, js, tsx or jsx, not ${value}`);
      options.lang = mapped;
    } else if (name === "--cwd") {
      const problem = pathProblem(value);
      if (problem !== undefined) return error(problem);
      options.cwd = value;
    } else {
      const problem = titleProblem(value);
      if (problem !== undefined) return error(problem);
      options.title = value;
    }
  }

  if (options.files.length > MAX_CLI_FILES) return error(`jslab opens at most ${MAX_CLI_FILES} files at once`);
  if (options.files.length === 0 && !options.stdin) return error(`jslab needs a file or -\n${USAGE}`);
  return { kind: "open", options };
}
