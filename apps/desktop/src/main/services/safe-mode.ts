export type SafeModeReason = "crashLoop" | "shift" | null;

export interface SafeModeState {
  active: boolean;
  reason: SafeModeReason;
}

/** NSEventModifierFlagShift */
export const SHIFT_MASK = 1 << 17;

/** Spawns osascript and kills it if it hasn't exited within `timeoutMs`, so a hung process is never orphaned. */
async function readModifierFlags(timeoutMs?: number): Promise<string> {
  const proc = Bun.spawn(["osascript", "-l", "JavaScript", "-e", 'ObjC.import("AppKit"); $.NSEvent.modifierFlags'], {
    stdout: "pipe",
    stderr: "ignore",
  });
  const timer = timeoutMs === undefined ? undefined : setTimeout(() => proc.kill(), timeoutMs);
  try {
    const output = await new Response(proc.stdout).text();
    await proc.exited;
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
}): Promise<SafeModeState> {
  if (input.uncleanPreviousExit) return { active: true, reason: "crashLoop" };
  if (await input.shiftHeld()) return { active: true, reason: "shift" };
  return { active: false, reason: null };
}
