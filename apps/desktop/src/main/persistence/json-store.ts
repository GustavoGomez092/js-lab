import { copyFile } from "node:fs/promises";
import { basename } from "node:path";
import { readBoundedText } from "../fs/bounded-read";

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

async function tryRead<T>(path: string, parser: Parser<T>, maxBytes: number): Promise<ReadResult<T>> {
  let text: string;
  try {
    text = await readBoundedText(path, maxBytes);
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
 *
 * `maxBytes` is required, and deliberately has no default: this helper is shared by settings.json (whose every
 * field is a bounded scalar, so it carries a real cap) and session.json (which grows with the user's tab count, so
 * it waives one). A default would be exactly the unstated bound this reader exists to remove -- whichever number
 * was chosen would be wrong for one of the two callers, silently.
 *
 * Both hazards are now answered here rather than assumed away by "JSLab wrote this file". JSLab's data dir is
 * user-writable, so the file may not be a regular file at read time whoever wrote it last: `readBoundedText` opens
 * `O_NONBLOCK` and fstats the handle it will read, so a FIFO at `path` is refused instead of parking Main forever.
 * Such a refusal is reported as "corrupt" rather than "missing", which is the accurate half of the distinction --
 * the file is present and unusable -- and it routes into the existing recovery: the `.bak`, then defaults, then a
 * rewrite that renames a regular file over the FIFO, so the profile heals itself on the next launch.
 *
 * The corrupt-file preservation below is safe against the same hazard, which was measured rather than assumed:
 * `copyFile` on a FIFO fails fast with ENOTSUP instead of blocking, so it cannot re-open the hang one line later.
 */
export async function loadJson<T>(
  path: string,
  parser: Parser<T>,
  fallback: () => T,
  maxBytes: number,
): Promise<LoadResult<T>> {
  const primary = await tryRead(path, parser, maxBytes);
  if (primary.ok) return { value: primary.value, recovered: "none", primary: "ok", corruptCopy: null };
  let corruptCopy: string | null = null;
  if (primary.reason === "corrupt") {
    const copy = `${path.replace(/\.json$/, "")}.corrupt-${Date.now()}.json`;
    corruptCopy = await copyFile(path, copy).then(
      () => basename(copy),
      () => null,
    );
  }
  // The backup holds the same kind of file as the primary, so it answers to the same cap -- and to the same
  // non-regular refusal, which matters because settings.json.bak is read exactly when settings.json failed.
  const backup = await tryRead(`${path}.bak`, parser, maxBytes);
  if (backup.ok) return { value: backup.value, recovered: "backup", primary: primary.reason, corruptCopy };
  return {
    value: fallback(),
    recovered: primary.reason === "missing" ? "none" : "defaults",
    primary: primary.reason,
    corruptCopy,
  };
}

/** What a writer writes: the text itself, or a function that builds it when the write starts (FA-m9). */
export type WriteData = string | (() => string);

export interface DebouncedWriter {
  schedule(data: WriteData): void;
  flush(): Promise<void>;
}

/**
 * Coalesces rapid writes; writes run sequentially and `flush` resolves after the last one lands. A scheduled function
 * is called once, when its write starts, so the newest state is written and nothing is serialized per change.
 */
export function createDebouncedWriter(
  write: (data: string) => Promise<void>,
  delayMs = 500,
  onError: (error: unknown) => void = (error) => console.error("[jslab] persistence write failed", error),
): DebouncedWriter {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let pending: WriteData | null = null;
  let inflight: Promise<void> = Promise.resolve();

  const run = (): Promise<void> => {
    clearTimeout(timer);
    timer = undefined;
    const scheduled = pending;
    pending = null;
    if (scheduled !== null) {
      // Chain from the settled promise so past failures don't block future writes.
      const next = inflight
        .catch(() => {})
        .then(() => write(typeof scheduled === "function" ? scheduled() : scheduled));
      inflight = next;
      return next;
    }
    // No pending data: wait for any in-flight write to settle, then resolve.
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
