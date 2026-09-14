type Probe<T> = () => Promise<T | undefined | null | false> | T | undefined | null | false;

/** Polls `probe` until it returns something other than undefined/null/false. A throwing probe counts as "not yet". */
export async function waitFor<T>(
  probe: Probe<T>,
  options: { timeoutMs?: number; intervalMs?: number; message?: string } = {},
): Promise<T> {
  const timeoutMs = options.timeoutMs ?? 10_000;
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  for (;;) {
    try {
      const value = await probe();
      if (value !== undefined && value !== null && value !== false) return value;
    } catch (error) {
      lastError = error;
    }
    if (Date.now() >= deadline) {
      const suffix = lastError ? ` (last error: ${String(lastError)})` : "";
      throw new Error(`${options.message ?? "Condition not met"} within ${timeoutMs} ms${suffix}`);
    }
    await Bun.sleep(options.intervalMs ?? 100);
  }
}
