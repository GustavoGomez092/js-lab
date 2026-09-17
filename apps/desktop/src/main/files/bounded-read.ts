import { constants } from "node:fs";
import { open } from "node:fs/promises";

/**
 * A bounded file reader for Main -- deliberately local, and deliberately small.
 *
 * COLLAPSE ME: `fix/bounded-reads` introduces the shared `apps/desktop/src/main/fs/bounded-read.ts`, whose
 * `readBoundedText` and error classes are a superset of these and carry the same names on purpose. When that
 * branch merges, delete this file and re-point `rpc/snippet-handlers.ts` and `index.ts` at the shared module --
 * the swap is an import change and nothing else. This lives in `files/` rather than `fs/` so the two files cannot
 * collide: a merge conflict here would be resolved in a hurry, and losing either reader is worse than briefly
 * having two.
 *
 * Two properties are load-bearing, and both are easy to reinvent incorrectly:
 *
 * 1. The size comes from `fstat` on the **opened handle**, and is refused *before* `Buffer.alloc`. Reading first
 *    and measuring afterwards bounds the *parse*, not the read: the file is already in Main's heap by the time
 *    the check runs, which is the entire hazard. Stat'ing the *path* instead of the handle reintroduces it in
 *    another form -- the path can be swapped for a FIFO, a symlink, or a larger file between check and open.
 * 2. `O_RDONLY | O_NONBLOCK`. This is what makes a FIFO at the path fail instead of blocking Main forever waiting
 *    for a writer. `Bun.file(path).text()` cannot obtain it, so no fix that keeps that call can close the hang.
 *
 * The buffer is allocated at exactly the fstat'd size and never grown, so the cap holds even against a file that
 * grows mid-read; a file that shrinks yields a short read, and only the bytes actually read are returned.
 */

/** Thrown instead of allocating, so a caller can report the real reason and the size rather than blaming I/O. */
export class FileTooLargeError extends Error {
  readonly path: string;
  readonly size: number;
  readonly maxBytes: number;
  /** An errno-style code, so the refusal survives the same `.code` check a caller already applies to fs errors. */
  readonly code = "EFBIG";

  constructor(path: string, size: number, maxBytes: number) {
    super(`EFBIG: ${path} is ${size} bytes, over the ${maxBytes}-byte limit`);
    this.name = "FileTooLargeError";
    this.path = path;
    this.size = size;
    this.maxBytes = maxBytes;
  }
}

/** A FIFO, directory, device or socket at the path: refused rather than read -- this is the FIFO hang's exit. */
export class NotARegularFileError extends Error {
  readonly path: string;
  /** No POSIX errno means "refused for not being a regular file", so this token is JSLab's own. */
  readonly code = "ENOTREGULAR";

  constructor(path: string) {
    super(`ENOTREGULAR: ${path} is not a regular file`);
    this.name = "NotARegularFileError";
    this.path = path;
  }
}

/** The UTF-8 text of a regular file at most `maxBytes` long. Throws for the caller to classify. */
export async function readBoundedText(path: string, maxBytes: number): Promise<string> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
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
    return buffer.subarray(0, read).toString("utf8");
  } finally {
    try {
      await handle.close();
    } catch {
      // Closing failed (EIO/EBADF); the read above already produced its result or threw.
    }
  }
}
