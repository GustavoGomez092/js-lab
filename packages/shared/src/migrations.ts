import { SETTINGS_VERSION, type Settings, settingsSchema } from "./settings";

type RawSettings = Record<string, unknown>;

function isObject(value: unknown): value is RawSettings {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** `SETTINGS_MIGRATIONS[n]` upgrades a version-n file to version n + 1. Unknown keys always pass through. */
export const SETTINGS_MIGRATIONS: Record<number, (raw: RawSettings) => RawSettings> = {
  // v1 (M1) → v2 (M2): M1 had no theme picker, so a stored "dracula" is always the untouched M1 default.
  // Move it to Graphite, the M2 default. Every new section is filled by the schema's defaults.
  1: (raw) => {
    const next: RawSettings = { ...raw, version: 2 };
    if (isObject(raw.appearance) && raw.appearance.theme === "dracula") {
      next.appearance = { ...raw.appearance, theme: "graphite" };
    }
    return next;
  },
  // v2 (M2) → v3 (M3): the npm and build sections are filled by the schema's defaults; every v2 value is kept.
  2: (raw) => ({ ...raw, version: 3 }),
  // v3 (M3) → v4 (M5, AI chat): the `ai` section is filled by the schema's defaults, so an existing settings.json
  // gains `provider: "none"` and `includeOutput: true` without the user losing anything. This entry is not
  // optional bookkeeping: `migrateSettings` THROWS on a version with no migration, so bumping SETTINGS_VERSION
  // without it makes every existing settings.json unreadable -- which `loadJson` then treats as corrupt and
  // replaces with defaults, silently resetting every setting the user had.
  3: (raw) => ({ ...raw, version: 4 }),
};

export function migrateSettings(input: unknown): unknown {
  if (!isObject(input)) return input;
  let raw = input;
  let version = typeof raw.version === "number" && Number.isInteger(raw.version) ? raw.version : 1;
  while (version < SETTINGS_VERSION) {
    const migrate = SETTINGS_MIGRATIONS[version];
    if (!migrate) throw new Error(`No settings migration from version ${version}`);
    raw = migrate(raw);
    version += 1;
  }
  return raw;
}

export function parseSettings(input: unknown): Settings {
  return settingsSchema.parse(migrateSettings(input));
}

/** Parser for `loadJson`: throws on a non-object so recovery falls back to settings.json.bak, then defaults. */
export const settingsParser = {
  parse(input: unknown): Settings {
    if (!isObject(input)) throw new Error("settings.json must contain an object");
    return parseSettings(input);
  },
};
