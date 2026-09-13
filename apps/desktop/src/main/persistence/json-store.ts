import { copyFile, readFile } from "node:fs/promises";

export type Recovery = "none" | "backup" | "defaults";

/** Anything with a zod-compatible `parse` that throws on invalid input. */
export interface Parser<T> {
  parse(input: unknown): T;
}

type ReadResult<T> = { ok: true; value: T } | { ok: false; reason: "missing" | "corrupt" };

async function tryRead<T>(path: string, parser: Parser<T>): Promise<ReadResult<T>> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    return { ok: false, reason: (error as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "corrupt" };
  }
  try {
    return { ok: true, value: parser.parse(JSON.parse(text)) };
  } catch {
    return { ok: false, reason: "corrupt" };
  }
}

/**
 * Loads a JSON file, falling back to `<path>.bak` and then to defaults.
 * A corrupt primary file is preserved as `<name>.corrupt-<timestamp>.json` for diagnosis.
 */
export async function loadJson<T>(
  path: string,
  parser: Parser<T>,
  fallback: () => T,
): Promise<{ value: T; recovered: Recovery }> {
  const primary = await tryRead(path, parser);
  if (primary.ok) return { value: primary.value, recovered: "none" };
  if (primary.reason === "corrupt") {
    await copyFile(path, `${path.replace(/\.json$/, "")}.corrupt-${Date.now()}.json`).catch(() => {});
  }
  const backup = await tryRead(`${path}.bak`, parser);
  if (backup.ok) return { value: backup.value, recovered: "backup" };
  return { value: fallback(), recovered: primary.reason === "missing" ? "none" : "defaults" };
}

export interface DebouncedWriter {
  schedule(data: string): void;
  flush(): Promise<void>;
}

/** Coalesces rapid writes; writes run sequentially and `flush` resolves after the last one lands. */
export function createDebouncedWriter(
  write: (data: string) => Promise<void>,
  delayMs = 500,
  onError: (error: unknown) => void = (error) => console.error("[jslab] persistence write failed", error),
): DebouncedWriter {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let pending: string | null = null;
  let inflight: Promise<void> = Promise.resolve();
  let lastFlushPromise: Promise<void> = Promise.resolve();

  const run = (): Promise<void> => {
    clearTimeout(timer);
    timer = undefined;
    const data = pending;
    pending = null;
    if (data !== null) {
      // Chain from settled promise so past failures don't block future writes
      const next = inflight.catch(() => {}).then(() => write(data));
      inflight = next;
      lastFlushPromise = next;
    }
    return lastFlushPromise;
  };

  return {
    schedule(data) {
      pending = data;
      clearTimeout(timer);
      timer = setTimeout(() => {
        run().catch(onError);
      }, delayMs);
    },
    flush: run,
  };
}
