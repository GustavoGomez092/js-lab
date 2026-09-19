import { isSafeEntryName, openZip, ZipError } from "./zip";

/**
 * Reads the theme contributions out of a `.vsix` package (spec §9.3).
 *
 * A `.vsix` is an untrusted third-party archive, so nothing here trusts the manifest it just parsed: a declared
 * theme path is resolved as a string against the archive's own entry names and re-validated before it is looked
 * up, and `readVsixTheme` will only read a path the manifest itself declared.
 */

/** One `contributes.themes` entry, with its `path` already resolved to an archive entry name. */
export interface VsixThemeEntry {
  label: string;
  uiTheme: string;
  path: string;
}

export type VsixResult = { ok: true; themes: VsixThemeEntry[] } | { ok: false; error: string };

const MANIFEST = "extension/package.json";

const NO_MANIFEST = "That .vsix doesn't contain an extension manifest.";
const BAD_MANIFEST = "That extension's manifest isn't valid JSON.";
const NO_THEMES = "That extension doesn't contain any colour themes.";
const THEME_OUTSIDE = "That extension declares a theme outside the package.";
const UNREADABLE = "That .vsix file couldn't be read.";
const NOT_DECLARED = "That theme isn't part of the selected extension.";
const BAD_THEME_JSON = "That theme file isn't valid JSON.";

/** What VS Code assumes when a theme contribution omits `uiTheme`. */
const DEFAULT_UI_THEME = "vs-dark";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * `"./themes/dark.json"` becomes `"extension/themes/dark.json"`.
 *
 * This is a string operation on archive entry names and never a filesystem path join. A join would hand `..` to the
 * host filesystem to resolve, and the result would be a real path something downstream might be tempted to open.
 * The resolved name is re-checked with `isSafeEntryName`, because the manifest that declared it came out of the
 * same untrusted archive as the entries it points at.
 */
function resolveThemePath(declared: string): string | null {
  const trimmed = declared.trim().replace(/^\.\//, "");
  // A manifest that already spells the full archive name is taken as written. The cost is that a package holding a
  // folder literally named `extension` inside `extension/` would resolve one level short; no real theme pack has one.
  const full = trimmed.startsWith("extension/") ? trimmed : `extension/${trimmed}`;
  return isSafeEntryName(full) ? full : null;
}

/**
 * Opens the archive and hands `use` the reader.
 *
 * Every refusal `zip.ts` raises arrives here as a `ZipError` whose message is already safe to show: it never quotes
 * an entry name or a path separator, because the offending name travels on `ZipError.entryName` for the log
 * instead. This module forwards that message to the UI verbatim, so the suite asserts the property from this side
 * of the boundary as well — it is the point where a leak would actually reach a user.
 */
function withArchive<T>(
  bytes: Uint8Array,
  use: (read: (name: string) => Uint8Array, has: (name: string) => boolean) => T,
): T | { ok: false; error: string } {
  try {
    const zip = openZip(bytes);
    return use(zip.read, zip.has);
  } catch (error) {
    return { ok: false, error: error instanceof ZipError ? error.message : UNREADABLE };
  }
}

/** Spec §9.3: extract `extension/package.json` `contributes.themes` so the user can pick one. */
export function listVsixThemes(bytes: Uint8Array): VsixResult {
  return withArchive(bytes, (read, has): VsixResult => {
    if (!has(MANIFEST)) return { ok: false, error: NO_MANIFEST };
    // Read outside the JSON guard on purpose: a damaged archive must be reported as damaged. Reading inside it
    // would relabel every ZipError as "the manifest isn't valid JSON", which sends the user looking for the wrong
    // problem in a file they cannot see.
    const rawManifest = read(MANIFEST);
    let manifest: unknown;
    try {
      manifest = JSON.parse(new TextDecoder().decode(rawManifest));
    } catch {
      return { ok: false, error: BAD_MANIFEST };
    }
    const contributes = isRecord(manifest) ? manifest.contributes : undefined;
    const declared = isRecord(contributes) ? contributes.themes : undefined;
    // No separate empty check: a zero-length `themes` falls through the loop to the identical refusal
    // below. An inverse probe re-added one and nothing changed, so the dead branch is not shipped.
    if (!Array.isArray(declared)) {
      return { ok: false, error: NO_THEMES };
    }
    const themes: VsixThemeEntry[] = [];
    for (const entry of declared) {
      if (!isRecord(entry) || typeof entry.path !== "string") continue;
      const path = resolveThemePath(entry.path);
      // One escaping path condemns the whole package rather than being filtered out of it. A manifest pointing
      // outside its own archive is evidence about the package, not about that single entry.
      if (path === null) return { ok: false, error: THEME_OUTSIDE };
      if (!has(path)) continue;
      const fileName = path.slice(path.lastIndexOf("/") + 1).replace(/\.json$/i, "");
      const label = typeof entry.label === "string" ? entry.label.trim() : "";
      const uiTheme = typeof entry.uiTheme === "string" ? entry.uiTheme.trim() : "";
      themes.push({
        label: label || fileName,
        uiTheme: uiTheme || DEFAULT_UI_THEME,
        path,
      });
    }
    if (themes.length === 0) return { ok: false, error: NO_THEMES };
    return { ok: true, themes };
  });
}

/**
 * Reads one theme file out of a `.vsix`. The path must be one the manifest itself declared — a caller cannot name
 * an arbitrary archive member, so a UI round trip can't be talked into reading something else out of the package.
 */
export function readVsixTheme(
  bytes: Uint8Array,
  path: string,
): { ok: true; json: unknown } | { ok: false; error: string } {
  const listed = listVsixThemes(bytes);
  if (!listed.ok) return listed;
  if (!listed.themes.some((theme) => theme.path === path)) {
    return { ok: false, error: NOT_DECLARED };
  }
  return withArchive(bytes, (read): { ok: true; json: unknown } | { ok: false; error: string } => {
    // Read outside the JSON guard for the same reason the manifest is: a damaged entry is not a syntax error.
    const raw = read(path);
    try {
      return { ok: true, json: JSON.parse(new TextDecoder().decode(raw)) };
    } catch {
      return { ok: false, error: BAD_THEME_JSON };
    }
  });
}
