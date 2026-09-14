import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";

/** JSLAB_E2E=1 only: native dialogs can't be driven over the socket, so the harness writes the answers. */
async function take(dataDir: string, name: string): Promise<unknown> {
  const path = join(dataDir, name);
  try {
    const value = JSON.parse(await readFile(path, "utf8")) as unknown;
    await rm(path, { force: true });
    return value;
  } catch {
    return undefined;
  }
}

export async function readE2EOpenDialog(dataDir: string): Promise<string[]> {
  const value = await take(dataDir, "e2e-open-dialog.json");
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

export async function readE2ESaveDialog(dataDir: string): Promise<string | null> {
  const value = (await take(dataDir, "e2e-save-dialog.json")) as { path?: unknown } | undefined;
  return typeof value?.path === "string" ? value.path : null;
}
