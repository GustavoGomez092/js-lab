import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";
import { open } from "node:fs/promises";
import { MAX_NPMRC_CHARS, MAX_OPEN_FILE_BYTES, MAX_TEXT_CHARS } from "@jslab/rpc-schema";

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

/**
 * UTF-8 spends at most three bytes per UTF-16 code unit (a surrogate pair is two units and four bytes, so the
 * per-unit worst case stays three). Every cap below that starts life as a *character* limit is converted with
 * this rather than by picking a byte number that reads plausibly: a constant nothing derives is exactly the
 * defect this module exists to remove.
 */
const utf8BytesFor = (chars: number): number => chars * 3;

/**
 * JSLab's own files: `settings.json`, `session.json` (and their `.bak`s), `env.json`, `keybindings.json`, the
 * per-tab buffers, the font cache, the E2E dialog answers, `packages.json` and `bun.lock`.
 *
 * Derived, not chosen. Every one of these is written only by `persistence/atomic-write.ts`, from a value that
 * already passed its zod schema at the RPC boundary, and the largest text any of those schemas admits is
 * `MAX_TEXT_CHARS` UTF-16 units (`@jslab/rpc-schema`: the one cap `buffer.changed`, `run.start`, `tab.create`
 * and `file.save` all validate against). So nothing JSLab itself can have written to one of these paths exceeds
 * `utf8BytesFor(MAX_TEXT_CHARS)`, and anything bigger was not written by JSLab.
 *
 * It is a loose bound for `keybindings.json` and a tight one for a tab buffer. That is the honest shape: the cap's
 * job here is to make the read refusable and non-blocking, not to guess each file's typical size.
 */
export const MAX_STATE_FILE_BYTES = utf8BytesFor(MAX_TEXT_CHARS);

/**
 * A source file Main reads while bundling -- an importer it quotes in a code frame, or a `.css` it inlines.
 * `MAX_OPEN_FILE_BYTES` is the product's own ceiling on a file JSLab will open at all (spec §10.2), so a source
 * file past it cannot have come from a JSLab tab.
 */
export const MAX_SOURCE_FILE_BYTES = MAX_OPEN_FILE_BYTES;

/**
 * `<packages>/.npmrc`. `npmrc.save` refuses content over `MAX_NPMRC_CHARS` (`npmrcSaveParamsSchema`), so that is
 * the largest `.npmrc` JSLab will ever write; the byte bound is that character limit converted.
 */
export const MAX_NPMRC_BYTES = utf8BytesFor(MAX_NPMRC_CHARS);

/**
 * A file under `node_modules` that Main reads and parses -- a `package.json` manifest, or a `.d.ts`.
 *
 * This is the number `services/types-service.ts` already refused a declaration file at before reading it
 * (R-M3-T13-FIX-3 N1); it moved here so the manifest reads and the declaration reads share one constant instead
 * of two copies of the same literal drifting apart.
 */
export const MAX_NODE_MODULES_FILE_BYTES = 5 * 1024 * 1024;

/** The bytes of a regular file at most `maxBytes` long. The one place the refusal order is decided. */
export async function readBoundedBytes(path: string, maxBytes: number): Promise<Buffer> {
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
    return buffer.subarray(0, read);
  } finally {
    try {
      await handle.close();
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
 * The synchronous twin, for the handful of Main call sites that cannot be made async: `Bun.build`'s `onResolve`
 * callbacks (`../bundling/resolve-plugin.ts`, `../bundling/polyfill-plugin.ts`) reach these through deep sync
 * helpers, and `RotatingLog.tail` is sync by contract.
 *
 * Deliberately the same algorithm in the same file rather than a second module: the check order is the whole
 * point, and two copies of it in two places is how one of them ends up reversed. If anything, these sites need it
 * *more* than the async ones -- `readFileSync` on a FIFO blocks Main's thread itself, where the async reads only
 * park one threadpool slot.
 */
export function readBoundedTextSync(path: string, maxBytes: number): string {
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
    return buffer.subarray(0, read).toString("utf8");
  } finally {
    try {
      closeSync(fd);
    } catch {
      // Closing failed (EIO/EBADF); the read above already produced its result or threw.
    }
  }
}
