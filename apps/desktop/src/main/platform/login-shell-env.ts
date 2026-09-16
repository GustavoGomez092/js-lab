import type { Subprocess } from "bun";
import { strings } from "../strings";

/** Spec §4.6 loginShellEnv: GUI apps lack the shell PATH, so Main reads the login shell's environment once. */
export const LOGIN_SHELL_TIMEOUT_MS = 2000;
/** Login-shell stdout beyond this is a failure, never buffered (R-M3-T14-FIX-1 M-1). */
export const MAX_LOGIN_SHELL_OUTPUT_BYTES = 1024 * 1024;
/** Once the shell has exited, how long a process still holding its stdout may delay the result (I-2). */
const PIPE_GRACE_MS = 100;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** The shell's own bookkeeping, meaningless in a runner that has a different cwd (M-2). */
const SHELL_SESSION_KEYS = new Set(["PWD", "OLDPWD", "SHLVL", "_"]);

export type LoginShellRun = (
  argv: string[],
  timeoutMs: number,
) => Promise<{ exitCode: number | null; stdout: Uint8Array }>;

/** runLoginShell results that stopped at the output cap; readLoginShellEnv logs them as "output too large". */
const overflowed = new WeakSet<object>();

/** NUL-separated `NAME=value` entries; entries without a valid environment variable name are dropped (I-3). */
export function parseEnvNul(input: Uint8Array | string): Record<string, string> {
  const env: Record<string, string> = {};
  const text = typeof input === "string" ? input : new TextDecoder().decode(input);
  for (const entry of text.split(String.fromCharCode(0))) {
    const eq = entry.indexOf("=");
    if (eq <= 0) continue;
    const name = entry.slice(0, eq);
    if (ENV_NAME.test(name)) env[name] = entry.slice(eq + 1);
  }
  return env;
}

/** The text between the first and the last occurrence of `mark`, or null without two distinct occurrences (I-3). */
export function extractMarked(text: string, mark: string): string | null {
  const first = text.indexOf(mark);
  const last = text.lastIndexOf(mark);
  if (first === -1 || last < first + mark.length) return null;
  return text.slice(first + mark.length, last);
}

function killGroup(proc: Subprocess): void {
  try {
    process.kill(-proc.pid, "SIGKILL");
  } catch {
    try {
      proc.kill("SIGKILL");
    } catch {
      // Already gone.
    }
  }
}

/**
 * Decides how a login-shell read ends (pure: every timer comes in through `deadline` and `grace`). Before the shell
 * exits, the deadline or an output overflow ends the wait; EOF alone still waits for the exit or the deadline. Once
 * the shell has exited, only the drain (EOF or overflow) or the grace period can end it, so a shell that finished just
 * before the deadline keeps its output and the total stays under timeoutMs + PIPE_GRACE_MS (R-M3-T14-FIX-2 NEW-N1).
 * "exited" means the shell exited and the bytes collected so far are the result.
 */
export async function settleLoginShell(parts: {
  exited: Promise<unknown>;
  drain: Promise<"eof" | "overflow">;
  deadline: Promise<"deadline">;
  grace: () => Promise<"grace">;
}): Promise<"exited" | "deadline" | "overflow"> {
  const exited = parts.exited.then(() => "exited" as const);
  const first = await Promise.race([parts.drain, parts.deadline, exited]);
  if (first === "exited")
    return (await Promise.race([parts.drain, parts.grace()])) === "overflow" ? "overflow" : "exited";
  // stdout closed before the shell exited: the exit still has to beat the deadline.
  if (first === "eof") return Promise.race([exited, parts.deadline]);
  return first;
}

function concat(chunks: Uint8Array[], size: number): Uint8Array {
  const out = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

/**
 * Spawns the shell in its own process group. The deadline is authoritative (I-2): at `timeoutMs` the group is
 * SIGKILLed and the result is `exitCode: null` without waiting for EOF. Once the shell exits, a process that still
 * holds its stdout gets at most PIPE_GRACE_MS. Output over MAX_LOGIN_SHELL_OUTPUT_BYTES kills the group and fails
 * (M-1). A child that hasn't exited is always killed on the way out.
 */
export const runLoginShell: LoginShellRun = async (argv, timeoutMs) => {
  const proc = Bun.spawn(argv, { stdin: "ignore", stdout: "pipe", stderr: "ignore", detached: true });
  const reader = proc.stdout.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
  let graceTimer: ReturnType<typeof setTimeout> | undefined;
  const failed = () => ({ exitCode: null, stdout: new Uint8Array(0) });
  try {
    const drain = (async (): Promise<"eof" | "overflow"> => {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return "eof";
        if (size + value.byteLength > MAX_LOGIN_SHELL_OUTPUT_BYTES) return "overflow";
        chunks.push(value);
        size += value.byteLength;
      }
    })();
    const outcome = await settleLoginShell({
      exited: proc.exited,
      drain,
      deadline: new Promise<"deadline">((resolve) => {
        deadlineTimer = setTimeout(() => resolve("deadline"), timeoutMs);
      }),
      grace: () =>
        new Promise<"grace">((resolve) => {
          graceTimer = setTimeout(() => resolve("grace"), PIPE_GRACE_MS);
        }),
    });
    if (outcome !== "exited") {
      killGroup(proc);
      const result = failed();
      if (outcome === "overflow") overflowed.add(result);
      return result;
    }
    // The shell has exited: the bytes collected so far stand, and a leftover stdout holder can't stall the result.
    return { exitCode: proc.signalCode ? null : proc.exitCode, stdout: concat(chunks, size) };
  } finally {
    clearTimeout(deadlineTimer);
    clearTimeout(graceTimer);
    reader.cancel().catch(() => {});
    if (proc.exitCode === null && proc.signalCode === null) killGroup(proc);
  }
};

export async function readLoginShellEnv(deps: {
  shell: string | undefined;
  run?: LoginShellRun;
  timeoutMs?: number;
  log(message: string, detail?: unknown): void;
}): Promise<Record<string, string> | null> {
  const shell = deps.shell?.startsWith("/") ? deps.shell : "/bin/zsh";
  // R-M3-T14-SHELL-1: a fresh random mark per call frames env -0's output, so rc-file stdout noise is ignored.
  const mark = `__JSLAB_ENV_${crypto.randomUUID().replaceAll("-", "")}__`;
  try {
    const result = await (deps.run ?? runLoginShell)(
      [shell, "-ilc", `printf %s ${mark}; env -0; printf %s ${mark}`],
      deps.timeoutMs ?? LOGIN_SHELL_TIMEOUT_MS,
    );
    if (result.exitCode !== 0) {
      const reason = overflowed.has(result)
        ? "output too large"
        : result.exitCode === null
          ? "timed out"
          : `exit ${result.exitCode}`;
      deps.log(strings.log.loginShellFailed(reason));
      return null;
    }
    const marked = extractMarked(new TextDecoder().decode(result.stdout), mark);
    const env = marked === null ? {} : parseEnvNul(marked);
    if (Object.keys(env).length === 0) {
      deps.log(strings.log.loginShellFailed("no output"));
      return null;
    }
    return env;
  } catch (error) {
    deps.log(strings.log.loginShellFailed(String(error)));
    return null;
  }
}

/**
 * process.env with the login shell's variables merged over it. JSLAB_* variables always come from process.env, and
 * the shell's PWD, OLDPWD, SHLVL and _ are never taken (M-2).
 */
export function mergeLoginEnv(
  processEnv: Record<string, string | undefined>,
  login: Record<string, string> | null,
): Record<string, string | undefined> {
  const merged: Record<string, string | undefined> = { ...processEnv };
  if (!login) return merged;
  for (const [key, value] of Object.entries(login)) {
    if (!key.startsWith("JSLAB_") && !SHELL_SESSION_KEYS.has(key)) merged[key] = value;
  }
  return merged;
}
