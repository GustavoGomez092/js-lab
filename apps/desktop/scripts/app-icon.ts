import { deflateSync } from "node:zlib";

export type Rgb = readonly [number, number, number];

/**
 * Graphite tokens plus the two tones the icon's ground is mixed from.
 *
 * `canvas`, `chrome` and `accent` are the shared Graphite values. `groundTop`/`groundBottom` are the icon's own
 * diagonal ground -- a little lighter and a little darker than `canvas` respectively, so the tile reads as a surface
 * rather than a flat swatch. `muted` is the editor's dimmed foreground, used for the code lines; `notch` is the
 * ground tone punched back out of the accent rail.
 */
export const ICON_COLORS: {
  canvas: Rgb;
  chrome: Rgb;
  accent: Rgb;
  groundTop: Rgb;
  groundBottom: Rgb;
  muted: Rgb;
  notch: Rgb;
} = {
  canvas: [0x1b, 0x1e, 0x23],
  chrome: [0x16, 0x19, 0x1d],
  accent: [0x6f, 0x9b, 0xff],
  groundTop: [0x23, 0x28, 0x31],
  groundBottom: [0x14, 0x17, 0x1b],
  muted: [0x83, 0x8c, 0x99],
  notch: [0x1a, 0x1d, 0x22],
};

/** The macOS iconset files (iconutil's names) and their pixel sizes. */
export const ICONSET_ENTRIES: readonly { file: string; pixels: number }[] = [16, 32, 128, 256, 512].flatMap(
  (points) => [
    { file: `icon_${points}x${points}.png`, pixels: points },
    { file: `icon_${points}x${points}@2x.png`, pixels: points * 2 },
  ],
);

const clamp01 = (value: number) => Math.min(1, Math.max(0, value));

const mix = (from: Rgb, to: Rgb, amount: number): Rgb => [
  from[0] + (to[0] - from[0]) * amount,
  from[1] + (to[1] - from[1]) * amount,
  from[2] + (to[2] - from[2]) * amount,
];

/**
 * Signed distance from (x, y) to a rounded rectangle centred at (cx, cy). Negative inside, and measured in pixels,
 * so `clamp01(0.5 - distance)` is a one-pixel antialiased coverage value for any shape here.
 */
function roundedRectDistance(
  x: number,
  y: number,
  cx: number,
  cy: number,
  halfWidth: number,
  halfHeight: number,
  radius: number,
): number {
  const r = Math.min(radius, halfWidth, halfHeight);
  const qx = Math.abs(x - cx) - (halfWidth - r);
  const qy = Math.abs(y - cy) - (halfHeight - r);
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
}

/**
 * The artwork's layout, as fractions of the icon **body** (not the full canvas).
 *
 * macOS draws an `.icns` exactly as supplied -- it applies no mask of its own -- so the body is the rounded square
 * this file draws, and every neighbour in the Dock is built on the same grid: a square inset to ~80% of the canvas
 * with a 22.5% corner radius. Laying the artwork out in body fractions (rather than canvas fractions) keeps the
 * composition identical to the approved design while the inset handles the platform convention.
 *
 * Heights are 96/1024 rather than the concept's 84/1024. Inside an 80% body, 84 units would put the code lines at
 * 6.6% of the canvas -- 1.05 px at 16 px, on the edge of what a display resolves, and the exact failure that
 * retired the previous icon. 96 units puts them at 7.5% (1.2 px) with the row centres unmoved.
 */
const RAIL_LEFT = 700 / 1024;
const BAR_LEFT = 150 / 1024;
const BAR_WIDTHS = [400 / 1024, 300 / 1024, 350 / 1024] as const;
/** Row centres: the three code lines, the middle one aligned with the notch. Evenly spaced by 182/1024. */
const ROW_CENTERS = [330 / 1024, 512 / 1024, 694 / 1024] as const;
const ROW_HALF_HEIGHT = 48 / 1024;
const NOTCH_LEFT = 752 / 1024;
const NOTCH_RIGHT = 952 / 1024;

/** The JSLab app icon at `size`×`size` pixels, as straight-alpha RGBA. */
export function renderAppIcon(size: number): Uint8Array {
  const rgba = new Uint8Array(size * size * 4);
  const c = size / 2;
  const half = 0.4 * size;
  const radius = 0.225 * (2 * half);
  const body = 2 * half;
  const originX = c - half;
  const originY = c - half;
  /** Body fraction → absolute pixels, horizontally and vertically. */
  const px = (fraction: number) => originX + fraction * body;
  const py = (fraction: number) => originY + fraction * body;
  const len = (fraction: number) => fraction * body;

  const railLeft = px(RAIL_LEFT);
  const rowHalfHeight = len(ROW_HALF_HEIGHT);
  const notchCenterX = px((NOTCH_LEFT + NOTCH_RIGHT) / 2);
  const notchHalfWidth = len((NOTCH_RIGHT - NOTCH_LEFT) / 2);
  const notchCenterY = py(ROW_CENTERS[1] as number);
  const bars = BAR_WIDTHS.map((width, row) => ({
    centerX: px(BAR_LEFT + width / 2),
    centerY: py(ROW_CENTERS[row] as number),
    halfWidth: len(width / 2),
  }));

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const sx = x + 0.5;
      const sy = y + 0.5;
      const coverage = clamp01(0.5 - roundedRectDistance(sx, sy, c, c, half, half, radius));
      if (coverage === 0) continue;

      // The ground: the concept's top-left to bottom-right gradient, across the body's own diagonal.
      const t = clamp01((sx - originX + (sy - originY)) / (2 * body));
      let color = mix(ICON_COLORS.groundTop, ICON_COLORS.groundBottom, t);

      // The output rail: full-bleed to the body's right edge, so the rounded corners clip it rather than a border.
      color = mix(color, ICON_COLORS.accent, clamp01(sx - railLeft + 0.5));

      // The notch, punched out of the rail on the middle row -- where the anchored result lands.
      const notch = clamp01(
        0.5 - roundedRectDistance(sx, sy, notchCenterX, notchCenterY, notchHalfWidth, rowHalfHeight, rowHalfHeight),
      );
      color = mix(color, ICON_COLORS.notch, notch);

      // The three code lines on the left.
      let bar = 0;
      for (const { centerX, centerY, halfWidth } of bars) {
        if (Math.abs(sy - centerY) > rowHalfHeight + 1) continue;
        bar = Math.max(
          bar,
          clamp01(0.5 - roundedRectDistance(sx, sy, centerX, centerY, halfWidth, rowHalfHeight, rowHalfHeight)),
        );
      }
      color = mix(color, ICON_COLORS.muted, bar);

      const offset = (y * size + x) * 4;
      rgba[offset] = Math.round(color[0]);
      rgba[offset + 1] = Math.round(color[1]);
      rgba[offset + 2] = Math.round(color[2]);
      rgba[offset + 3] = Math.round(255 * coverage);
    }
  }
  return rgba;
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let value = n;
  for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = (CRC_TABLE[(crc ^ byte) & 0xff] as number) ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  out.set(new TextEncoder().encode(type), 4);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

/** A minimal 8-bit RGBA PNG: no interlace, filter type 0 on every row. */
export function encodePng(width: number, height: number, rgba: Uint8Array): Uint8Array {
  const header = new Uint8Array(13);
  const headerView = new DataView(header.buffer);
  headerView.setUint32(0, width);
  headerView.setUint32(4, height);
  header.set([8, 6, 0, 0, 0], 8);
  const stride = width * 4;
  const rows = new Uint8Array((stride + 1) * height);
  for (let row = 0; row < height; row++)
    rows.set(rgba.subarray(row * stride, (row + 1) * stride), row * (stride + 1) + 1);
  const parts = [
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", new Uint8Array(deflateSync(rows))),
    chunk("IEND", new Uint8Array(0)),
  ];
  const out = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/** Width and height from a PNG's IHDR chunk. */
export function pngSize(bytes: Uint8Array): { width: number; height: number } {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.byteLength < 24 || view.getUint32(12) !== 0x49484452) throw new Error("not a PNG with an IHDR chunk");
  return { width: view.getUint32(16), height: view.getUint32(20) };
}
