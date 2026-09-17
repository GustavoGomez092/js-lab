import { describe, expect, test } from "bun:test";
import {
  CLI_LANG_ALIASES,
  MAX_CLI_CODE_CHARS,
  MAX_CLI_FILES,
  MAX_CLI_PATH_CHARS,
  MAX_CLI_TITLE_CHARS,
} from "@jslab/rpc-schema";
import { RUNTIMES } from "@jslab/shared";
import { type CliOptions, codeProblem, parseArgs, USAGE } from "../../src/cli/args";

describe("parseArgs", () => {
  test("no arguments is an error that shows the usage", () => {
    expect(parseArgs([])).toEqual({ kind: "error", message: `jslab needs a file or -\n${USAGE}` });
  });

  test("bare file names become files", () => {
    expect(parseArgs(["a.ts", "../b/c.tsx"])).toEqual({
      kind: "open",
      options: { files: ["a.ts", "../b/c.tsx"], stdin: false, run: false },
    });
  });

  test("- means stdin", () => {
    expect(parseArgs(["-"])).toEqual({ kind: "open", options: { files: [], stdin: true, run: false } });
  });

  test("--run opens and runs", () => {
    expect(parseArgs(["--run", "a.ts"]).kind).toBe("open");
    expect((parseArgs(["--run", "a.ts"]) as { options: { run: boolean } }).options.run).toBe(true);
  });

  test("every runtime in §16.2 is accepted, and nothing else is", () => {
    for (const runtime of ["bun", "browser", "browser-node"] as const) {
      expect((parseArgs(["--runtime", runtime, "-"]) as { options: { runtime?: string } }).options.runtime).toBe(
        runtime,
      );
    }
    expect(parseArgs(["--runtime", "deno", "-"])).toEqual({
      kind: "error",
      message: "--runtime takes bun, browser or browser-node, not deno",
    });
  });

  test("--lang takes the short spellings and maps them to languages", () => {
    const mapped = (value: string) =>
      (parseArgs(["--lang", value, "-"]) as { options: { lang?: string } }).options.lang;
    expect([mapped("ts"), mapped("js"), mapped("tsx"), mapped("jsx")]).toEqual([
      "typescript",
      "javascript",
      "tsx",
      "jsx",
    ]);
    expect(parseArgs(["--lang", "cobol", "-"])).toEqual({
      kind: "error",
      message: "--lang takes ts, js, tsx or jsx, not cobol",
    });
  });

  test("--cwd and --title carry their values", () => {
    const parsed = parseArgs(["--cwd", "/w/project", "--title", "scratch", "-"]) as { options: CliOptions };
    expect(parsed.options).toEqual({ files: [], stdin: true, run: false, cwd: "/w/project", title: "scratch" });
  });

  test("--flag=value is accepted alongside --flag value", () => {
    const parsed = parseArgs(["--runtime=browser", "--lang=jsx", "-"]) as { options: CliOptions };
    expect(parsed.options).toMatchObject({ runtime: "browser", lang: "jsx" });
  });

  test("a flag missing its value is an error, not a silently dropped flag", () => {
    expect(parseArgs(["--cwd"])).toEqual({ kind: "error", message: "--cwd needs a value" });
    expect(parseArgs(["--title", "--run", "a.ts"])).toEqual({ kind: "error", message: "--title needs a value" });
  });

  test("an unknown flag is an error", () => {
    expect(parseArgs(["--nope", "a.ts"])).toEqual({ kind: "error", message: `Unknown option --nope\n${USAGE}` });
  });

  test("--help and --version short-circuit", () => {
    expect(parseArgs(["--help"])).toEqual({ kind: "help" });
    expect(parseArgs(["-h"])).toEqual({ kind: "help" });
    expect(parseArgs(["--version"])).toEqual({ kind: "version" });
    expect(parseArgs(["--run", "--help", "a.ts"])).toEqual({ kind: "help" });
  });

  test("the usage text matches the spec's own grammar", () => {
    expect(USAGE).toContain("jslab [file ...]");
    expect(USAGE).toContain("--runtime bun|browser|browser-node");
    expect(USAGE).toContain("--lang ts|js|tsx|jsx");
  });

  // The cases below are not in the task brief. `parseArgs` is the only thing standing between a user's shell and a
  // socket request, so every one of them is a rejection path the brief's parser accepted silently.

  test("-v is the short --version, and any other short flag is an unknown option, not a file name", () => {
    expect(parseArgs(["-v"])).toEqual({ kind: "version" });
    // The brief's parser only recognised "--" as a flag prefix, so `jslab -x a.ts` silently asked the app to open a
    // file literally named "-x". A file that really is named that is reachable as ./-x, as with every other CLI.
    expect(parseArgs(["-x", "a.ts"])).toEqual({ kind: "error", message: `Unknown option -x\n${USAGE}` });
    expect(parseArgs(["./-x"])).toEqual({ kind: "open", options: { files: ["./-x"], stdin: false, run: false } });
  });

  test("- alongside files opens both: the wire carries files and code in one request (§16.3)", () => {
    expect(parseArgs(["a.ts", "-", "b.ts"])).toEqual({
      kind: "open",
      options: { files: ["a.ts", "b.ts"], stdin: true, run: false },
    });
    // stdin is read once however many times it is named, so a repeated marker is not an error.
    expect(parseArgs(["-", "-"])).toEqual({ kind: "open", options: { files: [], stdin: true, run: false } });
  });

  test("a value position never swallows the stdin marker or the flag that follows", () => {
    // Without this, `jslab --title - ` ate the `-` and then failed with "jslab needs a file or -", which names the
    // very argument the user did pass.
    expect(parseArgs(["--title", "-"])).toEqual({ kind: "error", message: "--title needs a value" });
    expect(parseArgs(["--cwd", "-x", "a.ts"])).toEqual({ kind: "error", message: "--cwd needs a value" });
    // An inline value is unambiguous, so it is still allowed to start with a dash.
    expect((parseArgs(["--title=-scratch", "-"]) as { options: { title?: string } }).options.title).toBe("-scratch");
  });

  test("an empty path is an error here, because resolving it would silently become the current directory", () => {
    // `cliOpenParamsSchema` bounds paths with `.min(1)`, but it sees the *resolved* path: `resolve(cwd, "")` is the
    // cwd, a perfectly valid absolute path, so an empty argument would sail through the schema and ask Main to open
    // a directory. It has to be caught on this side.
    expect(parseArgs([""])).toEqual({ kind: "error", message: "A file path can't be empty" });
    expect(parseArgs(["--cwd=", "-"])).toEqual({ kind: "error", message: "--cwd needs a value" });
  });

  test("the CLI refuses more than MAX_CLI_FILES files instead of letting the socket reject the batch", () => {
    const files = Array.from({ length: MAX_CLI_FILES }, (_, index) => `f${index}.ts`);
    expect((parseArgs(files) as { options: { files: string[] } }).options.files).toHaveLength(MAX_CLI_FILES);
    expect(parseArgs([...files, "one-too-many.ts"])).toEqual({
      kind: "error",
      message: `jslab opens at most ${MAX_CLI_FILES} files at once`,
    });
  });

  test("a path longer than MAX_CLI_PATH_CHARS is refused, for files and for --cwd alike", () => {
    const long = "a".repeat(MAX_CLI_PATH_CHARS + 1);
    const message = `A path is longer than ${MAX_CLI_PATH_CHARS} characters`;
    expect(parseArgs([long])).toEqual({ kind: "error", message });
    expect(parseArgs(["--cwd", long, "-"])).toEqual({ kind: "error", message });
    // The bound itself is still allowed: resolving may lengthen it, and that is the schema's call, not the parser's.
    expect(parseArgs(["b".repeat(MAX_CLI_PATH_CHARS)]).kind).toBe("open");
  });

  test("a --title longer than MAX_CLI_TITLE_CHARS is refused client-side, like an over-long path", () => {
    // Before this check existed, an over-long title sailed past `parseArgs`, was rejected by the server's
    // `cliOpenParamsSchema` (`.max(MAX_CLI_TITLE_CHARS)`), and the CLI exited 1 -- a server error -- for what is a
    // malformed argument, which every other bad argument here reports as exit 2 instead (`main.ts`'s `run`).
    const long = "a".repeat(MAX_CLI_TITLE_CHARS + 1);
    expect(parseArgs(["--title", long, "-"])).toEqual({
      kind: "error",
      message: `A title is longer than ${MAX_CLI_TITLE_CHARS} characters`,
    });
    // The bound itself is still allowed, matching the server schema's own `.max(MAX_CLI_TITLE_CHARS)`.
    expect(
      (parseArgs(["--title", "a".repeat(MAX_CLI_TITLE_CHARS), "-"]) as { options: { title?: string } }).options.title,
    ).toHaveLength(MAX_CLI_TITLE_CHARS);
  });

  test("an empty --title is refused client-side too, mirroring the schema's `.min(1)`", () => {
    expect(parseArgs(["--title", "", "-"])).toEqual({ kind: "error", message: "--title needs a value" });
    expect(parseArgs(["--title=", "-"])).toEqual({ kind: "error", message: "--title needs a value" });
  });

  test("the rejection messages list exactly the shared vocabularies, so neither can drift", () => {
    const listed = (message: string) =>
      message
        .slice(message.indexOf("takes ") + "takes ".length, message.indexOf(", not "))
        .split(/, | or /)
        .sort();
    const runtimeMessage = (parseArgs(["--runtime", "deno", "-"]) as { message: string }).message;
    expect(listed(runtimeMessage)).toEqual([...RUNTIMES].sort());
    const langMessage = (parseArgs(["--lang", "cobol", "-"]) as { message: string }).message;
    expect(listed(langMessage)).toEqual(Object.keys(CLI_LANG_ALIASES).sort());
  });
});

describe("codeProblem", () => {
  test("bounds the piped script at MAX_CLI_CODE_CHARS, the constant the wire schema reads too", () => {
    // `code` is the one input that never comes from argv, so `parseArgs` never sees it and it was the only argument
    // with no client-side bound. The schema used to allow MAX_TEXT_CHARS (64 MiB) while the request travels as one
    // NDJSON line capped far lower, so an over-long script was schema-legal and undeliverable: the server ended the
    // socket and the CLI reported "The JSLab socket closed before replying" instead of naming the size.
    expect(codeProblem("x".repeat(MAX_CLI_CODE_CHARS))).toBeUndefined();
    expect(codeProblem("x".repeat(MAX_CLI_CODE_CHARS + 1))).toBe(
      `The piped script is longer than ${MAX_CLI_CODE_CHARS} characters`,
    );
  });
});
