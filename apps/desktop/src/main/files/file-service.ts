import { lstat, realpath, stat } from "node:fs/promises";
import { MAX_OPEN_FILE_BYTES } from "@jslab/rpc-schema";
import { baseName, contentHash } from "@jslab/shared";
import { FileTooLargeError, readBoundedBytes } from "../fs/bounded-read";
import { writeFileAtomic } from "../persistence/atomic-write";
import { strings } from "../strings";

export const OPEN_EXTENSIONS = ["js", "jsx", "ts", "tsx", "mjs", "cjs", "mts", "cts", "json", "txt"] as const;
export const LARGE_FILE_BYTES = 5 * 1024 * 1024;
/** The same limit the UI applies to dropped files; tab text is capped at MAX_TEXT_CHARS, which is larger. */
export const MAX_FILE_BYTES = MAX_OPEN_FILE_BYTES;
/** How long a large-file or Save As confirmation token stays valid. */
export const TOKEN_TTL_MS = 5 * 60_000;

export interface FileSystem {
  stat(path: string): Promise<{ size: number; isFile: boolean }>;
  /** Bounded at the *read*: refuses past `maxBytes` before allocating, never by measuring what it already read. */
  readBytes(path: string, maxBytes: number): Promise<Uint8Array>;
  write(path: string, content: string): Promise<void>;
}

export const nodeFileSystem: FileSystem = {
  stat: async (path) => {
    const info = await stat(path);
    return { size: info.size, isFile: info.isFile() };
  },
  // Not `Bun.file(path).bytes()`: that reads the whole file before the size can be judged, and cannot obtain the
  // `O_NONBLOCK` that keeps a FIFO left at the path from parking the read (R-M5b-S2).
  readBytes: (path, maxBytes) => readBoundedBytes(path, maxBytes),
  write: async (path, content) => {
    // A symlinked tab file is written through to its real target, atomically, so the link itself survives
    // (m-4): writeFileAtomic renames onto `path`, which would otherwise replace the link with a plain file.
    let target = path;
    try {
      if ((await lstat(path)).isSymbolicLink()) target = await realpath(path);
    } catch {
      // Nothing at `path` yet (ENOENT), or it isn't a symlink: write it as given.
    }
    await writeFileAtomic(target, content);
  },
};

export interface ReadyFile {
  path: string;
  content: string;
}

export interface PendingSaveAs {
  tabId: string;
  path: string;
  content: string;
}

export function isProbablyText(bytes: Uint8Array): boolean {
  const end = Math.min(bytes.length, 8192);
  for (let index = 0; index < end; index++) if (bytes[index] === 0) return false;
  return true;
}

// fatal: an undecodable byte sequence (e.g. Latin-1 text) is rejected outright rather than silently replaced
// with U+FFFD (m-5). ignoreBOM: a leading BOM decodes to U+FEFF instead of being stripped, so saving the
// content back reproduces the exact same bytes.
const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/** File reads and writes for tabs (spec §10.2). Paths only ever come from Main's own dialogs or tokens. */
export class FileService {
  readonly #largeTokens = new Map<string, { path: string; size: number; expiresAt: number }>();
  readonly #saveAsTokens = new Map<string, PendingSaveAs & { expiresAt: number }>();
  readonly #now: () => number;
  readonly #maxFileBytes: number;
  readonly #largeFileBytes: number;

  constructor(
    private readonly fs: FileSystem,
    options: { now?: () => number; maxFileBytes?: number; largeFileBytes?: number } = {},
  ) {
    this.#now = options.now ?? Date.now;
    this.#maxFileBytes = options.maxFileBytes ?? MAX_FILE_BYTES;
    this.#largeFileBytes = options.largeFileBytes ?? LARGE_FILE_BYTES;
  }

  async prepareOpen(paths: string[]) {
    const ready: ReadyFile[] = [];
    const large: { token: string; path: string; size: number }[] = [];
    const errors: string[] = [];
    for (const path of paths) {
      const name = baseName(path);
      let size: number;
      try {
        const info = await this.fs.stat(path);
        if (!info.isFile) throw new Error("not a file");
        size = info.size;
      } catch {
        errors.push(strings.files.unreadable(name));
        continue;
      }
      if (size > this.#maxFileBytes) {
        errors.push(strings.files.tooLarge(name));
      } else if (size > this.#largeFileBytes) {
        this.#sweepExpired();
        const token = crypto.randomUUID();
        this.#largeTokens.set(token, { path, size, expiresAt: this.#now() + TOKEN_TTL_MS });
        large.push({ token, path, size });
      } else {
        const file = await this.#read(path, name);
        if ("error" in file) errors.push(file.error);
        else ready.push(file);
      }
    }
    return { ready, large, errors };
  }

  async confirmLarge(tokens: string[]): Promise<{ ready: ReadyFile[]; errors: string[] }> {
    this.#sweepExpired();
    const ready: ReadyFile[] = [];
    const errors: string[] = [];
    for (const token of tokens) {
      const entry = this.#largeTokens.get(token);
      this.#largeTokens.delete(token);
      if (!entry || entry.expiresAt < this.#now()) {
        if (!errors.includes(strings.files.expired)) errors.push(strings.files.expired);
        continue;
      }
      const file = await this.#read(entry.path, baseName(entry.path));
      if ("error" in file) errors.push(file.error);
      else ready.push(file);
    }
    return { ready, errors };
  }

  async write(path: string, content: string): Promise<string> {
    await this.fs.write(path, content);
    return contentHash(content);
  }

  issueSaveAsToken(pending: PendingSaveAs): string {
    this.#sweepExpired();
    const token = crypto.randomUUID();
    this.#saveAsTokens.set(token, { ...pending, expiresAt: this.#now() + TOKEN_TTL_MS });
    return token;
  }

  takeSaveAsToken(token: string): PendingSaveAs | null {
    this.#sweepExpired();
    const entry = this.#saveAsTokens.get(token) ?? null;
    this.#saveAsTokens.delete(token);
    if (!entry || entry.expiresAt < this.#now()) return null;
    const { expiresAt: _expiresAt, ...pending } = entry;
    return pending;
  }

  /** Drops expired large-file and Save As tokens whenever one is issued or used (m-1). */
  #sweepExpired(): void {
    const now = this.#now();
    for (const [token, entry] of this.#largeTokens) if (entry.expiresAt < now) this.#largeTokens.delete(token);
    for (const [token, entry] of this.#saveAsTokens) if (entry.expiresAt < now) this.#saveAsTokens.delete(token);
  }

  async #read(path: string, name: string): Promise<ReadyFile | { error: string }> {
    let bytes: Uint8Array;
    try {
      bytes = await this.fs.readBytes(path, this.#maxFileBytes);
    } catch (error) {
      // Still enforced at the read and not only at the initial stat -- a file can grow, or be swapped for a FIFO
      // or a symlink, during the large-file token's 5-minute window, or between stat and read even on the small
      // file path (I-1). What changed is *when*: the limit is applied from the opened handle's `fstat`, before
      // the allocation, rather than by measuring bytes that are already in Main's heap. The initial `stat` above
      // stays, because it is what decides whether to prompt -- it is not what makes the read safe.
      return {
        error: error instanceof FileTooLargeError ? strings.files.tooLarge(name) : strings.files.unreadable(name),
      };
    }
    if (!isProbablyText(bytes)) return { error: strings.files.notText(name) };
    try {
      return { path, content: decoder.decode(bytes) };
    } catch {
      // fatal:true threw: the bytes aren't valid UTF-8 (e.g. Latin-1 text) (m-5).
      return { error: strings.files.notText(name) };
    }
  }
}
