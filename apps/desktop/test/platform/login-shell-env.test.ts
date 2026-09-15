import { describe, expect, test } from "bun:test";
import { mergeLoginEnv, readLoginShellEnv, runLoginShell } from "../../src/main/platform/login-shell-env";

const bytes = (text: string) => new TextEncoder().encode(text);
const NUL = String.fromCharCode(0);
const LF = String.fromCharCode(10);

describe("loginShellEnv adapter (spec §4.6)", () => {
  test("runs the login shell once, parses env -0 output, and merges it without taking JSLAB_* variables", async () => {
    const calls: string[][] = [];
    const env = await readLoginShellEnv({
      shell: "zsh",
      run: async (argv) => {
        calls.push(argv);
        return {
          exitCode: 0,
          stdout: bytes(`PATH=/opt/tools/bin:/usr/bin${NUL}MULTI=a${LF}b${NUL}JSLAB_USER_DATA=/evil${NUL}EMPTY=${NUL}`),
        };
      },
      log: () => {},
    });
    expect(calls).toEqual([["/bin/zsh", "-ilc", "env -0"]]);
    expect(env).toEqual({ PATH: "/opt/tools/bin:/usr/bin", MULTI: `a${LF}b`, JSLAB_USER_DATA: "/evil", EMPTY: "" });
    expect(mergeLoginEnv({ PATH: "/usr/bin", JSLAB_E2E: "1", ONLY_PROCESS: "x" }, env)).toEqual({
      PATH: "/opt/tools/bin:/usr/bin",
      MULTI: `a${LF}b`,
      EMPTY: "",
      JSLAB_E2E: "1",
      ONLY_PROCESS: "x",
    });
    expect(mergeLoginEnv({ PATH: "/usr/bin" }, null)).toEqual({ PATH: "/usr/bin" });
  });

  test("a failing or slow login shell is logged and yields null; the real runner is killed at the timeout", async () => {
    const logged: string[] = [];
    const log = (message: string) => void logged.push(message);
    expect(
      await readLoginShellEnv({ shell: "/bin/zsh", run: async () => ({ exitCode: 1, stdout: bytes("") }), log }),
    ).toBeNull();
    expect(
      await readLoginShellEnv({
        shell: "/bin/zsh",
        run: async () => {
          throw new Error("spawn failed");
        },
        log,
      }),
    ).toBeNull();
    expect(logged).toHaveLength(2);
    const started = Date.now();
    expect((await runLoginShell(["/bin/sh", "-c", "sleep 5"], 50)).exitCode).toBeNull();
    expect(Date.now() - started).toBeLessThan(2000);
  });
});
