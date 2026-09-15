export type Rgb = [number, number, number];

export const AA = 4.5;

export function hexToRgb(hex: string): Rgb {
  const match = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!match?.[1]) throw new Error(`Invalid color "${hex}" (expected #RRGGBB)`);
  const value = Number.parseInt(match[1], 16);
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
}

export function rgbToHex([r, g, b]: Rgb): string {
  const channel = (c: number) =>
    Math.round(Math.max(0, Math.min(255, c)))
      .toString(16)
      .padStart(2, "0");
  return `#${channel(r)}${channel(g)}${channel(b)}`.toUpperCase();
}

function linear(channel: number): number {
  const s = channel / 255;
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}

export function relativeLuminance(hex: string): number {
  const [r, g, b] = hexToRgb(hex);
  return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
}

export function contrastRatio(a: string, b: string): number {
  const [light, dark] = [relativeLuminance(a), relativeLuminance(b)].sort((x, y) => y - x) as [number, number];
  return (light + 0.05) / (dark + 0.05);
}

/** Linear sRGB mix: t = 0 → a, t = 1 → b. */
export function mix(a: string, b: string, t: number): string {
  const [ar, ag, ab] = hexToRgb(a);
  const [br, bg, bb] = hexToRgb(b);
  return rgbToHex([ar + (br - ar) * t, ag + (bg - ag) * t, ab + (bb - ab) * t]);
}

/** Moves `fg` toward white or black in 1% steps until it reaches `min` on every background. */
export function ensureContrast(
  fg: string,
  backgrounds: readonly string[],
  direction: "lighter" | "darker",
  min = AA,
): string {
  const target = direction === "lighter" ? "#FFFFFF" : "#000000";
  for (let step = 0; step <= 100; step++) {
    const candidate = step === 0 ? rgbToHex(hexToRgb(fg)) : mix(fg, target, step / 100);
    if (backgrounds.every((background) => contrastRatio(candidate, background) >= min)) return candidate;
  }
  return target;
}
