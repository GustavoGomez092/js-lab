import { deflateSync } from "node:zlib";

export type Rgb = readonly [number, number, number];
type Point = readonly [number, number];

/** Graphite tokens: bg.canvas, bg.chrome and fg.accent. */
export const ICON_COLORS: { canvas: Rgb; chrome: Rgb; accent: Rgb } = {
  canvas: [0x1b, 0x1e, 0x23],
  chrome: [0x16, 0x19, 0x1d],
  accent: [0x6f, 0x9b, 0xff],
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

/** Signed distance from (x, y) to a rounded square centred at (c, c) with half-size `half` and corner radius `radius`. */
function roundedSquareDistance(x: number, y: number, c: number, half: number, radius: number): number {
  const qx = Math.abs(x - c) - (half - radius);
  const qy = Math.abs(y - c) - (half - radius);
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - radius;
}

function distanceToSegment(x: number, y: number, a: Point, b: Point): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const lengthSquared = dx * dx + dy * dy;
  const t = lengthSquared === 0 ? 0 : clamp01(((x - a[0]) * dx + (y - a[1]) * dy) / lengthSquared);
  return Math.hypot(x - (a[0] + t * dx), y - (a[1] + t * dy));
}

/** Points on a circular arc from `from` to `to` degrees (y grows downward). */
function arc(cx: number, cy: number, radius: number, from: number, to: number, steps = 12): Point[] {
  return Array.from({ length: steps + 1 }, (_, index): Point => {
    const angle = ((from + ((to - from) * index) / steps) * Math.PI) / 180;
    return [cx + radius * Math.cos(angle), cy + radius * Math.sin(angle)];
  });
}

/** "{" as a polyline: the top hook, the stem, the tip at mid-height, the stem, the bottom hook. */
function leftBrace(size: number): Point[] {
  const c = size / 2;
  const x = c - 0.17 * size;
  const top = c - 0.2 * size;
  const bottom = c + 0.2 * size;
  const r = 0.06 * size;
  return [
    ...arc(x + r, top + r, r, 270, 180),
    ...arc(x - r, c - r, r, 0, 90),
    ...arc(x - r, c + r, r, 270, 360),
    ...arc(x + r, bottom - r, r, 180, 90),
  ];
}

/** The JSLab app icon at `size`×`size` pixels, as straight-alpha RGBA. */
export function renderAppIcon(size: number): Uint8Array {
  const rgba = new Uint8Array(size * size * 4);
  const c = size / 2;
  const half = 0.4 * size;
  const radius = 0.225 * (2 * half);
  const rim = 0.035 * size;
  const strokeHalf = 0.0275 * size;
  const left = leftBrace(size);
  const right = left.map(([x, y]): Point => [size - x, y]);
  const segments: [Point, Point][] = [];
  for (const brace of [left, right]) {
    for (let index = 1; index < brace.length; index++)
      segments.push([brace[index - 1] as Point, brace[index] as Point]);
  }
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      const x = px + 0.5;
      const y = py + 0.5;
      const body = clamp01(0.5 - roundedSquareDistance(x, y, c, half, radius));
      if (body === 0) continue;
      const face = clamp01(0.5 - roundedSquareDistance(x, y, c, half - rim, Math.max(radius - rim, 0)));
      let ink = 0;
      // Only pixels near the braces (|x - c| within 17% ± 6% plus the stroke) measure segment distances.
      if (
        Math.abs(Math.abs(x - c) - 0.17 * size) <= 0.06 * size + strokeHalf + 1 &&
        Math.abs(y - c) <= 0.2 * size + strokeHalf + 1
      ) {
        let nearest = Number.POSITIVE_INFINITY;
        for (const [a, b] of segments) nearest = Math.min(nearest, distanceToSegment(x, y, a, b));
        ink = clamp01(strokeHalf + 0.5 - nearest);
      }
      const color = mix(mix(ICON_COLORS.chrome, ICON_COLORS.canvas, face), ICON_COLORS.accent, ink);
      const offset = (py * size + px) * 4;
      rgba[offset] = Math.round(color[0]);
      rgba[offset + 1] = Math.round(color[1]);
      rgba[offset + 2] = Math.round(color[2]);
      rgba[offset + 3] = Math.round(255 * body);
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
