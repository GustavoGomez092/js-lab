import { stat } from "node:fs/promises";
import { MAX_OPEN_FILE_BYTES } from "@jslab/rpc-schema";
import { baseName, contentHash } from "@jslab/shared";
import { writeFileAtomic } from "../persistence/atomic-write";
import { strings } from "../strings";

export const OPEN_EXTENSIONS = ["js", "jsx", "ts", "tsx", "mjs", "cjs", "mts", "cts", "json", "txt"] as const;
export const LARGE_FILE_BYTES = 5 * 1024 * 1024;
/** The same limit the UI applies to dropped files; tab text is capped at MAX_TEXT_CHARS, which is larger. */
export const MAX_FILE_BYTES = MAX_OPEN_FILE_BYTES;
const TOKEN_TTL_MS = 5 * 60_000;

export interface FileSystem {
  stat(path: string): Promise<{ size: number; isFile: boolean }>;
  readBytes(path: string): Promise<Uint8Array>;
  write(path: string, content: string): Promise<void>;
}

export const nodeFileSystem: FileSystem = {
  stat: async (path) => {
    const info = await stat(path);
    return { size: info.size, isFile: info.isFile() };
  },
  readBytes: (path) => Bun.file(path).bytes(),
  write: (path, content) => writeFileAtomic(path, content),
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

const decoder = new TextDecoder("utf-8");

/** File reads and writes for tabs (spec §10.2). Paths only ever come from Main's own dialogs or tokens. */
export class FileService {
  readonly #largeTokens = new Map<string, { path: string; size: number; expiresAt: number }>();
  readonly #saveAsTokens = new Map<string, PendingSaveAs>();
  readonly #now: () => number;

  constructor(
    private readonly fs: FileSystem,
    options: { now?: () => number } = {},
  ) {
    this.#now = options.now ?? Date.now;
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
      if (size > MAX_FILE_BYTES) {
        errors.push(strings.files.tooLarge(name));
      } else if (size > LARGE_FILE_BYTES) {
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
    const token = crypto.randomUUID();
    this.#saveAsTokens.set(token, pending);
    return token;
  }

  takeSaveAsToken(token: string): PendingSaveAs | null {
    const pending = this.#saveAsTokens.get(token) ?? null;
    this.#saveAsTokens.delete(token);
    return pending;
  }

  async #read(path: string, name: string): Promise<ReadyFile | { error: string }> {
    try {
      const bytes = await this.fs.readBytes(path);
      if (!isProbablyText(bytes)) return { error: strings.files.notText(name) };
      return { path, content: decoder.decode(bytes) };
    } catch {
      return { error: strings.files.unreadable(name) };
    }
  }
}
