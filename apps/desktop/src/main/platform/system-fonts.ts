import { readFile } from "node:fs/promises";
import { writeFileAtomic } from "../persistence/atomic-write";

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
  const proc = Bun.spawn(["system_profiler", "SPFontsDataType", "-json"], { stdout: "pipe", stderr: "ignore" });
  const timer = setTimeout(() => proc.kill(), timeoutMs);
  try {
    const [output, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    if (code !== 0) throw new Error(`system_profiler exited with ${code}`);
    return output;
  } finally {
    clearTimeout(timer);
  }
}

export class SystemFontsService {
  #refreshing: Promise<SystemFontList | null> | null = null;

  constructor(
    private readonly deps: {
      cacheFile: string;
      run(): Promise<string>;
      now?(): number;
      maxAgeMs?: number;
      log(message: string, detail?: unknown): void;
    },
  ) {}

  async list(): Promise<{ fonts: SystemFontList | null; refreshing: boolean }> {
    const cached = await this.#readCache();
    const now = (this.deps.now ?? Date.now)();
    const stale = !cached || now - cached.at > (this.deps.maxAgeMs ?? SYSTEM_FONTS_MAX_AGE_MS);
    if (stale) void this.refresh();
    return { fonts: cached?.fonts ?? null, refreshing: stale };
  }

  refresh(): Promise<SystemFontList | null> {
    if (this.#refreshing) return this.#refreshing;
    this.#refreshing = (async () => {
      try {
        const fonts = parseSystemFonts(await this.deps.run());
        const at = (this.deps.now ?? Date.now)();
        await writeFileAtomic(this.deps.cacheFile, JSON.stringify({ at, fonts }));
        return fonts;
      } catch (error) {
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
      const value = JSON.parse(await readFile(this.deps.cacheFile, "utf8")) as { at?: unknown; fonts?: SystemFontList };
      if (typeof value.at !== "number" || !Array.isArray(value.fonts?.monospace) || !Array.isArray(value.fonts?.other))
        return null;
      return { at: value.at, fonts: value.fonts };
    } catch {
      return null;
    }
  }
}
