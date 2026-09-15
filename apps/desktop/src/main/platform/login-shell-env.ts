import { strings } from "../strings";

/** Spec §4.6 loginShellEnv: GUI apps lack the shell PATH, so Main reads the login shell's environment once. */
export const LOGIN_SHELL_TIMEOUT_MS = 2000;

export type LoginShellRun = (
  argv: string[],
  timeoutMs: number,
) => Promise<{ exitCode: number | null; stdout: Uint8Array }>;

export function parseEnvNul(bytes: Uint8Array): Record<string, string> {
  const env: Record<string, string> = {};
  for (const entry of new TextDecoder().decode(bytes).split(String.fromCharCode(0))) {
    const eq = entry.indexOf("=");
    if (eq <= 0) continue;
    env[entry.slice(0, eq)] = entry.slice(eq + 1);
  }
  return env;
}

/** Spawns the shell in its own process group and SIGKILLs the group at the timeout (the exit code is then null). */
export const runLoginShell: LoginShellRun = async (argv, timeoutMs) => {
  const proc = Bun.spawn(argv, { stdin: "ignore", stdout: "pipe", stderr: "ignore", detached: true });
  const timer = setTimeout(() => {
    try {
      process.kill(-proc.pid, "SIGKILL");
    } catch {
      proc.kill("SIGKILL");
    }
  }, timeoutMs);
  try {
    const [stdout, exitCode] = await Promise.all([new Response(proc.stdout).arrayBuffer(), proc.exited]);
    return { exitCode: proc.signalCode ? null : exitCode, stdout: new Uint8Array(stdout) };
  } finally {
    clearTimeout(timer);
  }
};

export async function readLoginShellEnv(deps: {
  shell: string | undefined;
  run?: LoginShellRun;
  timeoutMs?: number;
  log(message: string, detail?: unknown): void;
}): Promise<Record<string, string> | null> {
  const shell = deps.shell?.startsWith("/") ? deps.shell : "/bin/zsh";
  try {
    const result = await (deps.run ?? runLoginShell)(
      [shell, "-ilc", "env -0"],
      deps.timeoutMs ?? LOGIN_SHELL_TIMEOUT_MS,
    );
    if (result.exitCode !== 0) {
      deps.log(strings.log.loginShellFailed(result.exitCode === null ? "timed out" : `exit ${result.exitCode}`));
      return null;
    }
    const env = parseEnvNul(result.stdout);
    return Object.keys(env).length > 0 ? env : null;
  } catch (error) {
    deps.log(strings.log.loginShellFailed(String(error)));
    return null;
  }
}

/** process.env with the login shell's variables merged over it; JSLAB_* variables always come from process.env. */
export function mergeLoginEnv(
  processEnv: Record<string, string | undefined>,
  login: Record<string, string> | null,
): Record<string, string | undefined> {
  const merged: Record<string, string | undefined> = { ...processEnv };
  if (!login) return merged;
  for (const [key, value] of Object.entries(login)) if (!key.startsWith("JSLAB_")) merged[key] = value;
  return merged;
}
