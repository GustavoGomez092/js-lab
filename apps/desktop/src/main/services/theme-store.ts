import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { type ThemeDefinition, TOKEN_NAMES } from "@jslab/themes";
import { writeFileAtomic } from "../persistence/atomic-write";

const SUFFIX = ".jslab-theme.json";

/**
 * The ids `slugThemeId` produces and `commandForMenuAction` accepts (Finding T3). The id also becomes the file's
 * name, so this is what keeps a saved theme inside the themes folder: `\w` and `-` admit no separator and no dot.
 */
const SAFE_ID = /^[\w-]{1,64}$/;
const HEX = /^#[0-9A-Fa-f]{6}$/;

type Log = (message: string, detail?: unknown) => void;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Monaco is handed this object verbatim by `monaco.defineTheme`, so every part of it is checked: a missing `colors`
 * or a rule without a token name reaches Monaco as `undefined` and breaks the editor rather than the theme.
 */
function parseMonaco(raw: unknown): ThemeDefinition["monaco"] | null {
  if (!isRecord(raw)) return null;
  if (raw.base !== "vs" && raw.base !== "vs-dark") return null;
  if (raw.inherit !== true) return null;
  if (!Array.isArray(raw.rules)) return null;
  for (const rule of raw.rules) if (!isRecord(rule) || typeof rule.token !== "string") return null;
  if (!isRecord(raw.colors)) return null;
  for (const value of Object.values(raw.colors)) if (typeof value !== "string") return null;
  return raw as unknown as ThemeDefinition["monaco"];
}

/** A file under `<appdata>/themes/` is user-editable, so it is validated on load like any other untrusted input. */
function parseTheme(raw: unknown): ThemeDefinition | null {
  if (!isRecord(raw)) return null;
  if (typeof raw.id !== "string" || !SAFE_ID.test(raw.id)) return null;
  if (typeof raw.name !== "string" || !raw.name.trim()) return null;
  if (raw.type !== "dark" && raw.type !== "light") return null;
  // `credit` is required on ThemeDefinition and shown in About → Credits, so a file without it is not one.
  if (typeof raw.credit !== "string") return null;
  if (!isRecord(raw.tokens)) return null;
  for (const name of TOKEN_NAMES) {
    const value = raw.tokens[name];
    if (typeof value !== "string" || !HEX.test(value)) return null;
  }
  if (parseMonaco(raw.monaco) === null) return null;
  return raw as unknown as ThemeDefinition;
}

/** `<appdata>/themes/` (spec §4.5): the imported themes the Themes menu and the Appearance picker offer (spec §9.3). */
export class ThemeStore {
  readonly #listeners = new Set<(themes: readonly ThemeDefinition[]) => void>();
  #themes: ThemeDefinition[];

  private constructor(
    readonly dir: string,
    themes: ThemeDefinition[],
  ) {
    this.#themes = themes;
  }

  static async open(themesDir: string, log: Log): Promise<ThemeStore> {
    let files: string[];
    try {
      files = (await readdir(themesDir)).filter((name) => name.endsWith(SUFFIX)).sort();
    } catch {
      // No folder yet: a fresh install has imported nothing. Nothing is created until the first save.
      return new ThemeStore(themesDir, []);
    }
    const themes: ThemeDefinition[] = [];
    for (const file of files) {
      let parsed: ThemeDefinition | null = null;
      try {
        parsed = parseTheme(JSON.parse(await readFile(join(themesDir, file), "utf8")));
      } catch {
        parsed = null;
      }
      // One bad file never prevents startup and never displaces the themes that did load.
      if (parsed) themes.push(parsed);
      else log(`Skipped an unreadable theme file: ${file}`);
    }
    return new ThemeStore(themesDir, themes);
  }

  get themes(): readonly ThemeDefinition[] {
    return this.#themes;
  }

  async save(theme: ThemeDefinition): Promise<void> {
    // Checked before anything touches the disk: the id names the file, so an unsafe one must not create it.
    if (!SAFE_ID.test(theme.id)) throw new Error("That theme's id can't be used as a file name.");
    // writeFileAtomic creates the folder, so the store still creates nothing until the first save.
    await writeFileAtomic(join(this.dir, `${theme.id}${SUFFIX}`), `${JSON.stringify(theme, null, 2)}\n`);
    this.#themes = [...this.#themes.filter((existing) => existing.id !== theme.id), theme];
    for (const listener of this.#listeners) listener(this.#themes);
  }

  onChange(listener: (themes: readonly ThemeDefinition[]) => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }
}
