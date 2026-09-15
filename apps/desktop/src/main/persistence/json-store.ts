import { copyFile, readFile } from "node:fs/promises";
import { basename } from "node:path";

export type Recovery = "none" | "backup" | "defaults";

/** What was wrong with the primary file, if anything (FA-m4): the recovery notice words a missing file differently. */
export type PrimaryFile = "ok" | "missing" | "corrupt";

export interface LoadResult<T> {
  value: T;
  recovered: Recovery;
  primary: PrimaryFile;
  /** The file name of the corrupt-file copy saved by this load, or null. */
  corruptCopy: string | null;
}

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
export async function loadJson<T>(path: string, parser: Parser<T>, fallback: () => T): Promise<LoadResult<T>> {
  const primary = await tryRead(path, parser);
  if (primary.ok) return { value: primary.value, recovered: "none", primary: "ok", corruptCopy: null };
  let corruptCopy: string | null = null;
  if (primary.reason === "corrupt") {
    const copy = `${path.replace(/\.json$/, "")}.corrupt-${Date.now()}.json`;
    corruptCopy = await copyFile(path, copy).then(
      () => basename(copy),
      () => null,
    );
  }
  const backup = await tryRead(`${path}.bak`, parser);
  if (backup.ok) return { value: backup.value, recovered: "backup", primary: primary.reason, corruptCopy };
  return {
    value: fallback(),
    recovered: primary.reason === "missing" ? "none" : "defaults",
    primary: primary.reason,
    corruptCopy,
  };
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

  const run = (): Promise<void> => {
    clearTimeout(timer);
    timer = undefined;
    const data = pending;
    pending = null;
    if (data !== null) {
      // Chain from settled promise so past failures don't block future writes
      const next = inflight.catch(() => {}).then(() => write(data));
      inflight = next;
      return next;
    }
    // No pending data: wait for any in-flight write to settle, then resolve
    return inflight.catch(() => {});
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
