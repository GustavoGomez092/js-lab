import { describe, expect, test } from "bun:test";
import { cliOpenParamsSchema, MAX_CLI_TITLE_CHARS } from "@jslab/rpc-schema";
import type { CliConnection, CliTransport } from "../../src/cli/client";
import { type CliIo, openParams, run } from "../../src/cli/main";

const HOME = "/Users/me";
const CWD = "/Users/me/work";
const SOCKET = "/Users/me/data/jslab.sock";

/** A connection that records what was sent and counts its own closes. Nothing here touches a real socket. */
function fakeConnection(outcome: Record<string, unknown> | Error) {
  const sent: Array<{ method: string; params: unknown }> = [];
  let closes = 0;
  const connection: CliConnection = {
    call: async (method, params) => {
      sent.push({ method, params });
      if (outcome instanceof Error) throw outcome;
      return outcome;
    },
    close: () => {
      closes += 1;
    },
  };
  return { connection, sent, closes: () => closes };
}

/** `now`/`sleep` are simulated, so no test can spin in `connectOrLaunch`'s poll loop or wait on real time. */
function makeTransport(connection: CliConnection | null) {
  const attempted: string[] = [];
  let elapsed = 0;
  let launches = 0;
  const transport: CliTransport = {
    connect: async (path: string) => {
      attempted.push(path);
      return connection;
    },
    launch: async () => {
      launches += 1;
    },
    sleep: async (ms: number) => {
      elapsed += ms;
    },
    now: () => elapsed,
  };
  return { transport, attempted, launches: () => launches };
}

/** A tripwire for the branches that must answer without talking to JSLab at all. */
function unusedTransport(): CliTransport {
  return {
    connect: async () => {
      throw new Error("this command must not open a connection");
    },
    launch: async () => {
      throw new Error("this command must not launch JSLab");
    },
    sleep: async () => {},
    now: () => 0,
  };
}

function makeIo(argv: string[], transport: CliTransport, extra: Partial<CliIo> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const io: CliIo = {
    argv,
    env: { JSLAB_SOCKET: SOCKET },
    cwd: CWD,
    home: HOME,
    transport,
    // Reading stdin when `-` was not passed would block a real shell forever, so the default makes it a failure.
    readStdin: async () => {
      throw new Error("stdin must not be read for this command line");
    },
    out: (text) => out.push(text),
    err: (text) => err.push(text),
    ...extra,
  };
  return { io, out, err };
}

describe("jslab: the branches that answer without JSLab", () => {
  test("--help prints spec §16.2's usage, exits 0, and connects to nothing", async () => {
    const { io, out, err } = makeIo(["--help"], unusedTransport());
    expect(await run(io)).toBe(0);
    expect(out).toHaveLength(1);
    // Literal fragments, not the USAGE constant: an expectation built from the same string the code prints could
    // not notice the help text being replaced wholesale.
    expect(out[0]).toContain("jslab [file ...]");
    expect(out[0]).toContain("--runtime bun|browser|browser-node");
    expect(err).toEqual([]);
  });

  test("--version prints the version spec §16.2 names, on stdout", async () => {
    const { io, out } = makeIo(["--version"], unusedTransport());
    expect(await run(io)).toBe(0);
    // Hardcoded rather than built from VERSION, so this fails if the constant drifts.
    expect(out).toEqual(["jslab 0.0.1"]);
  });

  test("a command line that can't become a request is a usage error on stderr with exit 2", async () => {
    const { io, out, err } = makeIo(["--runtime", "deno", "-"], unusedTransport());
    // Exit 2 is the spec's usage code: 0 would tell a script the tab opened, 1 would look like a socket failure.
    expect(await run(io)).toBe(2);
    expect(err).toEqual(["--runtime takes bun, browser or browser-node, not deno"]);
    expect(out).toEqual([]);
  });

  test("an over-long --title is a usage error on stderr with exit 2, never a socket round trip", async () => {
    // `unusedTransport()` throws the moment anything tries to connect. Before the client-side bound existed, an
    // over-long title sailed past `parseArgs` and reached exactly that call -- in production it would instead reach
    // the real socket, where the server's `cliOpenParamsSchema` (`.max(MAX_CLI_TITLE_CHARS)`) rejects it, `run`'s
    // promise rejects, and the top-level handler in `main.ts` exits 1: a server error for what is a malformed
    // argument, where every other bad argument here exits 2 instead.
    const long = "a".repeat(MAX_CLI_TITLE_CHARS + 1);
    const { io, out, err } = makeIo(["--title", long, "/abs/a.ts"], unusedTransport());
    expect(await run(io)).toBe(2);
    expect(err).toEqual([`A title is longer than ${MAX_CLI_TITLE_CHARS} characters`]);
    expect(out).toEqual([]);
  });
});

describe("jslab: one open request", () => {
  test("every request the CLI builds is one the real open handler's validator accepts", async () => {
    const { connection, sent } = fakeConnection({ ok: true, tabIds: ["t1"] });
    const { transport } = makeTransport(connection);
    const { io } = makeIo(
      [
        "--run",
        "--runtime",
        "browser-node",
        "--lang",
        "tsx",
        "--cwd",
        "sub",
        "--title",
        "Scratch",
        "a.ts",
        "/abs/b.ts",
      ],
      transport,
    );
    expect(await run(io)).toBe(0);

    // The two vocabulary fields are pinned to their literal types so `cliOpenParamsSchema.parse` below accepts this
    // object as its own input: widening them to `string` would only mean the drift guard could not be compiled.
    const expected = {
      files: [`${CWD}/a.ts`, "/abs/b.ts"],
      run: true,
      runtime: "browser-node" as const,
      lang: "tsx" as const,
      cwd: `${CWD}/sub`,
      title: "Scratch",
    };
    expect(sent).toHaveLength(1);
    expect(sent[0]?.method).toBe("open");
    // Two assertions on purpose. The first pins the exact body -- zod strips unknown keys, so parsing alone could
    // not notice the CLI inventing a field. The second is `socket-methods.ts`'s `open` handler verbatim
    // (`cliOpenParamsSchema.parse(params)`), so a relative path or a mistranslated `--lang` fails here rather than
    // in the user's terminal.
    expect(sent[0]?.params).toEqual(expected);
    expect(cliOpenParamsSchema.parse(sent[0]?.params)).toEqual(expected);
  });

  test("`-` reads stdin into `code` and defaults the tab's working directory to the current one", async () => {
    const { connection, sent } = fakeConnection({ ok: true, tabIds: ["t1"] });
    const { transport } = makeTransport(connection);
    const { io } = makeIo(["-"], transport, { readStdin: async () => 'console.log("from stdin")\n' });
    expect(await run(io)).toBe(0);
    expect(sent[0]?.params).toEqual({ code: 'console.log("from stdin")\n', cwd: CWD });
    expect(cliOpenParamsSchema.parse(sent[0]?.params)).toEqual({ code: 'console.log("from stdin")\n', cwd: CWD });
  });

  test("the socket candidates come from the caller's environment and home, not a path baked in here", async () => {
    const fromHome = makeTransport(fakeConnection({ ok: true, tabIds: ["t1"] }).connection);
    const { io } = makeIo(["/abs/a.ts"], fromHome.transport, { env: {} });
    expect(await run(io)).toBe(0);
    expect(fromHome.attempted[0]).toBe(`${HOME}/Library/Application Support/dev.jslab.app/stable/jslab.sock`);

    // And the environment really is consulted: JSLAB_SOCKET replaces the channel list outright (spec §16.3). Without
    // this half, a `run` that passed `{}` instead of the caller's environment would still satisfy the assertion above.
    const fromEnv = makeTransport(fakeConnection({ ok: true, tabIds: ["t1"] }).connection);
    const { io: overridden } = makeIo(["/abs/a.ts"], fromEnv.transport);
    expect(await run(overridden)).toBe(0);
    expect(fromEnv.attempted).toEqual([SOCKET]);
  });

  test("the reply's tab ids are printed one per line, for a shell to read", async () => {
    const { connection } = fakeConnection({ ok: true, tabIds: ["tab-1", "tab-2"] });
    const { transport } = makeTransport(connection);
    const { io, out } = makeIo(["/abs/a.ts"], transport);
    expect(await run(io)).toBe(0);
    expect(out).toEqual(["tab-1\ntab-2"]);
  });

  test("a reply carrying no tab ids is reported, not crashed on", async () => {
    // Without the `Array.isArray` guard this is `undefined.join`, i.e. a CLI stack trace for JSLab answering oddly.
    const { connection } = fakeConnection({ ok: true });
    const { transport } = makeTransport(connection);
    const { io, out } = makeIo(["/abs/a.ts"], transport);
    expect(await run(io)).toBe(0);
    expect(out).toEqual([""]);
  });

  test("JSLAB_CLI_NO_LAUNCH=1 stops the CLI launching the user's installed JSLab", async () => {
    const { transport, launches } = makeTransport(null);
    const { io } = makeIo(["/abs/a.ts"], transport, { env: { JSLAB_SOCKET: SOCKET, JSLAB_CLI_NO_LAUNCH: "1" } });
    await expect(run(io)).rejects.toThrow("JSLab isn't running, and launching is off");
    // A `run` that hardcoded "launching is allowed" would launch here and then time out with a different message.
    expect(launches()).toBe(0);
  });
});

/**
 * Task 5's review carried one Minor forward to this task: `client.ts` never closes its own socket when `call`
 * rejects, so whatever consumes it has to close on every exit path. These are the tests that hold that.
 */
describe("jslab: the connection is always closed", () => {
  test("a successful open closes the socket exactly once", async () => {
    const { connection, closes } = fakeConnection({ ok: true, tabIds: ["t1"] });
    const { transport } = makeTransport(connection);
    const { io } = makeIo(["/abs/a.ts"], transport);
    expect(await run(io)).toBe(0);
    expect(closes()).toBe(1);
  });

  test("a rejected open still closes the socket before the error leaves run()", async () => {
    const { connection, closes } = fakeConnection(new Error("Nothing to open"));
    const { transport } = makeTransport(connection);
    const { io } = makeIo(["/abs/a.ts"], transport);
    await expect(run(io)).rejects.toThrow("Nothing to open");
    // Drop the `finally` and this is 0: the socket outlives the command, which is exactly the leak Task 5 flagged.
    expect(closes()).toBe(1);
  });

  test("a close that itself fails never masks the failure the user needs to see", async () => {
    const connection: CliConnection = {
      call: async () => {
        throw new Error("Nothing to open");
      },
      close: () => {
        throw new Error("socket already ended");
      },
    };
    const { transport } = makeTransport(connection);
    const { io } = makeIo(["/abs/a.ts"], transport);
    // Unguarded, the `finally`'s own throw replaces the rejection and the user is told about a socket instead.
    await expect(run(io)).rejects.toThrow("Nothing to open");
  });
});

describe("openParams: the working directory spec §16.2 gives a tab", () => {
  const options = { files: [] as string[], stdin: false, run: false };

  test("--cwd is resolved against the shell's directory, and wins over the `-` default", () => {
    expect(openParams({ ...options, stdin: true, cwd: "sub" }, CWD, "x")["cwd"]).toBe(`${CWD}/sub`);
    expect(openParams({ ...options, files: ["a.ts"], cwd: "/elsewhere" }, CWD, undefined)["cwd"]).toBe("/elsewhere");
  });

  test("without --cwd, only `-` gets the current directory; a named file leaves it to the app", () => {
    expect(openParams({ ...options, stdin: true }, CWD, "x")["cwd"]).toBe(CWD);
    // A file's tab takes its working directory from the file, so sending one here would override that (§5.3).
    expect(openParams({ ...options, files: ["a.ts"] }, CWD, undefined)).not.toHaveProperty("cwd");
  });

  test("a flag the user did not pass is absent from the request, not sent as a default", () => {
    // `run: false` on the wire is not the same as no `run` at all: the schema's fields are optional so that Main
    // can tell "the user said nothing" from "the user said no".
    const params = openParams({ ...options, files: ["a.ts"] }, CWD, undefined);
    expect(Object.keys(params)).toEqual(["files"]);
  });
});
