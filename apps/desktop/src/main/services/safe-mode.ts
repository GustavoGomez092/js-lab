import { existsSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { MAX_SHORT_SUBPROCESS_OUTPUT_BYTES } from "../platform/subprocess-output";

export type SafeModeReason = "crashLoop" | "manual" | "shift" | null;

export interface SafeModeState {
  active: boolean;
  reason: SafeModeReason;
}

/** NSEventModifierFlagShift */
export const SHIFT_MASK = 1 << 17;

/**
 * Spawns osascript and kills it if it hasn't exited within `timeoutMs`, so a hung process is never orphaned.
 * Exported for the output-cap test: called directly, with no `timeoutMs`, only `maxBuffer` can end a flooding
 * child, so the test measures the cap itself rather than isShiftHeld's kill timer.
 */
export async function readModifierFlags(timeoutMs?: number): Promise<string> {
  const proc = Bun.spawn(["osascript", "-l", "JavaScript", "-e", 'ObjC.import("AppKit"); $.NSEvent.modifierFlags'], {
    stdout: "pipe",
    stderr: "ignore",
    // The whole legitimate answer is a decimal integer; the kill timer below bounds time, not bytes.
    maxBuffer: MAX_SHORT_SUBPROCESS_OUTPUT_BYTES,
  });
  const timer = timeoutMs === undefined ? undefined : setTimeout(() => proc.kill(), timeoutMs);
  try {
    const output = await new Response(proc.stdout).text();
    const code = await proc.exited;
    // Previously the exit code was awaited and discarded, so a truncated read parsed as if it were the real
    // answer. It matters now: hitting maxBuffer kills osascript, and the partial digits left behind could parse
    // to a number with the Shift bit set. isShiftHeld() turns this throw into `false`, which is the safe answer.
    if (code !== 0) throw new Error(`osascript exited with ${code}`);
    return output;
  } finally {
    clearTimeout(timer);
  }
}

/** True when Shift is held right now. Never throws; gives up after `timeoutMs`. */
export async function isShiftHeld(
  read: (timeoutMs?: number) => Promise<string> = readModifierFlags,
  timeoutMs = 1000,
): Promise<boolean> {
  try {
    const output = await Promise.race([
      read(timeoutMs),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timeout")), timeoutMs)),
    ]);
    const flags = Number.parseInt(output.trim(), 10);
    return Number.isFinite(flags) && (flags & SHIFT_MASK) !== 0;
  } catch {
    return false;
  }
}

export async function detectSafeMode(input: {
  uncleanPreviousExit: boolean;
  shiftHeld: () => Promise<boolean>;
  manualRequested?: boolean;
}): Promise<SafeModeState> {
  if (input.uncleanPreviousExit) return { active: true, reason: "crashLoop" };
  if (input.manualRequested) return { active: true, reason: "manual" };
  if (await input.shiftHeld()) return { active: true, reason: "shift" };
  return { active: false, reason: null };
}

/** Help → Restart in Safe Mode leaves this flag for the next launch (spec §5.14). */
export const SAFE_MODE_FLAG = "safe-mode.next";

export function requestSafeModeOnNextLaunch(dataDir: string): void {
  writeFileSync(join(dataDir, SAFE_MODE_FLAG), String(Date.now()));
}

export function consumeSafeModeFlag(dataDir: string): boolean {
  const path = join(dataDir, SAFE_MODE_FLAG);
  if (!existsSync(path)) return false;
  rmSync(path, { force: true });
  return true;
}
