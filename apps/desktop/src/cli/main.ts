#!/usr/bin/env bun
import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";
import { type CliOptions, codeProblem, parseArgs, USAGE } from "./args";
import { bunTransport, type CliTransport, connectOrLaunch, launchAllowed } from "./client";
import { candidateSocketPaths } from "./socket-path";

export const VERSION = "0.0.1";

/**
 * Everything `run` touches that isn't its own argument: the command line, the environment, the two streams, and the
 * transport. Injected rather than reached for, so the whole command can be driven in a test without a process, a
 * socket, or a real JSLab — nothing in this file's tests may launch the user's installed app.
 */
export interface CliIo {
  argv: string[];
  env: Record<string, string | undefined>;
  cwd: string;
  home: string;
  transport: CliTransport;
  readStdin(): Promise<string>;
  out(text: string): void;
  err(text: string): void;
}

/**
 * Spec §16.3's request body, built from §16.2's already-validated options. Paths are made absolute here so Main never
 * resolves anything against its own process's working directory, which is the bundle, not the user's shell. Spec
 * §16.2: `-` defaults the tab's working directory to the current one.
 */
export function openParams(options: CliOptions, cwd: string, code: string | undefined): Record<string, unknown> {
  const files = options.files.map((file) => (isAbsolute(file) ? file : resolve(cwd, file)));
  const workingDirectory = options.cwd === undefined ? (options.stdin ? cwd : undefined) : resolve(cwd, options.cwd);

  const params: Record<string, unknown> = {};
  if (files.length > 0) params.files = files;
  if (code !== undefined) params.code = code;
  if (options.run) params.run = true;
  if (options.runtime !== undefined) params.runtime = options.runtime;
  if (options.lang !== undefined) params.lang = options.lang;
  if (workingDirectory !== undefined) params.cwd = workingDirectory;
  if (options.title !== undefined) params.title = options.title;
  return params;
}

/**
 * One `jslab` invocation (spec §16.2, §16.3): parse, connect (launching JSLab if that is allowed), send one `open`,
 * print the tab ids. Returns the process's exit code; a connection or socket failure rejects and the entry below
 * turns it into exit 1, because those messages are the transport's own and are already user-facing.
 */
export async function run(io: CliIo): Promise<number> {
  const parsed = parseArgs(io.argv);
  if (parsed.kind === "help") {
    io.out(USAGE);
    return 0;
  }
  if (parsed.kind === "version") {
    io.out(`jslab ${VERSION}`);
    return 0;
  }
  if (parsed.kind === "error") {
    io.err(parsed.message);
    return 2;
  }

  const { options } = parsed;
  const code = options.stdin ? await io.readStdin() : undefined;
  // Checked here, before anything connects, so an over-long script is a usage error (exit 2) with a size message
  // rather than a socket that closes mid-request and is reported as a transport failure (exit 1).
  if (code !== undefined) {
    const problem = codeProblem(code);
    if (problem !== undefined) {
      io.err(problem);
      return 2;
    }
  }
  const params = openParams(options, io.cwd, code);
  const paths = candidateSocketPaths(io.env, io.home);
  // A scripted or sandboxed run (the E2E suite included) must never launch the user's installed JSLab.
  const connection = await connectOrLaunch(paths, io.transport, launchAllowed(io.env));
  try {
    const reply = await connection.call("open", params);
    // The server sends `tabIds`, but this is the one place a malformed reply would reach `.join` — and a throw here
    // would be reported as a CLI crash rather than as JSLab answering oddly.
    const tabIds = Array.isArray(reply.tabIds) ? reply.tabIds : [];
    io.out(tabIds.join("\n"));
    return 0;
  } finally {
    // `client.ts` never closes its own socket when `call` rejects (Task 5's carried finding): this line is the only
    // thing that closes it on either path, so it must not itself be able to throw and mask the real failure.
    try {
      connection.close();
    } catch {
      // The process is exiting either way; a socket that is already gone is not something to report.
    }
  }
}

// Only when this file *is* the command. A test imports `run` and drives it directly, and must not start a CLI.
if (import.meta.main) {
  run({
    argv: process.argv.slice(2),
    env: process.env,
    cwd: process.cwd(),
    home: homedir(),
    transport: bunTransport,
    readStdin: async () => await new Response(Bun.stdin.stream()).text(),
    out: (text) => console.log(text),
    err: (text) => console.error(text),
  }).then(
    (code) => process.exit(code),
    (error: unknown) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    },
  );
}
