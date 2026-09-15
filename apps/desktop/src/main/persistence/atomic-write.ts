import { chmod, copyFile, mkdir, open, rename, stat, unlink } from "node:fs/promises";
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

  // Determine the mode to use: explicit option, existing file's mode, or default
  let mode = options.mode;
  if (mode === undefined) {
    try {
      mode = (await stat(path)).mode & 0o777;
    } catch {
      mode = 0o644;
    }
  }

  const handle = await open(tmp, "w", mode);
  try {
    try {
      await handle.writeFile(data);
      await handle.sync();
    } finally {
      await handle.close();
    }
    // Ensure mode is applied even if umask interfered
    await chmod(tmp, mode);

    if (options.backup) {
      await copyFile(path, `${path}.bak`).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
      });
    }
    await rename(tmp, path);
  } catch (error) {
    await unlink(tmp).catch(() => {});
    throw error;
  }
}
