import { strings } from "./strings";

export const QUIT_FLUSH_TIMEOUT_MS = 2000;

/**
 * Waits for the session flush, but never longer than `timeoutMs`: a hung disk write must not keep JSLab from
 * quitting (final review T14). Failures and timeouts are logged.
 */
export async function flushBeforeQuit(
  flush: () => Promise<void>,
  log: (message: string, detail?: unknown) => void,
  timeoutMs = QUIT_FLUSH_TIMEOUT_MS,
): Promise<"flushed" | "failed" | "timedOut"> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<"timedOut">((resolve) => {
    timer = setTimeout(() => resolve("timedOut"), timeoutMs);
  });
  const flushed = flush().then(
    () => "flushed" as const,
    (error: unknown) => {
      log(strings.log.quitFlushFailed, error);
      return "failed" as const;
    },
  );
  const result = await Promise.race([flushed, timedOut]);
  clearTimeout(timer);
  if (result === "timedOut") log(strings.log.quitFlushTimedOut(timeoutMs));
  return result;
}
