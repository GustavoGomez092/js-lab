import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encodePng, ICONSET_ENTRIES, renderAppIcon } from "./app-icon";

// Branding carry: renders assets/app-icon-1024.png, then builds icon.iconset from it with macOS sips and validates it
// with iconutil. Run from apps/desktop with `bun scripts/build-app-icon.ts`. Needs macOS; downloads nothing.
const SOURCE_PIXELS = 1024;
const desktop = join(import.meta.dir, "..");
const source = join(desktop, "assets", "app-icon-1024.png");
const iconset = join(desktop, "icon.iconset");

function run(argv: string[]): void {
  const result = Bun.spawnSync(argv, { stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0)
    throw new Error(`${argv[0]} failed (exit ${result.exitCode}): ${result.stderr.toString()}`);
}

await mkdir(join(desktop, "assets"), { recursive: true });
await writeFile(source, encodePng(SOURCE_PIXELS, SOURCE_PIXELS, renderAppIcon(SOURCE_PIXELS)));
await rm(iconset, { recursive: true, force: true });
await mkdir(iconset, { recursive: true });
for (const entry of ICONSET_ENTRIES) {
  run(["sips", "-z", String(entry.pixels), String(entry.pixels), source, "--out", join(iconset, entry.file)]);
}
// iconutil rejects a malformed iconset. Its .icns goes to a fresh temp folder and is not committed.
const check = await mkdtemp(join(tmpdir(), "jslab-icns-"));
try {
  run(["iconutil", "--convert", "icns", "--output", join(check, "icon.icns"), iconset]);
} finally {
  await rm(check, { recursive: true, force: true });
}
console.log(`Wrote assets/app-icon-1024.png and ${ICONSET_ENTRIES.length} files in icon.iconset`);
