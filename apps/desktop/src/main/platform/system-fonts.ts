import { readBoundedText } from "../fs/bounded-read";
import { writeFileAtomic } from "../persistence/atomic-write";
import { MAX_SYSTEM_PROFILER_OUTPUT_BYTES } from "./subprocess-output";

/**
 * The font cache's byte cap. JSLab writes this file itself, from its own parse of `system_profiler` output, so its
 * size tracks exactly one thing: how many font families are installed. macOS ships a few hundred; 16 MB is on the
 * order of a hundred thousand families at a generous 160 bytes each.
 *
 * A cap is affordable here precisely because the cost of refusing is so small: `#readCache` returns null, which
 * `list()` already treats as "stale", so the next call re-runs the scan and rewrites the file.
 */
export const MAX_FONT_CACHE_BYTES = 16 * 1024 * 1024;

/**
 * Upstream gap: WKWebView lacks `queryLocalFonts`, so the installed families come from
 * `system_profiler SPFontsDataType -json`, cached, refreshed in the background (spec §4.6).
 */
export interface SystemFontList {
  monospace: string[];
  other: string[];
}

export const SYSTEM_FONTS_MAX_AGE_MS = 7 * 24 * 3600 * 1000;
const MONOSPACE_NAME = /mono|code|consol|courier|menlo|terminal/i;

interface ProfilerEntry {
  _name?: unknown;
  typefaces?: { family?: unknown; fixed_pitch?: unknown }[];
}

export function parseSystemFonts(json: string): SystemFontList {
  let entries: ProfilerEntry[];
  try {
    const parsed = JSON.parse(json) as { SPFontsDataType?: unknown };
    entries = Array.isArray(parsed.SPFontsDataType) ? (parsed.SPFontsDataType as ProfilerEntry[]) : [];
  } catch {
    return { monospace: [], other: [] };
  }
  const families = new Map<string, boolean>();
  const add = (family: string, fixed: boolean) => {
    const name = family.trim();
    if (!name || name.startsWith(".")) return;
    families.set(name, (families.get(name) ?? false) || fixed || MONOSPACE_NAME.test(name));
  };
  for (const entry of entries) {
    const typefaces = Array.isArray(entry.typefaces) ? entry.typefaces : [];
    if (typefaces.length === 0 && typeof entry._name === "string") add(entry._name.replace(/\.[^.]+$/, ""), false);
    for (const face of typefaces) {
      if (typeof face.family !== "string") continue;
      add(face.family, face.fixed_pitch === true || face.fixed_pitch === "yes");
    }
  }
  const sorted = [...families.entries()].sort(([a], [b]) => a.localeCompare(b));
  return {
    monospace: sorted.filter(([, mono]) => mono).map(([name]) => name),
    other: sorted.filter(([, mono]) => !mono).map(([name]) => name),
  };
}

export async function runSystemProfiler(timeoutMs = 60_000): Promise<string> {
  // The 60 s kill below bounds how LONG this runs, never how much it buffers: 60 s of a flooding child is many
  // gigabytes of Main's heap. maxBuffer is what bounds the memory, by ending the child (see subprocess-output).
  const proc = Bun.spawn(["system_profiler", "SPFontsDataType", "-json"], {
    stdout: "pipe",
    stderr: "ignore",
    maxBuffer: MAX_SYSTEM_PROFILER_OUTPUT_BYTES,
  });
  const timer = setTimeout(() => proc.kill(), timeoutMs);
  try {
    const [output, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    if (code !== 0) throw new Error(`system_profiler exited with ${code}`);
    return output;
  } finally {
    clearTimeout(timer);
  }
}

/** After a failed scan, `list()` waits this long before starting another (review I-1). */
export const SYSTEM_FONTS_RETRY_MS = 10 * 60_000;

export class SystemFontsService {
  #refreshing: Promise<SystemFontList | null> | null = null;
  #lastFailureAt: number | null = null;

  constructor(
    private readonly deps: {
      cacheFile: string;
      run(): Promise<string>;
      now?(): number;
      maxAgeMs?: number;
      /** Backoff after a failed scan; defaults to SYSTEM_FONTS_RETRY_MS. */
      retryMs?: number;
      log(message: string, detail?: unknown): void;
    },
  ) {}

  async list(): Promise<{ fonts: SystemFontList | null; refreshing: boolean }> {
    const cached = await this.#readCache();
    const now = (this.deps.now ?? Date.now)();
    const stale = !cached || now - cached.at > (this.deps.maxAgeMs ?? SYSTEM_FONTS_MAX_AGE_MS);
    // A scan that just failed (a non-zero exit or the 60 s kill) isn't re-run on every poll: the Settings window
    // would otherwise spawn system_profiler back to back while it stays open.
    const backingOff =
      this.#lastFailureAt !== null && now - this.#lastFailureAt < (this.deps.retryMs ?? SYSTEM_FONTS_RETRY_MS);
    if (stale && backingOff && !this.#refreshing) return { fonts: cached?.fonts ?? null, refreshing: false };
    if (stale) void this.refresh();
    return { fonts: cached?.fonts ?? null, refreshing: stale };
  }

  /** Scans now (sharing an in-flight scan). An explicit call ignores the failure backoff. */
  refresh(): Promise<SystemFontList | null> {
    if (this.#refreshing) return this.#refreshing;
    this.#refreshing = (async () => {
      try {
        const fonts = parseSystemFonts(await this.deps.run());
        const at = (this.deps.now ?? Date.now)();
        await writeFileAtomic(this.deps.cacheFile, JSON.stringify({ at, fonts }));
        this.#lastFailureAt = null;
        return fonts;
      } catch (error) {
        this.#lastFailureAt = (this.deps.now ?? Date.now)();
        this.deps.log("System font scan failed", String(error));
        return null;
      } finally {
        this.#refreshing = null;
      }
    })();
    return this.#refreshing;
  }

  async #readCache(): Promise<{ at: number; fonts: SystemFontList } | null> {
    try {
      // The cache lives in JSLab's own user-writable data dir, so it may not be a regular file by the time it is
      // read; the reader refuses a FIFO instead of parking Main, and every failure here already means "stale".
      const value = JSON.parse(await readBoundedText(this.deps.cacheFile, MAX_FONT_CACHE_BYTES)) as {
        at?: unknown;
        fonts?: SystemFontList;
      };
      if (typeof value.at !== "number" || !Array.isArray(value.fonts?.monospace) || !Array.isArray(value.fonts?.other))
        return null;
      return { at: value.at, fonts: value.fonts };
    } catch {
      return null;
    }
  }
}
