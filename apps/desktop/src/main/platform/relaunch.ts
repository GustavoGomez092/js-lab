import { resolve } from "node:path";

/**
 * Upstream gap: Electrobun 2.0.1 has no relaunch API. Main spawns a detached shell that waits 1 s, which lets
 * this instance quit, then opens a new instance of the enclosing .app.
 */
export function appBundlePath(resourcesFolder: string): string | null {
  const bundle = resolve(resourcesFolder, "..", "..");
  return bundle.endsWith(".app") ? bundle : null;
}

/** The bundle path is passed as $1, never interpolated into the script. */
export function relaunchCommand(bundlePath: string): string[] {
  return ["/bin/sh", "-c", 'sleep 1; /usr/bin/open -n "$1"', "jslab-relaunch", bundlePath];
}

export function relaunchApp(resourcesFolder: string): boolean {
  const bundle = appBundlePath(resourcesFolder);
  if (!bundle) return false;
  Bun.spawn(relaunchCommand(bundle), { stdin: "ignore", stdout: "ignore", stderr: "ignore" }).unref();
  return true;
}
