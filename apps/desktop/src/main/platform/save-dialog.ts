import { MAX_SHORT_SUBPROCESS_OUTPUT_BYTES } from "./subprocess-output";

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
  // Both streams are capped: the dialog's entire answer is one pathname, and an osascript failure is one line.
  // Without this, an `osascript` that floods either stream grows Main's heap without limit (see subprocess-output).
  const proc = Bun.spawn(["osascript", "-e", buildSaveScript(options)], {
    stdout: "pipe",
    stderr: "pipe",
    maxBuffer: MAX_SHORT_SUBPROCESS_OUTPUT_BYTES,
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code === 0) return stdout.trim();
  if (stderr.includes("-128")) return null;
  throw new Error(stderr.trim() || `osascript exited with ${code}`);
}
