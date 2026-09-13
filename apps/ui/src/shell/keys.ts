import type { CommandId } from "@jslab/rpc-schema";

export interface KeyLike {
  code: string;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
}

/**
 * M1 shortcuts (spec §6.5). Uses `code` rather than `key` because Option changes the produced character on macOS.
 * The full command registry and user keybindings arrive in M2.
 */
export function commandForKey(event: KeyLike): CommandId | null {
  const primary = event.metaKey && !event.ctrlKey;
  if (!primary) return null;
  if (event.code === "KeyR" && event.altKey && !event.shiftKey) return "run.kill";
  if (event.code === "KeyR" && event.shiftKey && !event.altKey) return "run.stop";
  if (event.code === "KeyR" && !event.shiftKey && !event.altKey) return "run.start";
  if (event.code === "KeyK" && !event.shiftKey && !event.altKey) return "output.clear";
  return null;
}
