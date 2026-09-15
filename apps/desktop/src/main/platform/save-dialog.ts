/**
 * Upstream gap: Electrobun has no save dialog (#233). This `osascript choose file name` adapter was adopted
 * provisionally in M0-S6. Its result must not be trusted when it equals the default path (see file-handlers).
 */
const quote = (value: string) => `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;

export function buildSaveScript(options: { defaultName: string; defaultDir?: string }): string {
  const location = options.defaultDir ? ` default location (POSIX file ${quote(options.defaultDir)})` : "";
  return `POSIX path of (choose file name with prompt "Save As" default name ${quote(options.defaultName)}${location})`;
}

/** Resolves the chosen path, or null when the user cancels (AppleScript error -128). */
export async function saveDialog(options: { defaultName: string; defaultDir?: string }): Promise<string | null> {
  const proc = Bun.spawn(["osascript", "-e", buildSaveScript(options)], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code === 0) return stdout.trim();
  if (stderr.includes("-128")) return null;
  throw new Error(stderr.trim() || `osascript exited with ${code}`);
}
