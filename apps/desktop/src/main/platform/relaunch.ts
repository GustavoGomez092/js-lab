import { resolve } from "node:path";

/**
 * Upstream gap: Electrobun 2.0.1 has no relaunch API. Main spawns a detached shell that waits for this instance's
 * pid to exit, then opens a new instance of the enclosing .app.
 */
export function appBundlePath(resourcesFolder: string): string | null {
  const bundle = resolve(resourcesFolder, "..", "..");
  return bundle.endsWith(".app") ? bundle : null;
}

/** Capped wait for the old process to exit (m-5): 150 polls at 0.2 s apiece, ~30 s, then it opens anyway. */
const RELAUNCH_POLL_INTERVAL_S = 0.2;
const RELAUNCH_MAX_POLLS = 150;

/**
 * Waits until `pid` (the quitting instance) is gone before opening a new one: a fixed 1 s sleep raced the up-to-2 s
 * quit flush (final review T14) and could open two instances at once (m-5). `$1`/`$2` are passed as argv, never
 * interpolated into the script.
 */
export function relaunchCommand(bundlePath: string, pid: number): string[] {
  return [
    "/bin/sh",
    "-c",
    `i=0; while kill -0 "$2" 2>/dev/null && [ "$i" -lt ${RELAUNCH_MAX_POLLS} ]; do sleep ${RELAUNCH_POLL_INTERVAL_S}; i=$((i+1)); done; /usr/bin/open -n "$1"`,
    "jslab-relaunch",
    bundlePath,
    String(pid),
  ];
}

export function relaunchApp(resourcesFolder: string, pid: number): boolean {
  const bundle = appBundlePath(resourcesFolder);
  if (!bundle) return false;
  try {
    Bun.spawn(relaunchCommand(bundle, pid), { stdin: "ignore", stdout: "ignore", stderr: "ignore" }).unref();
    return true;
  } catch {
    // A spawn failure must never stop the caller from quitting (m-6); it just reports the relaunch didn't happen.
    return false;
  }
}
