import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { encodePng, ICON_COLORS, ICONSET_ENTRIES, pngSize, type Rgb, renderAppIcon } from "../scripts/app-icon";

const ICONSET = join(import.meta.dir, "..", "icon.iconset");

const pixel = (rgba: Uint8Array, size: number, x: number, y: number) => {
  const offset = (Math.floor(y) * size + Math.floor(x)) * 4;
  return [...rgba.subarray(offset, offset + 4)];
};

/** Whether a pixel is that colour within `tolerance` per channel -- antialiased edges never land on it exactly. */
const near = (actual: readonly number[], target: Rgb, tolerance = 2) =>
  target.every((channel, index) => Math.abs((actual[index] as number) - channel) <= tolerance);

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

  test("the renderer draws the split rail: code lines left, accent output rail right, notched on the middle row", () => {
    const size = 256;
    const rgba = renderAppIcon(size);
    expect(rgba.length).toBe(size * size * 4);

    // The body is inset to 80% of the canvas with rounded corners, so the canvas corners stay transparent. macOS
    // applies no mask of its own to an .icns; this rounded square is what makes the icon sit on the Dock's grid.
    expect(pixel(rgba, size, 2, 2)[3]).toBe(0);

    // The rail: right of 64.7% of the canvas, above the notch's row.
    expect(near(pixel(rgba, size, size * 0.72, size * 0.3), ICON_COLORS.accent)).toBe(true);

    // The notch, punched back out of the rail where the middle line's result lands.
    expect(near(pixel(rgba, size, size * 0.7656, size * 0.5), ICON_COLORS.notch)).toBe(true);

    // The middle code line, on the left.
    expect(near(pixel(rgba, size, size * 0.3, size * 0.5), ICON_COLORS.muted)).toBe(true);

    // Between two code lines: the ground, which is a gradient, so assert what it is *not*.
    const gap = pixel(rgba, size, size * 0.3, size * 0.42);
    expect(gap[3]).toBe(255);
    expect(near(gap, ICON_COLORS.accent, 24)).toBe(false);
    expect(near(gap, ICON_COLORS.muted, 24)).toBe(false);

    // The rail is the right-hand side only: nothing in the left half is ever accent.
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size / 2; x++) {
        if (near(pixel(rgba, size, x, y), ICON_COLORS.accent, 24))
          throw new Error(`accent found in the left half at ${x},${y}`);
      }
    }

    expect(pngSize(encodePng(4, 4, renderAppIcon(4)))).toEqual({ width: 4, height: 4 });
  });

  test("the rail still reads at 16px -- the size the previous icon's hairline monogram failed at", () => {
    const size = 16;
    const rgba = renderAppIcon(size);
    let accent = 0;
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) if (near(pixel(rgba, size, x, y), ICON_COLORS.accent, 40)) accent++;
    }
    // The rail is ~4px wide over a ~13px body, so a dozen solid accent pixels survive even after the notch.
    expect(accent).toBeGreaterThanOrEqual(12);
  });
});
