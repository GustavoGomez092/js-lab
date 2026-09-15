import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mergeLoginEnv, readLoginShellEnv, runLoginShell } from "../../src/main/platform/login-shell-env";

const bytes = (text: string) => new TextEncoder().encode(text);
const NUL = String.fromCharCode(0);
const LF = String.fromCharCode(10);
const markOf = (argv: string[] | undefined) => /__JSLAB_ENV_[0-9a-f]+__/.exec(argv?.[2] ?? "")?.[0] ?? "";

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Polls a PID recorded by the test's own child until it's gone, for at most `ms`. */
async function goneWithin(pid: number, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (!isAlive(pid)) return true;
    await Bun.sleep(20);
  }
  return !isAlive(pid);
}

async function readPidFile(pidFile: string, waitMs: number): Promise<number | null> {
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    if (existsSync(pidFile)) {
      const pid = Number.parseInt(await readFile(pidFile, "utf8"), 10);
      if (Number.isInteger(pid) && pid > 0) return pid;
    }
    await Bun.sleep(20);
  }
  return null;
}

describe("loginShellEnv adapter (spec §4.6)", () => {
  test("runs the login shell once, parses env -0 output, and merges it without taking JSLAB_* variables", async () => {
    const calls: string[][] = [];
    const env = await readLoginShellEnv({
      shell: "zsh",
      run: async (argv) => {
        calls.push(argv);
        const mark = markOf(argv);
        return {
          exitCode: 0,
          stdout: bytes(
            `${mark}PATH=/opt/tools/bin:/usr/bin${NUL}MULTI=a${LF}b${NUL}JSLAB_USER_DATA=/evil${NUL}EMPTY=${NUL}${mark}`,
          ),
        };
      },
      log: () => {},
    });
    expect(calls).toHaveLength(1);
    const mark = markOf(calls[0]);
    expect(mark).toMatch(/^__JSLAB_ENV_[0-9a-f]{32}__$/);
    expect(calls).toEqual([["/bin/zsh", "-ilc", `printf %s ${mark}; env -0; printf %s ${mark}`]]);
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
    expect(logged[0]).toContain("exit 1");
    expect(logged[1]).toContain("spawn failed");
    const started = Date.now();
    expect((await runLoginShell(["/bin/sh", "-c", "sleep 5"], 50)).exitCode).toBeNull();
    expect(Date.now() - started).toBeLessThan(2000);
  });

  test("shell noise around the marked env output is ignored, and invalid names are dropped", async () => {
    const logged: string[] = [];
    const log = (message: string) => void logged.push(message);
    const marks: string[] = [];
    const noisy = async (argv: string[]) => {
      const mark = markOf(argv);
      marks.push(mark);
      return {
        exitCode: 0,
        stdout: bytes(
          `Welcome to my shell${LF}${mark}PATH=/opt/bin${NUL}A=b=c${NUL}C D=1${NUL}=x${NUL}${mark}bye${LF}`,
        ),
      };
    };
    expect(await readLoginShellEnv({ shell: "/bin/zsh", run: noisy, log })).toEqual({ PATH: "/opt/bin", A: "b=c" });
    expect(logged).toEqual([]);
    await readLoginShellEnv({ shell: "/bin/zsh", run: noisy, log });
    expect(marks).toHaveLength(2);
    expect(marks[0]).not.toBe(marks[1]);
    const unmarked = await readLoginShellEnv({
      shell: "/bin/zsh",
      run: async () => ({ exitCode: 0, stdout: bytes(`PATH=/opt/bin${NUL}`) }),
      log,
    });
    expect(unmarked).toBeNull();
    expect(logged).toHaveLength(1);
    expect(logged[0]).toContain("no output");
  });

  test("a process that leaves the shell's group but holds stdout can't stall past the deadline", async () => {
    const folder = await realpath(await mkdtemp(join(tmpdir(), "jslab-login-holder-")));
    const pidFile = join(folder, "holder.pid");
    const cmd = `perl -e 'open(F, ">", $ARGV[0]); print F $$; close F; setpgrp(0,0); sleep 5' ${pidFile} &`;
    try {
      const started = Date.now();
      await runLoginShell(["/bin/sh", "-c", cmd], 200);
      expect(Date.now() - started).toBeLessThan(2000);
    } finally {
      const pid = await readPidFile(pidFile, 1000);
      if (pid !== null && isAlive(pid)) process.kill(pid, "SIGKILL");
      await rm(folder, { recursive: true, force: true });
    }
  }, 10000);

  test("output over the cap is a failure and the child is killed", async () => {
    const folder = await realpath(await mkdtemp(join(tmpdir(), "jslab-login-flood-")));
    const pidFiles = [join(folder, "via-read.pid"), join(folder, "direct.pid")];
    const flood = (pidFile: string) => ["/bin/sh", "-c", `echo $$ > ${pidFile}; exec yes`];
    try {
      const logged: string[] = [];
      const env = await readLoginShellEnv({
        shell: "/bin/sh",
        run: (_argv, timeoutMs) => runLoginShell(flood(pidFiles[0] ?? ""), timeoutMs),
        timeoutMs: 5000,
        log: (message) => void logged.push(message),
      });
      expect(env).toBeNull();
      expect(logged).toHaveLength(1);
      expect(logged[0]).toContain("too large");
      const direct = await runLoginShell(flood(pidFiles[1] ?? ""), 5000);
      expect(direct.exitCode).toBeNull();
      for (const pidFile of pidFiles) {
        const pid = await readPidFile(pidFile, 1000);
        expect(pid).not.toBeNull();
        expect(await goneWithin(pid ?? 0, 1000)).toBe(true);
      }
    } finally {
      for (const pidFile of pidFiles) {
        const pid = existsSync(pidFile) ? Number.parseInt(await readFile(pidFile, "utf8"), 10) : Number.NaN;
        if (Number.isInteger(pid) && pid > 0 && isAlive(pid)) process.kill(pid, "SIGKILL");
      }
      await rm(folder, { recursive: true, force: true });
    }
  }, 15000);
});
