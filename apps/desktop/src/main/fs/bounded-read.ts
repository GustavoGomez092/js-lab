import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";
import { open } from "node:fs/promises";

/**
 * One bounded file reader for Main, promoted from the three copies that were written locally and never shared
 * (`services/types-service.ts`'s `nodeTypesFs.readText`, `runs/runner-config.ts`'s `readTextSync`, and the
 * stat/check/read/re-check shape in `files/file-service.ts`). Every new feature that reached for a bare
 * `readFile`/`Bun.file(path).text()` instead re-introduced the same defect: the size limit enforced *after* the
 * allocation it was supposed to guard.
 *
 * Two properties are load-bearing, and both are easy to reinvent incorrectly:
 *
 * 1. `O_NONBLOCK` — this is what makes a FIFO at the path *fail* instead of blocking Main forever waiting for a
 *    writer. `Bun.file(path).text()` has no way to obtain it, so any "fix" that keeps that call cannot close the
 *    hang. It has no effect on reads of regular files.
 * 2. fstat **the handle that will actually be read**, never the path. Checking the path and then opening it is a
 *    TOCTOU window: the path can be swapped to a symlink, a FIFO, or a much larger file in between.
 *
 * The buffer is allocated at exactly the fstat'd size and never grown, so the cap also holds against a file that
 * grows mid-read (the case `file-service.ts` re-checks for after the fact): only `size` bytes are ever read, no
 * matter how large the file becomes. A file that shrinks mid-read yields a short read, and only the bytes actually
 * read are returned.
 */

/** Thrown instead of allocating, so the caller can report the real reason and the size rather than blaming I/O. */
export class FileTooLargeError extends Error {
  readonly path: string;
  readonly size: number;
  readonly maxBytes: number;
  /**
   * An errno-style code, so this refusal is distinguishable through the same `.code` check callers already apply
   * to an fs error, and so the *leading token* of `message` identifies it. Settings shows only that leading code
   * and never the raw message (an fs message can carry an absolute path), which is what lets an oversized `.npmrc`
   * be told apart from a permission-denied one. `EFBIG` is the genuine POSIX errno for "file too large".
   */
  readonly code = "EFBIG";

  constructor(path: string, size: number, maxBytes: number) {
    super(`EFBIG: ${path} is ${size} bytes, over the ${maxBytes}-byte limit`);
    this.name = "FileTooLargeError";
    this.path = path;
    this.size = size;
    this.maxBytes = maxBytes;
  }
}

/** A FIFO, directory, device or socket at the path: refused rather than read (this is the FIFO hang's exit). */
export class NotARegularFileError extends Error {
  readonly path: string;
  /**
   * As `FileTooLargeError.code`. No POSIX errno means "refused because it is not a regular file" -- opening a FIFO
   * is not itself an error -- so this one is a JSLab token rather than a real errno.
   */
  readonly code = "ENOTREGULAR";

  constructor(path: string) {
    super(`ENOTREGULAR: ${path} is not a regular file`);
    this.name = "NotARegularFileError";
    this.path = path;
  }
}

/**
 * A third party's `package.json` — anything under `node_modules`, written by whatever the registry served. The
 * same 5 MB bound `types-service.ts` already applies to the identical path; no real manifest approaches it.
 */
export const MAX_PACKAGE_JSON_BYTES = 5 * 1024 * 1024;

/**
 * The largest number that can still be a byte cap.
 *
 * A cap is only a cap if refusing at it is a real refusal. The largest genuine cap in this tree is
 * `MAX_OPEN_FILE_BYTES` (50 MB); this sits well above that and far below any allocation Main could survive, so a
 * finite `maxBytes` beyond it is not a bound at all — it is a WAIVER wearing a number's clothes.
 * `readBoundedText(p, Number.MAX_SAFE_INTEGER)` is a complete waiver of roughly 9 PB.
 *
 * This exists because `test/fs/no-unbounded-reads.test.ts` cannot close that spelling and should not pretend to:
 * it matches text, and no pattern can recognise an arbitrary large literal as "not really a cap". The gate matches
 * the `Infinity` / `POSITIVE_INFINITY` spellings, and this refuses every other one, so between them "any read with
 * no meaningful byte cap, however it is spelled" is true rather than merely claimed. `POSITIVE_INFINITY` is
 * deliberately still allowed through: it is the one spelling the gate CAN see, which is exactly why it must be the
 * one that reaches a read and carries a recorded reason there.
 */
export const MAX_MEANINGFUL_CAP_BYTES = 1024 * 1024 * 1024;

/**
 * Refuses a `maxBytes` that is not a bound. A `RangeError` rather than one of the classes above, because this is a
 * mistake in the caller and not a fact about the file — which is also why the or-null readers check it *before*
 * their `catch`, instead of collapsing a caller's bug into "this file is unreadable".
 */
function assertRealCap(path: string, maxBytes: number): void {
  if (Number.isFinite(maxBytes) && maxBytes > MAX_MEANINGFUL_CAP_BYTES) {
    throw new RangeError(
      `ERANGE: ${maxBytes} is not a byte cap (the limit is ${MAX_MEANINGFUL_CAP_BYTES}); if the read genuinely cannot be bounded, use readRegularFileText and record the waiver: ${path}`,
    );
  }
}

/** The bytes of a regular file at most `maxBytes` long. Throws `FileTooLargeError` / `NotARegularFileError`. */
export async function readBoundedBytes(path: string, maxBytes: number): Promise<Buffer> {
  assertRealCap(path, maxBytes);
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
    const info = await handle.stat();
    if (!info.isFile()) throw new NotARegularFileError(path);
    if (info.size > maxBytes) throw new FileTooLargeError(path, info.size, maxBytes);
    const buffer = Buffer.alloc(info.size);
    let read = 0;
    while (read < buffer.length) {
      const { bytesRead } = await handle.read(buffer, read, buffer.length - read, read);
      if (bytesRead === 0) break;
      read += bytesRead;
    }
    return buffer.subarray(0, read);
  } finally {
    try {
      await handle?.close();
    } catch {
      // Closing failed (EIO/EBADF); the read above already produced its result or threw.
    }
  }
}

/** The UTF-8 text of a regular file at most `maxBytes` long. Throws for the caller to classify. */
export async function readBoundedText(path: string, maxBytes: number): Promise<string> {
  return (await readBoundedBytes(path, maxBytes)).toString("utf8");
}

/**
 * The UTF-8 text of a regular file of **any** size. The byte cap is deliberately absent, for the one case where no
 * useful bound exists (a stylesheet being bundled: a cap would refuse a legitimately large one). "Unbounded" must
 * not also mean "unchecked", which is the confusion this function exists to prevent — the `O_NONBLOCK` open and the
 * `isFile` check on the opened handle still apply, so a FIFO at the path is refused instead of parking the caller
 * forever. Prefer `readBoundedText` unless a cap genuinely cannot be chosen.
 */
export async function readRegularFileText(path: string): Promise<string> {
  return readBoundedText(path, Number.POSITIVE_INFINITY);
}

/**
 * The best-effort form: null for *any* failure — missing, oversized, a FIFO, unreadable. Use it only where the
 * caller genuinely cannot tell those apart; where "missing" and "broken" must differ, use `readBoundedText` and
 * classify the error.
 */
export async function readBoundedTextOrNull(path: string, maxBytes: number): Promise<string | null> {
  // Outside the try on purpose: a cap that is not a cap is the caller's bug, and must not become a `null` that
  // reads as "that file was unreadable".
  assertRealCap(path, maxBytes);
  try {
    return await readBoundedText(path, maxBytes);
  } catch {
    return null;
  }
}

/** `readBoundedBytes`, synchronously — for callers that cannot await (Bun plugin hooks, run preparation). */
export function readBoundedBytesSync(path: string, maxBytes: number): Buffer {
  assertRealCap(path, maxBytes);
  const fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const info = fstatSync(fd);
    if (!info.isFile()) throw new NotARegularFileError(path);
    if (info.size > maxBytes) throw new FileTooLargeError(path, info.size, maxBytes);
    const buffer = Buffer.alloc(info.size);
    let read = 0;
    while (read < buffer.length) {
      const bytesRead = readSync(fd, buffer, read, buffer.length - read, read);
      if (bytesRead === 0) break;
      read += bytesRead;
    }
    return buffer.subarray(0, read);
  } finally {
    try {
      closeSync(fd);
    } catch {
      // Closing failed; the result above stands.
    }
  }
}

/** `readBoundedText`, synchronously. */
export function readBoundedTextSync(path: string, maxBytes: number): string {
  return readBoundedBytesSync(path, maxBytes).toString("utf8");
}

/**
 * `readRegularFileText`, synchronously — for the size-waiving callers that cannot await (Bun plugin hooks).
 *
 * The same warning applies as to the async twin, and more sharply: "unbounded" is a statement about the *size*
 * only. The `O_NONBLOCK` open and the `isFile` check on the opened handle still apply, so a FIFO at the path is
 * refused instead of parking Main's loop forever. Prefer `readBoundedTextSync` unless a cap genuinely cannot be
 * chosen.
 */
export function readRegularFileTextSync(path: string): string {
  return readBoundedTextSync(path, Number.POSITIVE_INFINITY);
}

/** `readBoundedTextOrNull`, synchronously. */
export function readBoundedTextSyncOrNull(path: string, maxBytes: number): string | null {
  // Outside the try, as in the async twin above.
  assertRealCap(path, maxBytes);
  try {
    return readBoundedTextSync(path, maxBytes);
  } catch {
    return null;
  }
}
