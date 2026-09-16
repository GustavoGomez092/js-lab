import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRedactor } from "../../src/main/logging/redact";
import { createWebNodeRunner, type WebNodeRunnerDeps } from "../../src/main/rpc/web-node-handlers";

/**
 * Task 11 (spec §5.13). These calls carry the **user's own permissions, the same as a `bun` tab** — the ruling on
 * spec line 509 ("full user permissions, same as `bun`"). An earlier draft confined every path to the tab's working
 * directory; the tests that pinned that confinement are now parity tests pinning its absence, because a script that
 * works in a `bun` tab must keep working when the tab is switched to `browser-node`.
 *
 * Run against real paths on a real disk: a fake `fs` cannot tell a symlink from an ordinary file, and the parity
 * claim is about what the filesystem actually does.
 */

interface SentEvent {
  type: "result" | "error" | "stdout" | "stderr" | "exit";
  payload: Record<string, unknown>;
}

let root = "";
let workingDirectory = "";
let outside = "";
let dataDir = "";

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "jslab-web-node-"));
  workingDirectory = join(root, "wd");
  outside = join(root, "outside");
  dataDir = join(root, "data");
  await mkdir(workingDirectory, { recursive: true });
  await mkdir(outside, { recursive: true });
  await mkdir(dataDir, { recursive: true });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function setup(overrides: Partial<WebNodeRunnerDeps> = {}) {
  const events: SentEvent[] = [];
  const record =
    (type: SentEvent["type"]) =>
    (payload: Record<string, unknown>): void => {
      events.push({ type, payload });
    };
  const log = mock((_message: string, _detail?: unknown) => {});
  const deps: WebNodeRunnerDeps = {
    send: {
      result: record("result") as WebNodeRunnerDeps["send"]["result"],
      error: record("error") as WebNodeRunnerDeps["send"]["error"],
      stdout: record("stdout") as WebNodeRunnerDeps["send"]["stdout"],
      stderr: record("stderr") as WebNodeRunnerDeps["send"]["stderr"],
      exit: record("exit") as WebNodeRunnerDeps["send"]["exit"],
    },
    redact: createRedactor(),
    log,
    baseDirectory: workingDirectory,
    ...overrides,
  };
  return { deps, events, log, runner: createWebNodeRunner(deps) };
}

const fsCall = (id: number, method: string, args: unknown[]) => ({ id, module: "fs" as const, method, args });
const cpCall = (id: number, method: string, args: unknown[]) => ({
  id,
  module: "child_process" as const,
  method,
  args,
});

async function waitUntil(condition: () => boolean, label: string, timeoutMs = 4000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await Bun.sleep(1);
  }
}

const decode = (value: unknown) => Buffer.from(String(value), "base64");
const textOf = (events: SentEvent[], type: "stdout" | "stderr") =>
  events
    .filter((event) => event.type === type)
    .map((event) => decode(event.payload.data).toString("utf8"))
    .join("");

describe("fs over the bridge", () => {
  test("readFile returns the file's bytes", async () => {
    await writeFile(join(workingDirectory, "notes.txt"), "hello from the project");
    const { runner, events } = setup();
    runner.call(1, fsCall(1, "readFile", ["notes.txt"]));
    await waitUntil(() => events.length > 0, "the reply");
    expect(events[0]?.type).toBe("result");
    expect(decode(events[0]?.payload.value).toString("utf8")).toBe("hello from the project");
  });

  test("writeFile really writes, and readdir lists", async () => {
    const { runner, events } = setup();
    runner.call(1, fsCall(1, "writeFile", ["out.txt", Buffer.from("written").toString("base64")]));
    await waitUntil(() => events.length > 0, "the write to finish");
    expect(await readFile(join(workingDirectory, "out.txt"), "utf8")).toBe("written");

    runner.call(2, fsCall(2, "readdir", ["."]));
    await waitUntil(() => events.length > 1, "the listing");
    expect(events[1]?.payload.value).toEqual(["out.txt"]);
  });

  test("a missing file comes back as an ENOENT error, not a hang", async () => {
    const { runner, events } = setup();
    runner.call(1, fsCall(1, "readFile", ["nope.txt"]));
    await waitUntil(() => events.length > 0, "the failure");
    expect(events[0]?.type).toBe("error");
    expect(events[0]?.payload.code).toBe("ENOENT");
  });
});

/**
 * These five replaced the old confinement tests one for one. Each previously asserted a refusal; each now asserts
 * the access succeeds, because `browser-node` runs with the user's own permissions exactly as `bun` does.
 */
describe("permissions match the bun runtime (spec §5.13 line 509)", () => {
  test("a ../ path out of the working directory is read, not refused", async () => {
    await writeFile(join(outside, "secret.txt"), "reachable, just like bun");
    const { runner, events } = setup();
    runner.call(1, fsCall(1, "readFile", ["../outside/secret.txt"]));
    await waitUntil(() => events.length > 0, "the reply");
    expect(events[0]?.type).toBe("result");
    expect(decode(events[0]?.payload.value).toString("utf8")).toBe("reachable, just like bun");
  });

  test("an absolute path outside the working directory is read too", async () => {
    const absolute = join(outside, "absolute.txt");
    await writeFile(absolute, "absolutely reachable");
    const { runner, events } = setup();
    runner.call(1, fsCall(1, "readFile", [absolute]));
    await waitUntil(() => events.length > 0, "the reply");
    expect(decode(events[0]?.payload.value).toString("utf8")).toBe("absolutely reachable");
  });

  test("a symlink pointing out of the working directory is followed", async () => {
    await writeFile(join(outside, "secret.txt"), "followed through the link");
    await symlink(join(outside, "secret.txt"), join(workingDirectory, "link.txt"));
    const { runner, events } = setup();
    runner.call(1, fsCall(1, "readFile", ["link.txt"]));
    await waitUntil(() => events.length > 0, "the reply");
    expect(events[0]?.type).toBe("result");
    expect(decode(events[0]?.payload.value).toString("utf8")).toBe("followed through the link");
  });

  test("a rename may cross out of the working directory", async () => {
    await writeFile(join(workingDirectory, "a.txt"), "moved");
    const { runner, events } = setup();
    runner.call(1, fsCall(1, "rename", ["a.txt", "../outside/b.txt"]));
    await waitUntil(() => events.length > 0, "the rename");
    expect(events[0]?.type).toBe("result");
    expect(await readFile(join(outside, "b.txt"), "utf8")).toBe("moved");
  });

  /**
   * The parity target, taken from `apps/desktop/src/main/runs/runner-config.ts:69`:
   * `const cwd = workingDirectory ?? deps.paths.dataDir`. A tab with no working directory resolves a relative path
   * against the app's data directory — not the app's process cwd, and not a refusal. `web-adapter.ts` computes the
   * base with that same expression; this pins the behaviour the runner gives it.
   */
  test("with no working directory, a relative path resolves against the data directory", async () => {
    await writeFile(join(dataDir, "notes.txt"), "resolved from the data directory");
    const { runner, events } = setup({ baseDirectory: dataDir });
    runner.call(1, fsCall(1, "readFile", ["notes.txt"]));
    await waitUntil(() => events.length > 0, "the reply");
    expect(events[0]?.type).toBe("result");
    expect(decode(events[0]?.payload.value).toString("utf8")).toBe("resolved from the data directory");
  });
});

describe("every bridged call is validated (spec §18)", () => {
  test("a malformed payload is answered with an error, never dropped or performed", async () => {
    const recorder = { calls: 0 };
    const { runner, events } = setup({
      fs: {
        readFile: async () => {
          recorder.calls += 1;
          return Buffer.from("never");
        },
      } as unknown as WebNodeRunnerDeps["fs"],
    });
    // `readFile` takes exactly one path; an empty tuple fails the schema.
    runner.call(1, { id: 1, module: "fs", method: "readFile", args: [] });
    await waitUntil(() => events.length > 0, "the refusal");
    expect(events[0]?.type).toBe("error");
    expect(recorder.calls).toBe(0);
  });

  test("an unknown method is refused rather than dispatched", async () => {
    const { runner, events } = setup();
    runner.call(1, { id: 1, module: "fs", method: "unlinkEverything", args: ["x"] });
    await waitUntil(() => events.length > 0, "the refusal");
    expect(events[0]?.type).toBe("error");
  });

  /**
   * The one path-shaped refusal that survives the ruling. It is about the path being well-formed, not about where
   * it points: a NUL can truncate a path inside a syscall, so a path carrying one is never legitimate.
   */
  test("a path containing a control character is still refused", async () => {
    const recorder = { calls: 0 };
    const { runner, events } = setup({
      fs: {
        readFile: async () => {
          recorder.calls += 1;
          return Buffer.from("never");
        },
      } as unknown as WebNodeRunnerDeps["fs"],
    });
    runner.call(1, fsCall(1, "readFile", ["notes.txt /../../etc/passwd"]));
    await waitUntil(() => events.length > 0, "the refusal");
    expect(events[0]?.type).toBe("error");
    expect(recorder.calls).toBe(0);
  });
});

describe("redaction is scoped to logged diagnostics only", () => {
  /**
   * The load-bearing test for this task's redaction rule. `createRedactor` masks known environment secret values;
   * applying it to a returned file body would mean a user reading their own `.env` gets `[REDACTED]` back instead
   * of their secret — silent data corruption that is undetectable from inside the tab.
   */
  test("a returned file whose body is a credential comes back byte-identical", async () => {
    const secret = "super-secret-value-from-env-json";
    const body = [
      `AUTHORIZATION=Bearer ghp_0123456789abcdefghijklmnopqr`,
      `API_KEY=sk-abcdefghijklmnopqrstuvwx`,
      `AWS=AKIAIOSFODNN7EXAMPLE`,
      `MINE=${secret}`,
      "",
    ].join("\n");
    await writeFile(join(workingDirectory, "secrets.env"), body);

    // A redactor that really would mask all of the above, so the test proves scoping rather than its absence.
    const redact = createRedactor(() => [secret]);
    expect(redact(body)).not.toBe(body);

    const { runner, events } = setup({ redact });
    runner.call(1, fsCall(1, "readFile", ["secrets.env"]));
    await waitUntil(() => events.length > 0, "the reply");

    const returned = decode(events[0]?.payload.value);
    expect(returned.toString("utf8")).toBe(body);
    expect(returned.equals(await readFile(join(workingDirectory, "secrets.env")))).toBe(true);
    expect(returned.toString("utf8")).toContain(secret);
    expect(returned.toString("utf8")).not.toContain("[REDACTED]");
  });

  test("what is logged about a failed call is redacted", async () => {
    const secret = "super-secret-value-from-env-json";
    const { runner, log, events } = setup({ redact: createRedactor(() => [secret]) });
    // A path that does not exist, so the failure message quotes it back.
    runner.call(1, fsCall(1, "readFile", [`${secret}.txt`]));
    await waitUntil(() => events.length > 0, "the failure");

    const logged = log.mock.calls.map((call) => `${String(call[0])} ${String(call[1])}`).join("\n");
    expect(logged).toContain("[REDACTED]");
    expect(logged).not.toContain(secret);
    expect(String(events[0]?.payload.message)).not.toContain(secret);
  });
});

describe("child_process over the bridge (spec §5.13)", () => {
  test("spawn streams stdout back and reports the exit code", async () => {
    const { runner, events } = setup();
    runner.call(1, cpCall(1, "spawn", ["/bin/echo", ["streamed"], {}]));
    await waitUntil(() => events.some((event) => event.type === "exit"), "the process to exit");
    expect(textOf(events, "stdout").trim()).toBe("streamed");
    expect(events[events.length - 1]?.payload.code).toBe(0);
    expect(runner.pending()).toBe(0);
  });

  test("a command runs in the base directory by default, and PWD agrees with it", async () => {
    const { runner, events } = setup();
    runner.call(1, cpCall(1, "exec", ["pwd && echo $PWD", {}]));
    await waitUntil(() => events.some((event) => event.type === "exit"), "the process to exit");
    // macOS reports the temp dir through /private, so compare on both sides with that prefix removed.
    const strip = (value: string) => value.trim().replace(/^\/private/, "");
    const [reported, pwd] = textOf(events, "stdout").trim().split("\n");
    expect(strip(String(reported))).toBe(strip(workingDirectory));
    expect(strip(String(pwd))).toBe(strip(workingDirectory));
  });

  /** `exec(cmd, { cwd })` is ordinary Node; dropping it would be a parity bug against the bun runtime. */
  test("a caller-supplied cwd is honoured, and a relative one resolves from the base", async () => {
    await mkdir(join(workingDirectory, "nested"), { recursive: true });
    const { runner, events } = setup();
    runner.call(1, cpCall(1, "exec", ["pwd", { cwd: "nested" }]));
    await waitUntil(() => events.some((event) => event.type === "exit"), "the process to exit");
    const strip = (value: string) => value.trim().replace(/^\/private/, "");
    expect(strip(textOf(events, "stdout"))).toBe(strip(join(workingDirectory, "nested")));
  });

  test("a caller-supplied env is honoured", async () => {
    const { runner, events } = setup();
    runner.call(1, cpCall(1, "exec", ["echo $JSLAB_TASK11_MARKER", { env: { JSLAB_TASK11_MARKER: "present" } }]));
    await waitUntil(() => events.some((event) => event.type === "exit"), "the process to exit");
    expect(textOf(events, "stdout").trim()).toBe("present");
  });

  test("execFile does not use a shell unless asked, and does when asked", async () => {
    const withoutShell = setup();
    withoutShell.runner.call(1, cpCall(1, "execFile", ["/bin/echo", ["$HOME"], {}]));
    await waitUntil(() => withoutShell.events.some((event) => event.type === "exit"), "the plain process to exit");
    // No shell: the argument reaches the program literally rather than being expanded.
    expect(textOf(withoutShell.events, "stdout").trim()).toBe("$HOME");

    const withShell = setup();
    withShell.runner.call(1, cpCall(1, "execFile", ["/bin/echo", ["hi"], { shell: true }]));
    await waitUntil(() => withShell.events.some((event) => event.type === "exit"), "the shelled process to exit");
    expect(textOf(withShell.events, "stdout").trim()).toBe("hi");
  });

  test("a non-zero exit is reported with its code", async () => {
    const { runner, events } = setup();
    runner.call(1, cpCall(1, "exec", ["exit 3", {}]));
    await waitUntil(() => events.some((event) => event.type === "exit"), "the process to exit");
    expect(events[events.length - 1]?.payload.code).toBe(3);
  });

  // The stream half of the redaction rule: this is the program's own output, streamed to the code that asked
  // for it, so it must arrive exactly as the process wrote it.
  test("stdout carrying a credential-shaped token is streamed back unredacted", async () => {
    const token = "ghp_0123456789abcdefghijklmnopqr";
    const { runner, events } = setup({ redact: createRedactor(() => [token]) });
    runner.call(1, cpCall(1, "spawn", ["/bin/echo", [token], {}]));
    await waitUntil(() => events.some((event) => event.type === "exit"), "the process to exit");
    expect(textOf(events, "stdout").trim()).toBe(token);
    expect(textOf(events, "stdout")).not.toContain("[REDACTED]");
  });

  test("the command line IS redacted before it is logged", async () => {
    const token = "ghp_0123456789abcdefghijklmnopqr";
    const { runner, log, events } = setup({ redact: createRedactor(() => [token]) });
    runner.call(1, cpCall(1, "spawn", ["/bin/echo", [token], {}]));
    await waitUntil(() => events.some((event) => event.type === "exit"), "the process to exit");

    const logged = log.mock.calls.map((call) => `${String(call[0])} ${String(call[1])}`).join("\n");
    expect(logged).toContain("[REDACTED]");
    expect(logged).not.toContain(token);
  });

  test("abortAll kills everything still running, so a retiring run leaves nothing behind", async () => {
    const { runner } = setup();
    runner.call(1, cpCall(1, "spawn", ["/bin/sleep", ["30"], {}]));
    await waitUntil(() => runner.pending() === 1, "the process to start");
    runner.abortAll();
    expect(runner.pending()).toBe(0);
  });

  test("abort kills one running command and releases its entry", async () => {
    const { runner } = setup();
    runner.call(1, cpCall(1, "spawn", ["/bin/sleep", ["30"], {}]));
    await waitUntil(() => runner.pending() === 1, "the process to start");
    runner.abort(1);
    expect(runner.pending()).toBe(0);
  });

  test("an abort for an unknown call is a safe no-op", () => {
    const { runner, events } = setup();
    expect(() => runner.abort(99)).not.toThrow();
    expect(events).toEqual([]);
  });
});
