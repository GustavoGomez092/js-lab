/**
 * PID-based process control for launched apps (R-M1-8). Only PIDs the harness spawned, their descendants, and the
 * Main PID the app reports are ever signalled. Nothing here matches processes by name or path.
 */
export function childPids(pid: number): number[] {
  const result = Bun.spawnSync(["pgrep", "-P", String(pid)]);
  if (result.exitCode !== 0) return [];
  return result.stdout
    .toString()
    .split("\n")
    .map((line) => Number(line.trim()))
    .filter((child) => Number.isInteger(child) && child > 0);
}

/** `pid` and every descendant, parents first. `childrenOf` is injectable for tests. */
export function processTree(pid: number, childrenOf: (pid: number) => number[] = childPids): number[] {
  const seen = new Set<number>();
  const queue = [pid];
  while (queue.length > 0) {
    const next = queue.shift() as number;
    if (seen.has(next)) continue;
    seen.add(next);
    queue.push(...childrenOf(next));
  }
  return [...seen];
}

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** The full command line of one PID (empty when it no longer exists). */
export function processCommand(pid: number): string {
  return Bun.spawnSync(["ps", "-o", "command=", "-p", String(pid)])
    .stdout.toString()
    .trim();
}
