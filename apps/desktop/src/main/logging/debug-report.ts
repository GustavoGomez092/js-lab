import { defaultSettings, SETTINGS_SECTIONS, type Settings } from "@jslab/shared";
import type { Redactor } from "./redact";

export interface DebugReportInput {
  versions: { app: string; bun: string; electrobun: string };
  os: { macOS: string; arch: string };
  settings: Settings;
  logLines: string[];
  redact: Redactor;
  /** The user's home folder. Every occurrence in the report is written as `~` (FA-m12). */
  home: string;
}

const USERS_PREFIX = /\/Users\/[^/\s"',}\]]+/g;

/** Writes the home folder, and any other `/Users/<name>` prefix, as `~` (FA-m12). */
export function redactHomePaths(text: string, home: string): string {
  const withoutHome = home.length > 1 ? text.split(home).join("~") : text;
  return withoutHome.replace(USERS_PREFIX, "~");
}

/**
 * The settings part of the report (FA-m12): only the fields the schema defines, so keys a hand edit added never leave
 * the machine, and every string field goes through `text`. `.npmrc` content and env.json values are not settings and
 * never appear here.
 */
export function redactSettings(settings: Settings, text: (value: string) => string): Record<string, unknown> {
  const defaults = defaultSettings() as unknown as Record<string, Record<string, unknown>>;
  const current = settings as unknown as Record<string, Record<string, unknown> | undefined>;
  const out: Record<string, unknown> = { version: settings.version };
  for (const section of SETTINGS_SECTIONS) {
    const known = defaults[section] ?? {};
    const values = current[section] ?? {};
    const kept: Record<string, unknown> = {};
    for (const key of Object.keys(known)) {
      const value = values[key];
      kept[key] = typeof value === "string" ? text(value) : value;
    }
    out[section] = kept;
  }
  return out;
}

/**
 * Help → Copy Debug Log (spec §20). Redaction runs on each free-text field BEFORE JSON.stringify, not on the finished
 * JSON text: a pattern that eats trailing characters (I-1) could otherwise consume the quote, comma or brace that
 * JSON.stringify placed around it and corrupt the report.
 */
export function buildDebugReport(input: DebugReportInput): string {
  const text = (value: string) => redactHomePaths(input.redact(value), input.home);
  return JSON.stringify(
    {
      version: input.versions.app,
      bunVersion: input.versions.bun,
      electrobunVersion: input.versions.electrobun,
      macOS: input.os.macOS,
      arch: input.os.arch,
      settings: redactSettings(input.settings, text),
      log: input.logLines.slice(-500).map(text),
    },
    null,
    2,
  );
}
