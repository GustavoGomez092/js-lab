import { copyFile, mkdir, open, rename, unlink } from "node:fs/promises";
import { dirname } from "node:path";

export interface AtomicWriteOptions {
  /** Copy the current file to `<path>.bak` before replacing it. */
  backup?: boolean;
  /** File mode for newly written files (default 0o644). */
  mode?: number;
}

/** Writes via temp file + fsync + rename so readers never observe a partially written file. */
export async function writeFileAtomic(
  path: string,
  data: string | Uint8Array,
  options: AtomicWriteOptions = {},
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}-${crypto.randomUUID()}`;
  const handle = await open(tmp, "w", options.mode ?? 0o644);
  try {
    await handle.writeFile(data);
    await handle.sync();
  } finally {
    await handle.close();
  }
  if (options.backup) {
    await copyFile(path, `${path}.bak`).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
  try {
    await rename(tmp, path);
  } catch (error) {
    await unlink(tmp).catch(() => {});
    throw error;
  }
}
