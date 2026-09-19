import { rm } from "node:fs/promises";
import { join } from "node:path";
import { readRegularFileText } from "../fs/bounded-read";

/** JSLAB_E2E=1 only: native dialogs can't be driven over the socket, so the harness writes the answers. */
async function take(dataDir: string, name: string): Promise<unknown> {
  const path = join(dataDir, name);
  try {
    // The byte cap is waived and only the byte cap: these are the harness's own dialog answers, and no schema
    // bounds them, so there is no number to derive one from. The reachability argument that used to excuse the
    // bare read here answered the SIZE hazard alone -- it said nothing about a FIFO at the path, which parks Main
    // forever with no `try`/`catch` able to rescue it. The reader's `O_NONBLOCK` open and `isFile` check close
    // that half; every failure already means "no answer", so a refusal lands in the same catch as a missing file.
    const value = JSON.parse(await readRegularFileText(path)) as unknown;
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
