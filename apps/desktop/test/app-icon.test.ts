import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { encodePng, ICON_COLORS, ICONSET_ENTRIES, pngSize, renderAppIcon } from "../scripts/app-icon";

const ICONSET = join(import.meta.dir, "..", "icon.iconset");

const pixel = (rgba: Uint8Array, size: number, x: number, y: number) => {
  const offset = (Math.floor(y) * size + Math.floor(x)) * 4;
  return [...rgba.subarray(offset, offset + 4)];
};

describe("app icon (branding carry)", () => {
  test("icon.iconset holds the ten macOS icon files at their exact pixel sizes", () => {
    expect(
      readdirSync(ICONSET)
        .filter((name) => name.endsWith(".png"))
        .sort(),
    ).toEqual(ICONSET_ENTRIES.map((entry) => entry.file).sort());
    for (const entry of ICONSET_ENTRIES) {
      const path = join(ICONSET, entry.file);
      expect(existsSync(path)).toBe(true);
      expect(pngSize(readFileSync(path))).toEqual({ width: entry.pixels, height: entry.pixels });
    }
    expect([...new Set(ICONSET_ENTRIES.map((entry) => entry.pixels))].sort((a, b) => a - b)).toEqual([
      16, 32, 64, 128, 256, 512, 1024,
    ]);
    expect(pngSize(readFileSync(join(import.meta.dir, "..", "assets", "app-icon-1024.png")))).toEqual({
      width: 1024,
      height: 1024,
    });
  });

  test("the renderer draws the accent { } monogram on the Graphite face, with transparent corners", () => {
    const size = 256;
    const rgba = renderAppIcon(size);
    expect(rgba.length).toBe(size * size * 4);
    expect(pixel(rgba, size, 2, 2)[3]).toBe(0);
    // The face between the braces' tops and the rim.
    expect(pixel(rgba, size, size / 2, size * 0.2)).toEqual([...ICON_COLORS.canvas, 255]);
    // The stems of "{" and "}" (x = centre ∓ 17%, between the top hook and the tip).
    expect(pixel(rgba, size, size * 0.33, size * 0.4)).toEqual([...ICON_COLORS.accent, 255]);
    expect(pixel(rgba, size, size * 0.67, size * 0.4)).toEqual([...ICON_COLORS.accent, 255]);
    expect(pngSize(encodePng(4, 4, renderAppIcon(4)))).toEqual({ width: 4, height: 4 });
  });
});
