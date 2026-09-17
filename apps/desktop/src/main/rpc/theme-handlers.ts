import {
  emptyParamsSchema,
  type ImportedTheme,
  type ThemeImportResult,
  themeImportPickParamsSchema,
} from "@jslab/rpc-schema";
import { AA, BUILTIN_THEMES, contrastRatio, convertVsCodeTheme, type ThemeDefinition } from "@jslab/themes";
import type { ThemeStore } from "../services/theme-store";
import { strings } from "../strings";
import { listVsixThemes, readVsixTheme } from "../themes/vsix";
import { ZIP_LIMITS } from "../themes/zip";
import { createValidators, type Log } from "./validate";

export interface ThemeHandlerDeps {
  store: Pick<ThemeStore, "save" | "themes">;
  /** Main's own open dialog (or the E2E script); the UI never supplies a path. */
  openDialog(): Promise<string[]>;
  /**
   * The selected file's size without reading it, or null when it can't be told. Ruling R-M5d-B3: the plan checked
   * `bytes.length` *after* `readFileBytes` had already pulled the whole file into memory, under a comment claiming
   * the opposite. This is what makes that claim true.
   */
  fileSize(path: string): Promise<number | null>;
  readFileBytes(path: string): Promise<Uint8Array>;
  onChanged(themes: readonly ThemeDefinition[]): void;
  log: Log;
}

const PICK_TTL_MS = 5 * 60_000;

/**
 * The largest file this will import, for a `.json` theme and a `.vsix` alike.
 *
 * Taken from the zip reader's own total rather than restated as a second literal. The plan's `MAX_VSIX_BYTES` was
 * 64 MiB against `ZIP_LIMITS.maxTotalBytes` of 16 MiB, which the ledger flagged as inconsistent bounds to reconcile
 * before this task: because a deflate stream is never meaningfully larger than what it encodes, every archive those
 * two numbers disagreed about was accepted here and then certainly refused by `openZip` — a late, incoherent "that
 * archive is too large to read" in place of one early, coherent refusal. Deriving it means the two cannot drift.
 */
export const MAX_IMPORT_BYTES = ZIP_LIMITS.maxTotalBytes;

/**
 * Deliberately module-level, unlike the `KNOWN` set this task removed from the UI's `theme-commands.ts`: the
 * built-ins are fixed at build time and cannot grow while the app runs, which is exactly what made that other
 * snapshot wrong.
 */
const BUILTIN_IDS = new Set(BUILTIN_THEMES.map((theme) => theme.id));

/** Monaco rule foregrounds are bare (`build.ts`'s `bare`); only `monaco.colors` keeps the leading "#". */
const BARE_HEX = /^[0-9A-Fa-f]{6}$/;
const HEX = /^#[0-9A-Fa-f]{6}$/;

const FALLBACK_THEME_NAME = "Imported Theme";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * R-M5d-AA-1: an imported theme's syntax colours are painted as the file wrote them. Monaco applies the imported
 * rules last, so they override the AA-lifted colours `buildTheme` derived — the contrast guarantee covers the UI
 * chrome and the output panel but not the editor's own text. The ruling accepted that trade (fidelity to the theme
 * the user chose) and left it to this task to say so rather than silently lifting the colours.
 *
 * Every value is re-checked before it is measured: `contrastRatio` throws on anything that isn't `#RRGGBB`, and an
 * import must never throw.
 */
function hasLowContrastSyntax(theme: ThemeDefinition): boolean {
  const background = theme.monaco.colors["editor.background"];
  if (!background || !HEX.test(background)) return false;
  return theme.monaco.rules.some(
    (rule) =>
      rule.foreground && BARE_HEX.test(rule.foreground) && contrastRatio(`#${rule.foreground}`, background) < AA,
  );
}

/** The honest caveats about what the conversion could not carry across, shown once with the import's result. */
function notesFor(theme: ThemeDefinition, source: unknown): string[] {
  const notes: string[] = [];
  if (hasLowContrastSyntax(theme)) notes.push(strings.themes.lowContrastSyntax);
  // `semanticTokenColors` is accepted by the file format and then dropped: a theme expressing most of its colour
  // there converts to something much plainer than its author wrote, and nothing else would ever explain why.
  if (isRecord(source) && source.semanticTokenColors !== undefined) notes.push(strings.themes.semanticDropped);
  return notes;
}

/** Themes → Import VS Code Theme… (spec §9.3). */
export function createThemeHandlers(deps: ThemeHandlerDeps) {
  const { parse } = createValidators(deps.log);
  const pending = new Map<string, { bytes: Uint8Array; expiresAt: number }>();

  const sweep = () => {
    const now = Date.now();
    for (const [token, entry] of pending) if (entry.expiresAt < now) pending.delete(token);
  };

  const commit = async (json: unknown, fallbackName: string): Promise<ThemeImportResult> => {
    const converted = convertVsCodeTheme(json, { fallbackName });
    if (!converted.ok) return { ok: false, error: converted.error };
    const { theme } = converted;
    // Task 4 finding 1: `listThemes` lets a built-in win, so saving a theme whose name slugs onto a built-in id
    // would write the file, report success, and then hide it on every surface. Refuse before anything is written.
    if (BUILTIN_IDS.has(theme.id)) return { ok: false, error: strings.themes.builtinName };
    await deps.store.save(theme);
    deps.onChanged(deps.store.themes);
    const imported: ImportedTheme = { id: theme.id, name: theme.name, type: theme.type };
    return { ok: true, theme: imported, notes: notesFor(theme, json) };
  };

  const importVsix = async (bytes: Uint8Array): Promise<ThemeImportResult> => {
    const listed = listVsixThemes(bytes);
    // Forwarded verbatim: every refusal `zip.ts` raises is already safe to show, because it never quotes an entry
    // name or a path separator — the offending name travels on `ZipError.entryName`, for the log.
    if (!listed.ok) return { ok: false, error: listed.error };
    const [only] = listed.themes;
    if (listed.themes.length === 1 && only) {
      const read = readVsixTheme(bytes, only.path);
      return read.ok ? await commit(read.json, only.label) : { ok: false, error: read.error };
    }
    sweep();
    const token = crypto.randomUUID();
    pending.set(token, { bytes, expiresAt: Date.now() + PICK_TTL_MS });
    return { ok: true, token, choices: listed.themes.map(({ label, path }) => ({ label, path })) };
  };

  const importFrom = async (path: string): Promise<ThemeImportResult> => {
    // Checked against the declared size first, so an oversized file is refused without being read (R-M5d-B3). The
    // length check after the read stays authoritative: a file can grow between the two, and a size may be unknown.
    const declared = await deps.fileSize(path).catch(() => null);
    if (declared !== null && declared > MAX_IMPORT_BYTES) return { ok: false, error: strings.themes.tooLarge };

    let bytes: Uint8Array;
    try {
      bytes = await deps.readFileBytes(path);
    } catch (error) {
      // The raw message can carry an absolute path; log it, show the user a readable line (spec §9.3, §18).
      deps.log(strings.log.themeUnreadable, String(error));
      return { ok: false, error: strings.themes.unreadable };
    }
    if (bytes.length > MAX_IMPORT_BYTES) return { ok: false, error: strings.themes.tooLarge };

    if (path.toLowerCase().endsWith(".vsix")) return await importVsix(bytes);

    const fileName = path.slice(path.lastIndexOf("/") + 1).replace(/\.json$/i, "");
    let parsed: unknown;
    // Parsed on its own: wrapping `commit` in this too would relabel a failed save as "isn't a valid VS Code
    // theme", sending the user to look for a syntax error in a file that parsed perfectly well.
    try {
      parsed = JSON.parse(new TextDecoder().decode(bytes));
    } catch {
      return { ok: false, error: strings.themes.notJson };
    }
    return await commit(parsed, fileName);
  };

  return {
    requests: {
      "theme.import": async (input: unknown): Promise<ThemeImportResult> => {
        parse(emptyParamsSchema, "theme.import", input);
        const [path] = await deps.openDialog();
        // A cancelled dialog is not a failure: an empty error means "say nothing".
        if (!path) return { ok: false, error: "" };
        return await importFrom(path);
      },
      "theme.importPick": async (input: unknown): Promise<ThemeImportResult> => {
        const { token, path } = parse(themeImportPickParamsSchema, "theme.importPick", input);
        sweep();
        const entry = pending.get(token);
        if (!entry) return { ok: false, error: strings.themes.pickExpired };
        const listed = listVsixThemes(entry.bytes);
        if (!listed.ok) return { ok: false, error: listed.error };
        // `readVsixTheme` re-validates `path` against the manifest itself, so a caller cannot name an arbitrary
        // archive member even with a live token; the lookup here is only for the label to name the theme.
        const chosen = listed.themes.find((theme) => theme.path === path);
        const read = readVsixTheme(entry.bytes, path);
        if (!read.ok) return { ok: false, error: read.error };
        const result = await commit(read.json, chosen?.label ?? FALLBACK_THEME_NAME);
        // Only a successful import consumes the archive. A refusal has to leave the user able to pick a different
        // theme out of the same pack instead of making them reopen the file dialog for it.
        if (result.ok) pending.delete(token);
        return result;
      },
    },
    messages: {},
  };
}
